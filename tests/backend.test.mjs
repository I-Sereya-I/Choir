import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const bundle=readFileSync(new URL('../dist/backend.js',import.meta.url),'utf8');
const config={voices:[{id:'Charon'},{id:'Kore'}],fixed:[{speaker:'Narrator',voice:'Charon',style:''}],npcs:[],useStyle:true};
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
    console,Map,Set,AbortController,setTimeout:deadline?(fn,ms)=>{deadline(fn,ms);return 0;}:setTimeout,clearTimeout,URL,crypto:globalThis.crypto,atob,Uint8Array,DataView});
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
  const result=await h.result();assert.equal(result.message.result.ready,true);assert.equal(result.message.result.version,'1.0.18');
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

test('backend retry fallback when custom voice_ returns 404',async()=>{
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
