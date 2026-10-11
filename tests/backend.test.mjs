import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const bundle=readFileSync(new URL('../dist/backend.js',import.meta.url),'utf8');
const config={voices:[{id:'Charon'},{id:'Kore'}],fixed:[{speaker:'Narrator',voice:'Charon',style:''}],npcs:[],useStyle:true};
test('Jev proxy options are clone-safe and cancellation discards a late response',async()=>{
  let release,options;
  const h=await harness(()=>{throw Error('No LLM fallback');},async(url,input)=>{
    options=input;assert.ok(!('signal' in input));structuredClone(input);
    return new Promise(resolve=>release=resolve);
  });
  h.send('planJev',{transcript:'"Hello."',apiKey:'jev-secret',config:{...config,useStyle:false}});
  await new Promise(resolve=>setTimeout(resolve,0));assert.ok(options);
  h.send('cancel',{});release({status:200,body:JSON.stringify({choices:['Narrator']})});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.sent.filter(item=>item.message.result || item.message.error).length,0);
});

test('Jev errors stop by default and never bill the LLM',async()=>{
  let calls=0;
  const h=await harness(async()=>{calls++;throw Error('Unexpected LLM');},async()=>{throw Error('The object cannot be cloned');});
  h.send('plan',{transcript:'"Hello."',config:{...config,useJev:true,jevApiKey:'secret'}});
  assert.match((await h.result()).message.error,/Jev classification failed: The object cannot be cloned/);
  assert.equal(calls,0);
  const missing=await harness(async()=>{calls++;});
  missing.send('plan',{transcript:'"Hello."',config:{...config,useJev:true}});
  assert.match((await missing.result()).message.error,/Jev API key/);assert.equal(calls,0);
});

test('an opted-in failed LLM fallback retains both provider errors',async()=>{
  const h=await harness(async()=>{throw Error('LLM quota exceeded');},async()=>({status:429,body:'Jev quota exhausted'}));
  h.send('plan',{transcript:'"Hello."',config:{...config,useJev:true,jevApiKey:'secret',allowLlmFallback:true}});
  const error=(await h.result()).message.error;
  assert.match(error,/Jev classification HTTP 429: Jev quota exhausted/);assert.match(error,/LLM quota exceeded/);
});

test('unknown or missing Jev classifications fail rather than attributing to the first character',async()=>{
  for(const choices of [[],['Unknown']]){
    const h=await harness(null,async()=>({status:200,body:JSON.stringify({choices})}));
    h.send('planJev',{transcript:'"Hello."',apiKey:'secret',config});
    assert.match((await h.result()).message.error,/incomplete or unknown/);
  }
});

test('TTS failures never silently switch a custom voice',async()=>{
  let calls=0;
  const h=await harness(null,async()=>{calls++;return {status:404,body:'Voice not found'};});
  h.send('gemini',{apiKey:'secret',model:'gemini-3.8-flash-tts',segment:{text:'Hello.',voice:'voice_missing',style:''}});
  assert.match((await h.result()).message.error,/HTTP 404/);assert.equal(calls,1);
});
test('streaming planner reports activity, keeps reasoning private and uses completed JSON',async()=>{
  let limit,request;
  const content='{"segments":[{"speaker":"Narrator","unit_ids":[0]}]}';
  const h=await harness(()=>{throw new Error('Expected streaming');},null,'custom',(_,ms)=>limit=ms,async function*(input){
    request=input;
    yield {type:'reasoning',token:'private processing text'};
    yield {type:'token',token:content.slice(0,20)};
    yield {type:'done',content,finish_reason:'stop'};
  });
  h.send('plan',{transcript:'Hello.',config,context:'x'.repeat(16000)});
  const result=await h.result();
  assert.equal(result.message.result.segments[0].text,'Hello.');assert.equal(limit,600000);
  assert.ok(h.sent.some(item=>/Planner is processing/.test(item.message.progress?.stage || '')));
  assert.ok(!JSON.stringify(h.sent).includes('private processing text'));
  assert.ok(!JSON.stringify(request.messages).includes('x'.repeat(4001)));
});
test('an incomplete stream is never accepted as a finished speech plan',async()=>{
  const h=await harness(null,null,'custom',null,async function*(){yield {type:'token',token:'{"segments":[]}'};});
  h.send('plan',{transcript:'Hello.',config});
  assert.match((await h.result()).message.error,/stream ended before completion/);
});
async function harness(generate, cors, provider, deadline, stream) {
  let handler;const sent=[];let wake;
  const connection={id:'llm-a',is_default:true,model:'gemini-flash-text',provider};
  vm.runInNewContext(bundle,{spindle:{onFrontendMessage:h=>handler=h,sendToFrontend:(message,user,options)=>{sent.push({message,user,options});if(message.result || message.error)wake?.();},generate:{raw:generate,rawStream:stream},connections:{get:async()=>connection,list:async()=>[connection]},cors},
    console,Map,Set,AbortController,setTimeout:deadline?(fn,ms)=>{deadline(fn,ms);return 0;}:setTimeout,clearTimeout,URL,crypto:globalThis.crypto,atob,Uint8Array,DataView,fetch:globalThis.fetch});
  return {sent,send:(action,input,id='request')=>handler({namespace:'choir',action,input,id},'user-a','session-a'),
    result:()=>sent.some(item=>item.message.result || item.message.error)?Promise.resolve(sent.findLast(item=>item.message.result || item.message.error)):new Promise(resolve=>{wake=()=>resolve(sent.at(-1));})};
}
test('planner uses user identity and routes replies only to the originating browser session',async()=>{
  let request;
  const h=await harness(async input=>{request=input;return {content:JSON.stringify({segments:[{speaker:'Narrator',unit_ids:[0]}]})};});
  h.send('plan',{transcript:'Hello.',config,context:'data'});
  const result=await h.result();
  assert.equal(request.userId,'user-a');assert.equal(result.user,'user-a');assert.equal(result.options.frontendSessionId,'session-a');
  assert.equal(request.type,'raw');assert.equal(request.parameters.max_tokens,8192);assert.equal(request.reasoning.source,'off');assert.equal(request.connection_id,'llm-a');
  assert.equal(result.message.result.segments[0].voice,'Charon');
});
test('retries a malformed plan once and surfaces failure instead of speaking altered text',async()=>{
  let calls=0;const h=await harness(async()=>{calls++;return {content:'{"segments":[{"speaker":"Narrator","text":"Wrong."}]}'};});
  h.send('plan',{transcript:'Hello.',config});
  const result=await h.result();assert.equal(calls,2);assert.match(result.message.error,/Planner failed twice/);
});
test('Gemini request uses header authentication and speech metadata',async()=>{
  let request;
  const h=await harness(null,async(url,options)=>{request={url,options};return {status:200,body:JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:'YQ==',mimeType:'audio/wav'}}]}}]})};});
  h.send('gemini',{apiKey:'secret-test',model:'gemini-3.8-flash-tts',segment:{text:'Hello.',voice:'Kore',style:'Soft'}});
  const result=await h.result();assert.equal(result.message.result.base64,'YQ==');
  assert.ok(!request.url.includes('secret-test'));assert.equal(request.options.headers['x-goog-api-key'],'secret-test');
  assert.equal(JSON.parse(request.options.body).contents[0].parts[0].speech_metadata.style,'Soft');
});
test('cancellation aborts planner and suppresses stale replies',async()=>{
  let resolve;let signal;
  const h=await harness(input=>{signal=input.signal;return new Promise(r=>resolve=r);});
  h.send('plan',{transcript:'Hello.',config});await new Promise(r=>setTimeout(r,0));h.send('cancel',{});
  assert.ok(signal.aborted);resolve({content:'{"segments":[{"speaker":"Narrator","unit_ids":[0]}]}'});
  await new Promise(r=>setTimeout(r,10));assert.equal(h.sent.filter(item=>item.message.result || item.message.error).length,0);
});

test('truncated JSON retries with a larger output budget and accepts only a complete plan',async()=>{
  const budgets=[];
  const h=await harness(async input=>{
    budgets.push(input.parameters.max_tokens);
    return budgets.length===1 ? {content:'{"segments":[',finish_reason:'length'}
      : {content:'{"segments":[{"speaker":"Narrator","unit_ids":[0]}]}',finish_reason:'stop'};
  });
  h.send('plan',{transcript:'Hello.',config});
  const result=await h.result();assert.deepEqual(budgets,[8192,16384]);assert.equal(result.message.result.segments[0].text,'Hello.');
});

test('empty planner responses produce an actionable error',async()=>{
  const h=await harness(async()=>({content:'',finish_reason:'stop'}));
  h.send('plan',{transcript:'Hello.',config});const result=await h.result();
  assert.match(result.message.error,/Planner returned no text/);
});

test('backend readiness check replies without making an LLM or TTS request',async()=>{
  const h=await harness(()=>{throw new Error('Should not call planner');},()=>{throw new Error('Should not call TTS');});
  h.send('ping',{});
  const result=await h.result();assert.equal(result.message.result.ready,true);assert.equal(result.message.result.version,'1.1.0');
});

test('prose-only planner responses expose a useful diagnostic after retry',async()=>{
  const h=await harness(async()=>({content:'I cannot process this request.'}));
  h.send('plan',{transcript:'Hello.',config});
  assert.match((await h.result()).message.error,/Response begins: I cannot process/);
});

test('known planners request provider JSON mode; other providers retain portable prompting',async()=>{
  for(const provider of ['google','openai','anthropic']) {
    let parameters;
    const h=await harness(async input=>{parameters=input.parameters;return {content:'{"segments":[{"speaker":"Narrator","unit_ids":[0]}]}'};},null,provider);
    h.send('plan',{transcript:'Hello.',config});
    assert.ok((await h.result()).message.result);
    if(provider==='google')assert.equal(parameters.responseMimeType,'application/json');
    if(provider==='openai')assert.equal(parameters.response_format.type,'json_object');
    if(provider==='anthropic')assert.deepEqual(Object.keys(parameters),['max_tokens']);
  }
});

test('planner test sends a small independent request and reports the exact model',async()=>{
  let request;
  const h=await harness(async input=>{request=input;return {content:'READY'};},null,'openai');
  h.send('testPlanner',{connectionId:'llm-a'});
  const result=await h.result();
  assert.equal(result.message.result.model,'gemini-flash-text');assert.equal(result.message.result.provider,'openai');
  assert.equal(request.parameters.max_tokens,64);assert.equal(request.connection_id,'llm-a');
  assert.ok(h.sent.some(item=>item.message.progress?.model==='gemini-flash-text'));
  assert.ok(!request.messages[0].content.includes('transcript'));
});

test('a stalled planner test reports its model and cancels generation at the deadline',async()=>{
  let expire,limit,signal;
  const h=await harness(input=>{signal=input.signal;return new Promise(()=>{});},null,'openai',(fn,ms)=>{expire=fn;limit=ms;});
  h.send('testPlanner',{connectionId:'llm-a'});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(limit,60000);expire();
  const result=await h.result();assert.match(result.message.error,/Waiting for a short LLM test response/);
  assert.match(result.message.error,/gemini-flash-text/);assert.ok(signal.aborted);
});

test('designVoice creates a custom Gemini voice from a natural language prompt',async()=>{
  let request;
  const h=await harness(null,async(url,options)=>{
    request={url,options};
    return {status:200,body:JSON.stringify({name:'voices/voice_test_123',voice:{id:'voice_test_123'}})};
  });
  h.send('designVoice',{apiKey:'key-test',prompt:'Gruff dwarf blacksmith'});
  const result=await h.result();
  assert.equal(result.message.result.id,'voice_test_123');
  assert.equal(result.message.result.description,'Gruff dwarf blacksmith');
  assert.equal(request.url,'https://generativelanguage.googleapis.com/v1beta/voices');
  assert.equal(request.options.headers['x-goog-api-key'],'key-test');
  assert.deepEqual(JSON.parse(request.options.body),{type:'prompted',prompt:'Gruff dwarf blacksmith',store:true});
});

test('designVoice handles missing API key or empty prompt',async()=>{
  const h=await harness();
  h.send('designVoice',{apiKey:'',prompt:'Gruff dwarf'});
  assert.match((await h.result()).message.error,/Enter a Gemini API key/);

  const h2=await harness();
  h2.send('designVoice',{apiKey:'key',prompt:''});
  assert.match((await h2.result()).message.error,/Describe the voice to design/);
});

test('explicit custom voice fallback retries once on 404',async()=>{
  const calls=[];
  const h=await harness(null,async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body)});
    if(calls.length===1) {
      return {status:404,body:JSON.stringify({error:{message:'Voice voices/voice_dwarf_abc not found',status:'NOT_FOUND'}})};
    }
    return {status:200,body:JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:'ZmFsbGJhY2s=',mimeType:'audio/wav'}}]}}]})};
  });
  h.send('gemini',{
    apiKey:'test-key',
    model:'gemini-3.8-flash-tts',
    allowVoiceFallback:true,
    segment:{text:'Halt!',voice:'voice_dwarf_abc',gender:'male',style:'Stern'}
  });
  const result=await h.result();
  assert.equal(result.message.result.base64,'ZmFsbGJhY2s=');
  assert.equal(calls.length,2);
  assert.equal(calls[0].body.generationConfig.speechConfig.voiceConfig.voice,'voice_dwarf_abc');
  assert.equal(calls[1].body.generationConfig.speechConfig.voiceConfig.voice,'Charon');

  // Test female voice falling back to Kore
  const femaleCalls=[];
  const h2=await harness(null,async(url,options)=>{
    femaleCalls.push({url,options,body:JSON.parse(options.body)});
    if(femaleCalls.length===1) {
      return {status:404,body:JSON.stringify({error:{message:'Voice not found'}})};
    }
    return {status:200,body:JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:'a29yZQ==',mimeType:'audio/wav'}}]}}]})};
  });
  h2.send('gemini',{
    apiKey:'test-key',
    model:'gemini-3.8-flash-tts',
    allowVoiceFallback:true,
    segment:{text:'Greetings.',voice:'voice_female_elf',gender:'female',style:'Gentle'}
  });
  const result2=await h2.result();
  assert.equal(result2.message.result.base64,'a29yZQ==');
  assert.equal(femaleCalls.length,2);
  assert.equal(femaleCalls[0].body.generationConfig.speechConfig.voiceConfig.voice,'voice_female_elf');
  assert.equal(femaleCalls[1].body.generationConfig.speechConfig.voiceConfig.voice,'Kore');
});

test('fishaudio synthesizes speech with Authorization header and emotion tag formatting', async () => {
  let request;
  const h = await harness(null, async (url, options) => {
    request = { url, options };
    return { status: 200, body: 'bXAzLWF1ZGlv' };
  });
  h.send('fishaudio', {
    apiKey: 'fish-secret-123',
    model: 's2.1-pro',
    segment: { text: 'Watch out!', voice: 'voice-ref-456', style: 'shouting in alarm' }
  });
  const result = await h.result();
  assert.equal(result.message.result.base64, 'bXAzLWF1ZGlv');
  assert.equal(result.message.result.mimeType, 'audio/mpeg');
  assert.equal(request.url, 'https://api.fish.audio/v1/tts');
  assert.equal(request.options.headers.Authorization, 'Bearer fish-secret-123');
  assert.equal(request.options.headers.model, 's2.1-pro');
  const body = JSON.parse(request.options.body);
  assert.equal(body.text, '[shouting in alarm] Watch out!');
  assert.equal(body.reference_id, 'voice-ref-456');
  assert.equal(body.format, 'mp3');
});

test('fishaudio handles missing API key or empty segment', async () => {
  const h = await harness();
  h.send('fishaudio', { apiKey: '', segment: { text: 'Hello.' } });
  assert.match((await h.result()).message.error, /Enter a Fish Audio API key/);

  const h2 = await harness();
  h2.send('fishaudio', { apiKey: 'key', segment: { text: '' } });
  assert.match((await h2.result()).message.error, /Invalid speech chunk/);
});

test('searchVoices searches community voice models and parses items', async () => {
  let request;
  const h = await harness(null, async (url, options) => {
    request = { url, options };
    return {
      status: 200,
      body: JSON.stringify({
        items: [
          { _id: '0f1de066bb6c4d03933aad3d0169cd0f', title: 'Natsuki', description: 'Cute tsundere voice' },
          { _id: 'a6e0107fbef440cdb955646fb58cfe5a', title: 'Natsuki Subaru', description: 'Confident isekai guy' }
        ]
      })
    };
  });
  h.send('searchVoices', { query: 'natsuki', limit: 5 });
  const result = await h.result();
  assert.equal(result.message.result.query, 'natsuki');
  assert.equal(result.message.result.results.length, 2);
  assert.equal(result.message.result.results[0].name, 'Natsuki');
  assert.equal(result.message.result.results[0].id, '0f1de066bb6c4d03933aad3d0169cd0f');
  assert.match(request.url, /api\.fish\.audio\/model\?title=natsuki/);
});

test('searchVoices handles empty query or network failure', async () => {
  const h = await harness();
  h.send('searchVoices', { query: '' });
  assert.match((await h.result()).message.error, /Enter a character or voice name/);

  const h2 = await harness(null, async () => ({ status: 500, body: 'Internal error' }));
  h2.send('searchVoices', { query: 'glados' });
  assert.match((await h2.result()).message.error, /Voice search HTTP 500/);
});


import { classifyWithJev, planWithJev } from '../src/backend.js';

test('classifyWithJev calls API with proper payload, auth header and choices, returning candidate strings', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: ['Alice', 'Bob'] })
      };
    };
    const items = [
      { text: '"Hello"', context: 'Alice said' },
      { text: '"Hi there"', context: 'Bob replied' }
    ];
    const candidates = ['Alice', 'Bob', 'Charlie'];
    const result = await classifyWithJev({
      items,
      candidates,
      apiKey: 'test-jev-key'
    });
    assert.deepEqual(result, ['Alice', 'Bob']);
    assert.equal(request.url, 'https://api.typesafe.ai/v1/classify');
    assert.equal(request.options.headers.Authorization, 'Bearer test-jev-key');
    assert.deepEqual(request.body, {
      inputs: [
        { text: '"Hello"', context: 'Alice said' },
        { text: '"Hi there"', context: 'Bob replied' }
      ],
      choices: ['Alice', 'Bob', 'Charlie']
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyWithJev supports custom endpoint and handles various API response formats', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ classifications: [{ choice: 'Guard' }] })
      };
    };
    const result = await classifyWithJev({
      items: [{ text: '"Halt!"' }],
      candidates: ['Guard'],
      apiKey: 'Bearer existing-token',
      endpoint: 'https://custom.api.endpoint/v1/classify'
    });
    assert.deepEqual(result, ['Guard']);
    assert.equal(request.url, 'https://custom.api.endpoint/v1/classify');
    assert.equal(request.options.headers.Authorization, 'Bearer existing-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyWithJev validates required apiKey, choices, and handles network failure', async () => {
  await assert.rejects(
    () => classifyWithJev({ items: [{ text: '"test"' }], candidates: ['Alice'], apiKey: '' }),
    /Enter a Jev API key/
  );
  await assert.rejects(
    () => classifyWithJev({ items: [{ text: '"test"' }], candidates: [], apiKey: 'key' }),
    /Provide at least one candidate choice/
  );
  const emptyRes = await classifyWithJev({ items: [], candidates: ['Alice'], apiKey: 'key' });
  assert.deepEqual(emptyRes, []);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid API key' } })
    });
    await assert.rejects(
      () => classifyWithJev({ items: [{ text: '"test"' }], candidates: ['Alice'], apiKey: 'bad-key' }),
      /Jev classification failed: Jev classification HTTP 401: Invalid API key/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('planWithJev classifies dialogue speakers and emotion tags into valid speech plan segments', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: ['Alice', 'Bob'] })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: ['cheerful', 'whispering'] })
      };
    };

    const jevConfig = {
      voices: [{ id: 'Charon' }, { id: 'Kore' }],
      fixed: [
        { speaker: 'Narrator', voice: 'Charon', style: '' },
        { speaker: 'Persona', voice: 'Charon', style: '' },
        { speaker: 'Alice', voice: 'Kore', style: '' }
      ],
      npcs: [{ speaker: 'Bob', voice: 'Charon', style: '' }],
      useStyle: true
    };
    const transcript = 'The room fell quiet. "Good morning!" said Alice. "Keep your voice down," Bob whispered.';
    const plan = await planWithJev({
      transcript,
      config: jevConfig,
      apiKey: 'jev-secret-test'
    });

    assert.ok(plan.segments);
    assert.equal(calls.length, 2);
    // Persona must be excluded from candidate choices
    assert.deepEqual(calls[0].body.choices, ['Alice', 'Bob']);
    assert.deepEqual(calls[1].body.choices, ['neutral', 'cheerful', 'whispering', 'angry', 'sad', 'sigh']);

    // Check segments attribution and emotion styles
    const aliceSeg = plan.segments.find(s => s.text === '"Good morning!"');
    assert.ok(aliceSeg, 'Alice dialogue segment found');
    assert.equal(aliceSeg.speaker, 'Alice');
    assert.equal(aliceSeg.voice, 'Kore');
    assert.equal(aliceSeg.style, 'cheerful');

    const bobSeg = plan.segments.find(s => s.text === '"Keep your voice down,"');
    assert.ok(bobSeg, 'Bob dialogue segment found');
    assert.equal(bobSeg.speaker, 'Bob');
    assert.equal(bobSeg.voice, 'Charon');
    assert.equal(bobSeg.style, 'whispering');

    // Narration segments
    const narrSeg = plan.segments.find(s => s.text === 'The room fell quiet.');
    assert.ok(narrSeg, 'Narrator segment found');
    assert.equal(narrSeg.speaker, 'Narrator');
    assert.equal(narrSeg.voice, 'Charon');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('planWithJev handles pure narration without making classification calls', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  try {
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('Should not be called');
    };
    const transcript = 'The sun set over the distant mountains. All was calm and peaceful.';
    const plan = await planWithJev({
      transcript,
      config,
      apiKey: 'jev-key'
    });
    assert.equal(fetchCalled, false);
    assert.equal(plan.segments.length, 1);
    assert.equal(plan.segments[0].speaker, 'Narrator');
    assert.equal(plan.segments[0].text, transcript);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('backend RPC handler supports action planJev and planWithJev', async () => {
  const calls = [];
  const corsHandler = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      status: 200,
      body: JSON.stringify({ choices: calls.length % 2 === 1 ? ['Hero'] : ['sigh'] })
    };
  };

  const jevConfig = {
    voices: [{ id: 'Charon' }, { id: 'Kore' }],
    fixed: [
      { speaker: 'Narrator', voice: 'Charon', style: '' },
      { speaker: 'Hero', voice: 'Kore', style: '' }
    ],
    npcs: [],
    useStyle: true
  };

  const h = await harness(null, corsHandler);
  h.send('planJev', {
    transcript: 'He looked back. "Farewell," sighed Hero.',
    config: jevConfig,
    apiKey: 'rpc-jev-key'
  });
  const res = await h.result();
  assert.ok(res.message.result);
  const heroSeg = res.message.result.segments.find(s => s.text === '"Farewell,"');
  assert.equal(heroSeg.speaker, 'Hero');
  assert.equal(heroSeg.style, 'sigh');

  // Test action alias planWithJev
  const h2 = await harness(null, corsHandler);
  h2.send('planWithJev', {
    transcript: 'He looked back. "Farewell," sighed Hero.',
    config: jevConfig,
    apiKey: 'rpc-jev-key'
  });
  const res2 = await h2.result();
  assert.ok(res2.message.result);
});

test('action plan attempts Jev when useJev and jevApiKey are configured, succeeding without LLM', async () => {
  let llmCalled = false;
  const generate = async () => {
    llmCalled = true;
    return { content: '{"segments":[]}' };
  };
  const corsHandler = async (url, options) => {
    return {
      status: 200,
      body: JSON.stringify({ choices: ['Hero'] })
    };
  };
  const jevConfig = {
    voices: [{ id: 'Charon' }, { id: 'Kore' }],
    fixed: [
      { speaker: 'Narrator', voice: 'Charon', style: '' },
      { speaker: 'Hero', voice: 'Kore', style: '' }
    ],
    npcs: [],
    useStyle: true,
    useJev: true,
    jevApiKey: 'auto-jev-key'
  };

  const h = await harness(generate, corsHandler);
  h.send('plan', {
    transcript: '"I am ready," said Hero.',
    config: jevConfig
  });
  const res = await h.result();
  assert.ok(res.message.result);
  assert.equal(llmCalled, false, 'LLM should not be called when Jev succeeds');
  const heroSeg = res.message.result.segments.find(s => s.text === '"I am ready,"');
  assert.equal(heroSeg.speaker, 'Hero');
});

test('action plan uses explicitly enabled LLM fallback and retains the Jev diagnostic', async () => {
  let llmCalled = false;
  const generate = async () => {
    llmCalled = true;
    return { content: JSON.stringify({ segments: [{ speaker: 'Narrator', unit_ids: [0, 1] }] }) };
  };
  const corsHandler = async () => {
    return { status: 500, body: JSON.stringify({ error: { message: 'Jev service unavailable' } }) };
  };
  const jevConfig = {
    voices: [{ id: 'Charon' }],
    fixed: [{ speaker: 'Narrator', voice: 'Charon', style: '' }],
    npcs: [],
    useStyle: true,
    useJev: true,
    jevApiKey: 'failing-jev-key',
    allowLlmFallback:true
  };

  const h = await harness(generate, corsHandler);
  h.send('plan', {
    transcript: '"Hello," whispered a voice.',
    config: jevConfig
  });
  const res = await h.result();
  assert.ok(res.message.result);
  assert.match(res.message.result.warning,/Jev service unavailable/);
  assert.equal(llmCalled, true, 'LLM planner should be invoked as fallback');
});

test('testPlanner tests Jev when plannerMode is jev', async () => {
  let request;
  const h = await harness(null, async (url, options) => {
    request = { url, options };
    return { status: 200, body: JSON.stringify({ choices: ['Alice'] }) };
  });
  h.send('testPlanner', { plannerMode: 'jev', jevApiKey: 'test-jev-key' });
  const result = await h.result();
  assert.equal(result.message.result.provider, 'TypeSafe AI');
  assert.equal(result.message.result.model, 'Jev System 1');
  assert.match(result.message.result.response, /READY/);
  assert.equal(request.options.headers.Authorization, 'Bearer test-jev-key');
});
