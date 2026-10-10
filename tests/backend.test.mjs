import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const bundle=readFileSync(new URL('../dist/backend.js',import.meta.url),'utf8');
const config={voices:[{id:'Charon'},{id:'Kore'}],fixed:[{speaker:'Narrator',voice:'Charon',style:''}],npcs:[],useStyle:true};
async function harness(generate, cors, provider) {
  let handler;const sent=[];let wake;
  const connection={id:'llm-a',is_default:true,model:'gemini-flash-text',provider};
  vm.runInNewContext(bundle,{spindle:{onFrontendMessage:h=>handler=h,sendToFrontend:(message,user,options)=>{sent.push({message,user,options});wake?.();},generate:{raw:generate},connections:{get:async()=>connection,list:async()=>[connection]},cors},
    console,Map,Set,AbortController,setTimeout,clearTimeout,URL,crypto:globalThis.crypto,atob,Uint8Array,DataView});
  return {sent,send:(action,input,id='request')=>handler({namespace:'choir',action,input,id},'user-a','session-a'),
    result:()=>sent.length?Promise.resolve(sent.at(-1)):new Promise(resolve=>{wake=()=>resolve(sent.at(-1));})};
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
  await new Promise(r=>setTimeout(r,10));assert.equal(h.sent.length,0);
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
  const result=await h.result();assert.equal(result.message.result.ready,true);assert.equal(result.message.result.version,'1.0.10');
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
