import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const bundle=readFileSync(new URL('../dist/backend.js',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../spindle.json',import.meta.url),'utf8'));
const config={voices:[{id:'Charon'},{id:'Kore'}],fixed:[{speaker:'Narrator',voice:'Charon',style:''}],npcs:[],useStyle:true};
const castConfig={...config,fixed:[...config.fixed,{speaker:'Mira',voice:'Kore',style:''}]};
test('Gemini accepts speech beyond the old 2000-character cap when it fits the input budget',async()=>{
  let calls=0;const h=await harness(null,async(url,options)=>{calls++;assert.equal(JSON.parse(options.body).contents[0].parts[0].text.length,3000);return {status:200,body:JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:'YQ==',mimeType:'audio/wav'}}]}}]})};});
  h.send('gemini',{apiKey:'test-key',model:'gemini-3.8-flash-tts',segment:{text:'x'.repeat(3000),voice:'Kore',style:'Warm'}});
  assert.equal((await h.result()).message.result.base64,'YQ==');assert.equal(calls,1);
});

test('oversized Gemini text or multilingual input is rejected before making a provider request',async()=>{
  for(const text of ['x'.repeat(6001),'你'.repeat(2001)]){
    let calls=0;const h=await harness(null,async()=>{calls++;throw Error('Unexpected request');});
    h.send('gemini',{apiKey:'test-key',model:'gemini-3.8-flash-tts',segment:{text,voice:'Kore',style:''}});
    assert.match((await h.result()).message.error,/safe input budget/);assert.equal(calls,0);
  }
});
test('Jev proxy options are clone-safe and cancellation discards a late response',async()=>{
  let release,options;
  const h=await harness(()=>{throw Error('No LLM fallback');},async(url,input)=>{
    options=input;assert.ok(!('signal' in input));structuredClone(input);
    return new Promise(resolve=>release=resolve);
  });
  h.send('planJev',{transcript:'"Hello."',apiKey:'jev-secret',config:{...castConfig,useStyle:false}});
  await new Promise(resolve=>setTimeout(resolve,0));assert.ok(options);
  h.send('cancel',{});release({status:200,body:JSON.stringify({answers:{q0:{choice:'Narrator'}}})});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.sent.filter(item=>item.message.result || item.message.error).length,0);
});

test('Freesound keeps AbortSignal local and ignores a proxy result after cancellation',async()=>{
 let release,options;
 const h=await harness(null,async(url,input)=>{
  assert.match(url,/freesound.org/);assert.ok(!('signal' in input));structuredClone(input);options=input;
  return new Promise(resolve=>release=resolve);
 });
 h.send('freesound',{apiKey:'test-freesound-key',query:'door'});
 await new Promise(resolve=>setTimeout(resolve,0));assert.ok(options);
 h.send('cancel',{});release({status:200,body:JSON.stringify({results:[{id:1,previews:{'preview-hq-mp3':'https://freesound.test/door.mp3'}}]})});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(h.sent.filter(item=>item.message.result || item.message.error).length,0);
});

test('Freesound uses the current search endpoint, authenticates in a header and reports service errors',async()=>{
 const h=await harness(null,async(url,options)=>{
  const search=new URL(url);assert.equal(search.pathname,'/apiv2/search/');assert.equal(search.searchParams.get('query'),'page turn');assert.equal(search.searchParams.get('filter'),'duration:[0.1 TO 2.5]');assert.equal(search.searchParams.has('token'),false);
  assert.equal(options.headers.Authorization,'Token test-freesound-key');assert.ok(!('signal' in options));structuredClone(options);
  return {status:200,body:JSON.stringify({results:[{id:123,name:'Page turn',duration:0.8,previews:{'preview-hq-mp3':'https://freesound.test/high.mp3','preview-lq-mp3':'https://freesound.test/low.mp3'}}]})};
 });
 h.send('freesound',{apiKey:'test-freesound-key',query:'page turn'});assert.equal((await h.result()).message.result.results[0].previewUrl,'https://freesound.test/high.mp3');
 const denied=await harness(null,async()=>({status:401,body:'Unauthorized'}));denied.send('freesound',{apiKey:'invalid-key',query:'page turn'});assert.match((await denied.result()).message.error,/Freesound HTTP 401/);
});

const sounds=[
  {id:1,name:'Glass Smash, Bottle',duration:1.24,tags:['glass','smash','bottle','break','shatter','impact','debris','crash','extra'],previews:{'preview-hq-mp3':'https://freesound.test/smash.mp3'}},
  {id:2,name:'Bottle pick up',duration:0.8,tags:['bottle','glass','pickup'],previews:{'preview-hq-mp3':'https://freesound.test/pickup.mp3'}},
  {id:3,name:'Bottle clink',duration:0.5,tags:['bottle'],previews:{'preview-hq-mp3':'https://freesound.test/clink.mp3'}}];
const moment='She reached for the glass bottle on the shelf and lifted it.';
const search=async url=>{assert.equal(new URL(url).searchParams.get('page_size'),'8');return {status:200,body:JSON.stringify({results:sounds})};};
const soundOrder=async h=>JSON.parse(JSON.stringify((await h.result()).message.result.results)).map(sound=>sound.id);

test('a Lumiverse Decision connection picks the Freesound clip heard in the story moment',async()=>{
  let evaluated;
  const h=await harness(null,search,null,null,null,{evaluate:async input=>{evaluated=JSON.parse(JSON.stringify(input));return {answers:{q0:{type:'choice',choice:'s1',confidence:0.95}}};}});
  h.send('freesound',{apiKey:'test-freesound-key',query:'glass bottle',moment,kind:'sfx',decisionConnection:'decision-a',jevApiKey:'unused-jev-key'});
  assert.deepEqual(await soundOrder(h),[2,1,3]);
  assert.equal(evaluated.userId,'user-a');assert.equal(evaluated.connection_id,'decision-a');assert.deepEqual(evaluated.state,{sound:'glass bottle',moment});
  assert.equal(evaluated.questions.q0.type,'choice');
  assert.equal(evaluated.questions.q0.instructions,`The story needs a short sound effect for this moment. Wanted sound: "glass bottle". Story moment: "${moment}". Which sound file best matches what is actually heard in the story moment? Reject files whose name or tags describe a different action, setting, or sound source.`);
  assert.deepEqual(evaluated.questions.q0.criteria,{s0:'Glass Smash, Bottle — tags: glass, smash, bottle, break, shatter, impact, debris, crash (1.2s)',s1:'Bottle pick up — tags: bottle, glass, pickup (0.8s)',s2:'Bottle clink — tags: bottle (0.5s)'});
});

test('without Lumiverse decisions a Jev key picks the Freesound clip through the TypeSafe Decision API',async()=>{
  const calls=[];
  const h=await harness(null,async(url,options)=>{calls.push({url,options});return url.includes('freesound.org')?search(url):{status:200,body:JSON.stringify({model:'jev-1.13.0',answers:{q0:{type:'choice',choice:'s2'}}})};});
  h.send('freesound',{apiKey:'test-freesound-key',query:'night wind',moment,kind:'ambience',jevApiKey:'jev-key',jevEndpoint:'https://api.typesafe.ai/v1/classify'});
  assert.deepEqual(await soundOrder(h),[3,1,2]);
  assert.equal(calls[1].url,'https://api.typesafe.ai/v1/systemone');assert.equal(calls[1].options.headers.Authorization,'Bearer jev-key');structuredClone(calls[1].options);
  const body=JSON.parse(calls[1].options.body);
  assert.equal(body.model,'jev-latest');assert.deepEqual(body.state,{sound:'night wind',moment});assert.deepEqual(Object.keys(body.questions.q0.criteria),['s0','s1','s2']);
  assert.match(body.questions.q0.instructions,/^The story needs a looping background ambience for this moment\. Wanted sound: "night wind"\./);
});

test('Freesound keeps its top result without a story moment or Decision model and when the choice fails or is slow',async()=>{
  const topFirst=async(input,decisions,cors=search,deadline)=>{
    const h=await harness(null,cors,null,deadline,null,decisions);
    h.send('freesound',{apiKey:'test-freesound-key',query:'glass bottle',moment,...input});assert.deepEqual(await soundOrder(h),[1,2,3]);
  };
  const urls=[];await topFirst({},undefined,url=>{urls.push(url);return search(url);});assert.equal(urls.length,1);
  let evaluations=0;await topFirst({moment:' '},{evaluate:async()=>{evaluations++;return {answers:{q0:{choice:'s1'}}};}});assert.equal(evaluations,0);
  await topFirst({},{evaluate:async()=>{throw Error('No Decision connection');}});
  await topFirst({},{evaluate:async()=>({answers:{q0:{choice:'unknown'}}})});
  await topFirst({},{evaluate:()=>new Promise(()=>{})},search,(fn,ms)=>{if(ms===5000)fn();});
  await topFirst({jevApiKey:'jev-key'},undefined,url=>url.includes('freesound.org')?search(url):{status:500,body:'Upstream error'});
});

test('Jev errors stop by default and never bill the LLM',async()=>{
  let calls=0;
  const h=await harness(async()=>{calls++;throw Error('Unexpected LLM');},async()=>{throw Error('The object cannot be cloned');});
  h.send('plan',{transcript:'"Hello."',config:{...castConfig,useJev:true,jevApiKey:'secret'}});
  assert.match((await h.result()).message.error,/Jev classification failed: The object cannot be cloned/);
  assert.equal(calls,0);
  const missing=await harness(async()=>{calls++;});
  missing.send('plan',{transcript:'"Hello."',config:{...config,useJev:true}});
  assert.match((await missing.result()).message.error,/Jev API key/);assert.equal(calls,0);
});

test('heuristic planning and testing never call the LLM, even with stale Jev flags',async()=>{
  let calls=0;const h=await harness(async()=>{calls++;throw Error('Unexpected LLM');});
  h.send('plan',{transcript:'The room fell quiet.',config:{...config,plannerMode:'heuristic',useJev:true}});
  assert.equal((await h.result()).message.result.segments[0].speaker,'Narrator');
  const probe=await harness(async()=>{calls++;throw Error('Unexpected LLM');});
  probe.send('testPlanner',{plannerMode:'heuristic',useJev:true});
  assert.equal((await probe.result()).message.result.model,'Heuristic');assert.equal(calls,0);
});

test('ambiguous heuristic planning stops without falling back to a paid connection',async()=>{
  let calls=0;const h=await harness(async()=>{calls++;throw Error('Unexpected LLM');});
  h.send('plan',{transcript:'"Hello."',config:{...config,plannerMode:'heuristic',allowLlmFallback:true}});
  assert.match((await h.result()).message.error,/No LLM request was made/);assert.equal(calls,0);
});

test('explicit LLM mode ignores stale Jev and heuristic flags',async()=>{
  let calls=0;const h=await harness(async()=>{calls++;return {content:'{"segments":[{"speaker":"Narrator","unit_ids":[0]}]}'};});
  h.send('plan',{transcript:'The room fell quiet.',config:{...config,plannerMode:'llm',useJev:true,useFastClassifier:true}});
  assert.ok((await h.result()).message.result);assert.equal(calls,1);
});

test('LLM voice selection receives character profiles and catalogue descriptions as data',async()=>{
  const profiles=[{speaker:'Narrator',description:'An older storyteller with a deep, calm voice.',personality:'Warm and patient.'}];
  const voices=[{id:'Charon',description:'Deep, mature, and calm.'},{id:'Kore',description:'Bright and youthful.'}];
  const h=await harness(async input=>{
    const data=JSON.parse(input.messages.find(message=>message.role==='user').content);
    assert.deepEqual(data.characterProfiles,profiles);assert.deepEqual(data.availableVoices,voices);assert.equal(data.fixedCast[0].voice,'');
    return {content:'{"segments":[{"speaker":"Narrator","voice":"Charon","unit_ids":[0]}]}'};
  });
  h.send('plan',{transcript:'Once upon a time.',config:{...config,voices,fixed:[{speaker:'Narrator',voice:'',style:''}],characterProfiles:profiles}});
  assert.equal((await h.result()).message.result.segments[0].voice,'Charon');
});

test('an opted-in failed LLM fallback retains both provider errors',async()=>{
  const h=await harness(async()=>{throw Error('LLM quota exceeded');},async()=>({status:429,body:'Jev quota exhausted'}));
  h.send('plan',{transcript:'"Hello."',config:{...castConfig,useJev:true,jevApiKey:'secret',allowLlmFallback:true}});
  const error=(await h.result()).message.error;
  assert.match(error,/Jev classification HTTP 429: Jev quota exhausted/);assert.match(error,/LLM quota exceeded/);
});

test('unknown or missing Jev classifications fail rather than attributing to the first character',async()=>{
  for(const choices of [[],['Unknown']]){
    const h=await harness(null,async()=>({status:200,body:JSON.stringify({choices})}));
    h.send('planJev',{transcript:'"Hello."',apiKey:'secret',config:castConfig});
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
async function harness(generate, cors, provider, deadline, stream, decisions,connectionOverrides={}) {
  let handler;const sent=[];let wake;
  const connection={id:'llm-a',is_default:true,model:'gemini-flash-text',provider,...connectionOverrides};
  vm.runInNewContext(bundle,{spindle:{onFrontendMessage:h=>handler=h,sendToFrontend:(message,user,options)=>{sent.push({message,user,options});if(message.result || message.error)wake?.();},generate:{raw:generate,rawStream:stream},connections:{get:async()=>connection,list:async()=>[connection]},cors,decisions},
    console,Map,Set,AbortController,TextEncoder,setTimeout:deadline?(fn,ms)=>{deadline(fn,ms);return 0;}:setTimeout,clearTimeout,URL,crypto:globalThis.crypto,atob,Uint8Array,DataView,fetch:globalThis.fetch});
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
  const result=await h.result();assert.equal(result.message.result.ready,true);assert.equal(result.message.result.version,manifest.version);
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

test('classifyWithJev asks the TypeSafe Decision API one choice question per item and returns candidate strings', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'jev-1.13.0', answers: { q0: { type: 'choice', choice: 'Alice', confidence: 0.9 }, q1: { type: 'choice', choice: 'Bob' } } })
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
      apiKey: 'test-jev-key',
      question: 'Which character speaks this dialogue'
    });
    assert.deepEqual(result, ['Alice', 'Bob']);
    assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.options.headers.Authorization, 'Bearer test-jev-key');
    const criteria = { Alice: 'Alice', Bob: 'Bob', Charlie: 'Charlie' };
    assert.deepEqual(request.body, {
      model: 'jev-latest',
      state: items,
      questions: {
        q0: { type: 'choice', instructions: 'Which character speaks this dialogue: ""Hello""?', criteria },
        q1: { type: 'choice', instructions: 'Which character speaks this dialogue: ""Hi there""?', criteria }
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyWithJev resolves a saved /classify endpoint to its base and rejects unknown answers', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  let answer = 'Guard';
  try {
    globalThis.fetch = async (url, options) => {
      urls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer existing-token');
      return { ok: true, status: 200, json: async () => ({ answers: { q0: { choice: answer } } }) };
    };
    for (const endpoint of ['https://custom.api.endpoint/v1/classify', 'https://custom.api.endpoint/v1']) {
      assert.deepEqual(await classifyWithJev({ items: [{ text: '"Halt!"' }], candidates: ['Guard'], apiKey: 'Bearer existing-token', endpoint }), ['Guard']);
    }
    assert.deepEqual(urls, ['https://custom.api.endpoint/v1/systemone', 'https://custom.api.endpoint/v1/systemone']);
    answer = 'Nobody';
    await assert.rejects(
      () => classifyWithJev({ items: [{ text: '"Halt!"' }], candidates: ['Guard'], apiKey: 'Bearer existing-token' }),
      /incomplete or unknown classification choices/
    );
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
      const [first, second] = calls.length === 1 ? ['Alice', 'Bob'] : ['cheerful', 'whispering'];
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { q0: { choice: first }, q1: { choice: second } } })
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
    assert.ok(calls.every(call => call.url === 'https://api.typesafe.ai/v1/systemone' && call.body.model === 'jev-latest'));
    // The persona speaks in replies too, and a speaker outside the cast has its own choice.
    assert.deepEqual(Object.keys(calls[0].body.questions.q0.criteria), ['Persona', 'Alice', 'Bob', 'Someone not listed']);
    assert.equal(calls[0].body.questions.q0.instructions, 'Which character speaks this dialogue: ""Good morning!""?');
    assert.deepEqual(Object.keys(calls[1].body.questions.q1.criteria), ['neutral', 'cheerful', 'whispering', 'angry', 'sad', 'sigh']);

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
      body: JSON.stringify({ answers: { q0: { choice: calls.length % 2 === 1 ? 'Hero' : 'sigh' } } })
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
      body: JSON.stringify({ answers: { q0: { choice: 'Hero' } } })
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
    fixed: [{ speaker: 'Narrator', voice: 'Charon', style: '' }, { speaker: 'Hero', voice: 'Charon', style: '' }],
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
    return { status: 200, body: JSON.stringify({ answers: { q0: { choice: 'Alice' } } }) };
  });
  h.send('testPlanner', { plannerMode: 'jev', jevApiKey: 'test-jev-key', jevEndpoint: 'https://api.typesafe.ai/v1/classify' });
  const result = await h.result();
  assert.equal(result.message.result.provider, 'TypeSafe AI');
  assert.equal(result.message.result.model, 'Jev System 1');
  assert.match(result.message.result.response, /READY/);
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.options.headers.Authorization, 'Bearer test-jev-key');
  assert.match(result.message.result.response, /choice: Alice/);
});


test('Jev with spindle.decisions passes userId to evaluate for operator-scoped host calls',async()=>{
  let evalInput;
  const decisions={
    evaluate:async(input)=>{
      evalInput=input;
      return {provider:'TypeSafe AI',model:'Jev System 1',answers:{speaker_0:{choice:'Alice'}}};
    }
  };
  const h=await harness(null,null,null,null,null,decisions);
  h.send('planJev',{transcript:'"Hello."',config:{...config,voices:[{id:'Charon'},{id:'Kore'}],fixed:[{speaker:'Narrator',voice:'Charon',style:''},{speaker:'Alice',voice:'Kore',style:''},{speaker:'Bob',voice:'Charon',style:''}],useStyle:false}});
  const result=await h.result();
  assert.equal(evalInput.userId,'user-a');
  assert.equal(result.message.result.segments[0].speaker,'Alice');
});

test('Jev with spindle.decisions asks about each line in place and sends the whole transcript',async()=>{
  let evalInput;
  const decisions={evaluate:async input=>{evalInput=input;return {answers:{speaker_0:{choice:'Alice'},speaker_1:{choice:'Bob'}}};}};
  const h=await harness(null,null,null,null,null,decisions);
  const transcript=`${'The room was quiet. '.repeat(250)}Alice looked up. "Robots?" Bob shrugged. "Robots."`;
  h.send('planJev',{transcript,config:{...config,voices:[{id:'Charon'},{id:'Kore'}],fixed:[{speaker:'Narrator',voice:'Charon',style:''},{speaker:'Alice',voice:'Kore',style:''},{speaker:'Bob',voice:'Charon',style:''}],useStyle:false}});
  const result=await h.result();
  assert.equal(evalInput.state.transcript,transcript);
  assert.match(evalInput.questions.speaker_0.instructions,/Alice looked up\. \[\["Robots\?"\]\] Bob shrugged/);
  assert.match(evalInput.questions.speaker_1.instructions,/Bob shrugged\. \[\["Robots\."\]\]/);
  assert.deepEqual([...result.message.result.segments.filter(s=>s.speaker!=='Narrator').map(s=>s.speaker)],['Alice','Bob']);
});

// The user's chat: a scenario card whose title fills the character slot, an unresolved "Persona" placeholder and a class of NPCs.
const scenarioCast = {
  voices: [{ id: 'narrator' }, { id: 'jay' }, { id: 'saki' }, { id: 'student-1' }, { id: 'student-2' }],
  fixed: [
    { speaker: 'Narrator', voice: 'narrator', style: '' },
    { speaker: 'Persona', voice: 'jay', style: '' },
    { speaker: 'Metamorphosis: Just the Way You Are!', voice: 'saki', style: '' }
  ],
  npcs: [{ speaker: 'Student 1', voice: 'student-1', style: '' }, { speaker: 'Student 2', voice: 'student-2', style: '', aliases: ['Kenta'] }],
  characterProfiles: [
    { speaker: 'Metamorphosis: Just the Way You Are!', name: 'Metamorphosis: Just the Way You Are!', role: 'character', description: '', personality: '', scenario: '', firstMessage: 'April 6, 2015. Among the kids celebrating, Saki stood far off to the outside.' },
    { speaker: 'Persona', name: 'Jay', role: 'persona', description: 'A Japanese young man with straight black hair.', personality: '' }
  ],
  useStyle: false
};
const scenarioTranscript = 'Jay unhooked the receiver. "Hello?" Saki flinched. "We should pack up."';

test('Jev offers the persona and a scenario card by who they are, with profiles in the state, on both Jev paths', async () => {
  const expected = {
    Persona: "Persona (also called Jay): the user's own character (persona).",
    'Metamorphosis: Just the Way You Are!': "Metamorphosis: Just the Way You Are!: the character card's main character. If this name is a story or scenario title, it is the lead character that story is about.",
    'Student 1': 'Student 1: a supporting character.',
    'Student 2': 'Student 2 (also called Kenta): a supporting character.',
    'Someone not listed': 'A speaker who matches none of the other choices, their names or descriptions.'
  };
  const checkState = characters => {
    assert.deepEqual([...characters.map(c => c.name)], ['Persona', 'Metamorphosis: Just the Way You Are!', 'Student 1', 'Student 2']);
    assert.match(characters[0].about, /straight black hair/);
    assert.match(characters[1].about, /Saki stood far off/);
  };
  let evalInput;
  const decisions = { evaluate: async input => { evalInput = input; return { answers: { speaker_0: { choice: 'Persona' }, speaker_1: { choice: 'Metamorphosis: Just the Way You Are!' } } }; } };
  const h = await harness(null, null, null, null, null, decisions);
  h.send('planJev', { transcript: scenarioTranscript, context: 'Saki: "Thanks for today."', config: scenarioCast });
  const decided = (await h.result()).message.result;
  assert.deepEqual({ ...evalInput.questions.speaker_0.criteria }, expected);
  assert.equal(evalInput.state.context, 'Saki: "Thanks for today."');
  checkState(evalInput.state.characters);
  assert.deepEqual([...decided.segments.filter(s => s.speaker !== 'Narrator').map(s => `${s.speaker}:${s.voice}`)], ['Persona:jay', 'Metamorphosis: Just the Way You Are!:saki']);

  let body;
  const direct = await harness(null, async (url, options) => {
    body = JSON.parse(options.body);
    return { status: 200, body: JSON.stringify({ answers: { q0: { choice: 'Persona' }, q1: { choice: 'Metamorphosis: Just the Way You Are!' } } }) };
  });
  direct.send('planJev', { transcript: scenarioTranscript, context: 'Saki: "Thanks for today."', apiKey: 'jev-key', config: scenarioCast });
  const classified = (await direct.result()).message.result;
  assert.deepEqual(body.questions.q0.criteria, expected);
  checkState(body.state.characters);
  assert.match(body.state.lines[1].context, /Thanks for today[\s\S]*pack up/);
  assert.deepEqual([...classified.segments.map(s => s.speaker)], [...decided.segments.map(s => s.speaker)]);
});

test('a card voicing several characters keeps its lead and its named NPCs apart', async () => {
  const cast = { voices: [{ id: 'n' }, { id: 'saki' }, { id: 'kanade' }], useStyle: false,
    fixed: [{ speaker: 'Narrator', voice: 'n', style: '' }, { speaker: 'Saki & Kanade', voice: 'saki', style: '', aliases: ['Saki'] }],
    npcs: [{ speaker: 'Kanade', voice: 'kanade', style: '', aliases: ['Kana'] }],
    characterProfiles: [{ speaker: 'Saki & Kanade', name: 'Saki & Kanade', role: 'character', description: 'Saki is shy. Her sister Kanade is loud.', personality: '' }] };
  let evalInput;
  const decisions = { evaluate: async input => { evalInput = input; return { answers: { speaker_0: { choice: 'Saki & Kanade' }, speaker_1: { choice: 'Kanade' } } }; } };
  const h = await harness(null, null, null, null, null, decisions);
  h.send('planJev', { transcript: '"Um, hi," Saki said. "Speak up!" Kanade laughed.', config: cast });
  const plan = (await h.result()).message.result;
  assert.deepEqual(Object.keys(evalInput.questions.speaker_0.criteria), ['Saki & Kanade', 'Kanade', 'Someone not listed']);
  assert.match(evalInput.questions.speaker_0.criteria['Saki & Kanade'], /also called Saki/);
  assert.match(evalInput.questions.speaker_0.criteria.Kanade, /also called Kana/);
  assert.deepEqual([...plan.segments.filter(s => s.speaker !== 'Narrator').map(s => s.voice)], ['saki', 'kanade']);
});

test('dialogue from someone not in the cast goes to the enabled LLM fallback, otherwise to a separate NPC', async () => {
  const answer = async () => ({ status: 200, body: JSON.stringify({ answers: { q0: { choice: 'Someone not listed' } } }) });
  let llmCalls = 0;
  const fallback = await harness(async () => { llmCalls++; return { content: JSON.stringify({ segments: [{ speaker: 'Narrator', unit_ids: [0] }, { speaker: 'Clerk', voice: 'Charon', unit_ids: [1] }] }) }; }, answer);
  fallback.send('plan', { transcript: 'The clerk droned. "Seven hundred change."', config: { ...castConfig, useStyle: false, useJev: true, jevApiKey: 'jev-key', allowLlmFallback: true } });
  const planned = (await fallback.result()).message.result;
  assert.equal(llmCalls, 1);
  assert.match(planned.warning, /not in the cast/);
  assert.equal(planned.segments[1].speaker, 'Clerk');

  const separate = await harness(() => { throw Error('No LLM fallback'); }, answer);
  separate.send('planJev', { transcript: 'The clerk droned. "Seven hundred change."', apiKey: 'jev-key', config: { ...castConfig, useStyle: false } });
  const plan = (await separate.result()).message.result;
  assert.equal(plan.segments[1].speaker, 'Unknown speaker');
  assert.deepEqual([...plan.npcs.map(npc => npc.speaker)], ['Unknown speaker']);

  let requests = 0;
  const narratorOnly = await harness(null, async () => { requests++; throw Error('Unexpected Jev request'); });
  narratorOnly.send('planJev', { transcript: '"Hello."', apiKey: 'jev-key', config: { ...config, useStyle: false } });
  assert.equal((await narratorOnly.result()).message.result.segments[0].speaker, 'Unknown speaker');
  assert.equal(requests, 0);
});

test('testPlanner with Jev and spindle.decisions passes userId to evaluate',async()=>{
  let evalInput;
  const decisions={
    evaluate:async(input)=>{
      evalInput=input;
      return {provider:'TypeSafe AI',model:'Jev System 1',answers:{speaker:{choice:'Alice'}}};
    }
  };
  const h=await harness(null,null,null,null,null,decisions);
  h.send('testPlanner',{plannerMode:'jev'});
  const result=await h.result();
  assert.equal(evalInput.userId,'user-a');
  assert.match(result.message.result.response,/READY/);
});

test('DeepSeek sound choices request JSON mode and recover a truncated response once',async()=>{
 for(const provider of ['deepseek','custom']){
  const requests=[];
  const h=await harness(async input=>{requests.push(input);return requests.length===1?{content:'{"cues":[',finish_reason:'length'}:{content:'{"cues":[{"segment":0,"trigger":"The door slammed","query":"door slam"}],"ambience":[]}',finish_reason:'stop'};},null,provider,null,null,null,{name:'DSmol',model:'deepseek-v4-pro'});
  h.send('sfx',{segments:[{speaker:'Narrator',text:'The door slammed shut.'}],connectionId:'llm-a'});
  const result=await h.result();assert.ok(result.message.result);assert.equal(result.message.result.cues[0].query,'door slam');
  assert.equal(requests.length,2);assert.deepEqual(requests.map(request=>request.parameters.max_tokens),[2048,4096]);
  for(const request of requests){
    assert.equal(request.parameters.response_format.type,'json_object');
    if(provider==='custom'){
      assert.deepEqual(JSON.parse(JSON.stringify(request.parameters.thinking)),{type:'disabled'});
      assert.deepEqual(JSON.parse(JSON.stringify(request.reasoning)),{source:'custom',apiReasoning:true,effort:'auto'});
    }else assert.equal(request.reasoning.source,'off');
  }
  assert.match(requests[1].messages.at(-1).content,/complete JSON object/);
 }
});

test('invalid sound choices stop after one correction and report the selected connection',async()=>{
  let calls=0;const h=await harness(async()=>{calls++;return {content:'',finish_reason:'length'};},null,'deepseek');
  h.send('sfx',{segments:[{speaker:'Narrator',text:'The door slammed shut.'}],connectionId:'llm-a'});
  assert.match((await h.result()).message.error,/deepseek.*gemini-flash-text.*no text.*length/i);assert.equal(calls,2);
});

test('custom DeepSeek planner tests disable thinking while keeping the READY response in plain text',async()=>{
  let request;const h=await harness(async input=>{request=input;return {content:'READY'};},null,'custom',null,null,null,{model:'deepseek-v4-pro'});
  h.send('testPlanner',{connectionId:'llm-a'});assert.match((await h.result()).message.result.response,/READY/);
  assert.equal(request.parameters.thinking.type,'disabled');assert.equal(request.reasoning.source,'custom');assert.equal(request.reasoning.effort,'auto');assert.equal(request.parameters.response_format,undefined);
});

test('sound-choice provider failures and cancellation never trigger a correction request',async()=>{
  let calls=0;const failed=await harness(async()=>{calls++;throw Error('Provider quota exhausted');});
  failed.send('sfx',{segments:[{text:'The door slammed.'}]});assert.match((await failed.result()).message.error,/quota exhausted/);assert.equal(calls,1);
  calls=0;let release;const canceled=await harness(async()=>{calls++;return new Promise(resolve=>release=resolve);});
  canceled.send('sfx',{segments:[{text:'The door slammed.'}]});await new Promise(resolve=>setTimeout(resolve,0));canceled.send('cancel',{});release({content:'invalid json'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,1);assert.equal(canceled.sent.filter(item=>item.message.result || item.message.error).length,0);
});

test('sound effect choices use the planner connection and return only cues and ambience that match the segments',async()=>{
  let request;
  const h=await harness(async input=>{request=input;return {content:JSON.stringify({cues:[
    {segment:0,trigger:'Die Tür',query:'door slam'},{segment:3,trigger:'x',query:'thunder'}
  ],ambience:[{segment:0,trigger:'fiel ins',query:'wind'},{segment:2,trigger:'x',query:'rain'}]})};},null,'openai');
  h.send('sfx',{segments:[{speaker:'Narrator',text:'Die Tür fiel ins Schloss.'}],connectionId:'llm-a'});
  const result=await h.result();
  assert.deepEqual(JSON.parse(JSON.stringify(result.message.result)),{cues:[{segment:0,query:'door slam',trigger:'Die Tür'}],ambience:[{segment:0,query:'wind',trigger:'fiel ins'}]});
  assert.equal(request.userId,'user-a');assert.equal(request.connection_id,'llm-a');assert.equal(request.reasoning.source,'off');
  assert.equal(request.parameters.response_format.type,'json_object');
  assert.match(request.messages[0].content,/English Freesound search/);
  const empty=await harness(()=>{throw Error('Should not call the LLM');});
  empty.send('sfx',{segments:[]});assert.deepEqual(JSON.parse(JSON.stringify((await empty.result()).message.result)),{cues:[],ambience:[]});
});
