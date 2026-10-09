import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan, validateCastConfig, geminiRequest, extractGeminiAudio, splitSegment, audioBytes, transcriptFromMessage, parsePlanJson} from '../src/core.js';

const config = () => ({voices:[{id:'Charon'},{id:'Kore'},{id:'Puck'},{id:'Fenrir'}],useStyle:true,
  fixed:[{speaker:'Narrator',voice:'Charon',style:'Calm'},{speaker:'Alice',voice:'Kore',style:''}],npcs:[]});
test('fixed voices override model choices and NPC voices stay stable',()=>{
  const c=config();
  const result=validatePlan({segments:[
    {speaker:'narrator',voice:'Fenrir',text:'Rain fell.',style:'Slow'},
    {speaker:'Alice',voice:'Puck',text:'Hello.',style:''},
    {speaker:'Guard',voice:'Fenrir',text:'Stop.',style:'Urgent'},
    {speaker:' guard ',voice:'Puck',text:'Wait.',style:'Soft'}
  ]},'Rain fell. Hello. Stop. Wait.',c);
  assert.deepEqual(result.segments.map(v=>v.voice),['Charon','Kore','Fenrir','Fenrir']);
  assert.equal(result.segments[0].style,'Calm. Slow');
  assert.equal(result.npcs.length,1);assert.equal(result.npcs[0].style,'');
  c.npcs=result.npcs;
  assert.equal(validatePlan({segments:[{speaker:'Guard',voice:'Puck',text:'Again.'}]},'Again.',c).segments[0].voice,'Fenrir');
});
test('does not synthesize LLM rewrites, omissions, invented text or unknown voices',()=>{
  for(const segments of [
    [{speaker:'Alice',text:'Changed.'}],
    [{speaker:'Alice',text:'First.'}],
    [{speaker:'Alice',text:'First.'},{speaker:'Alice',text:'Invented.'}],
    [{speaker:'NPC',voice:'missing',text:'First. Last.'}]
  ])assert.throws(()=>validatePlan({segments},'First. Last.',config()));
});
test('repeated dialogue and multilingual transcript stay in exact order',()=>{
  const text='Bonjour.\n「待って！」\nBonjour.';
  const plan=validatePlan({segments:[{speaker:'Narrator',text:'Bonjour.'},{speaker:'Alice',text:'「待って！」'},{speaker:'Narrator',text:'Bonjour.'}]},text,config());
  assert.equal(plan.segments[1].text,'「待って！」');
});
test('catalogue validation catches missing and conflicting manual assignments',()=>{
  const c=config();c.fixed[0].voice='invalid';assert.throws(()=>validateCastConfig(c));
  const d=config();d.npcs=[{speaker:'alice',voice:'Puck',style:''}];assert.throws(()=>validateCastConfig(d));
});
test('style can be disabled independently of multi-voice casting',()=>{
  const c=config();c.useStyle=false;
  const plan=validatePlan({segments:[{speaker:'Narrator',text:'Hello.',style:'Whispered'}]},'Hello.',c);
  assert.equal(plan.segments[0].style,'');
});
test('Gemini REST body separates transcript, metadata and voice',()=>{
  const body=geminiRequest({text:'Hello.',voice:'Kore',style:'Whisper urgently'},'gemini-3.8-flash-tts');
  assert.deepEqual(body.contents[0].parts[0],{text:'Hello.',speech_metadata:{style:'Whisper urgently'}});
  assert.deepEqual(body.generationConfig.speechConfig,{voiceConfig:{voice:'Kore'}});
  assert.throws(()=>geminiRequest({text:'x',voice:'Kore'},'gemini-2.5-pro-preview-tts'));
});
test('splitting preserves ordered words, style and speaker without empty chunks',()=>{
  const original=('First sentence. Second sentence! '+ 'Longer phrase repeated here. ').repeat(30);
  const chunks=splitSegment({text:original,speaker:'Alice',voice:'Kore',style:'Warm'},160);
  assert.ok(chunks.length>2);assert.ok(chunks.every(v=>v.text.length<=160 && v.speaker==='Alice' && v.style==='Warm'));
  assert.equal(chunks.map(v=>v.text).join(' ').replace(/\s+/g,' ').trim(),original.replace(/\s+/g,' ').trim());
  assert.throws(()=>splitSegment({text:original},3));
});
test('WAV is never wrapped twice; legacy raw PCM is playable',()=>{
  const pcm=new Uint8Array([0,0,1,0]);
  const result=audioBytes(Buffer.from(pcm).toString('base64'),'audio/L16;rate=24000');
  assert.equal(result.data.length,48);assert.equal(result.mimeType,'audio/wav');
  const roundTrip=audioBytes(Buffer.from(result.data).toString('base64'),'audio/wav');
  assert.deepEqual(roundTrip.data,result.data);
  assert.deepEqual(extractGeminiAudio({candidates:[{content:{parts:[{inline_data:{data:'YQ==',mime_type:'audio/wav'}}]}}]}),{base64:'YQ==',mimeType:'audio/wav'});
  assert.throws(()=>extractGeminiAudio({}));
});
test('speech preprocessing keeps narration, strips markup and hidden thinking',()=>{
  assert.equal(transcriptFromMessage('<think>hidden</think>*The room was cold.* **Hello.** [Friend](https://example.com)'),'The room was cold. Hello. Friend');
  assert.deepEqual(parsePlanJson('```json\n{"segments":[]}\n```'),{segments:[]});
});

test('planner extracts complete JSON from prose and fences with quoted braces',()=>{
  const plan={segments:[{speaker:'Narrator',text:'I said "{hello}".'}]};
  assert.deepEqual(parsePlanJson('I prepared this plan:\n```json\n'+JSON.stringify(plan)+'\n```\nDone.'),plan);
});

test('prose refusals and truncated plans report the response without repairing dialogue',()=>{
  assert.throws(()=>parsePlanJson('I cannot process this request.'),/Response begins: I cannot/);
  assert.throws(()=>parsePlanJson('{"segments":[{"text":"Hello."}'),/no complete JSON speech plan/);
});

test('unassigned fixed speakers are cast once while explicit assignments remain fixed',()=>{
  const c=config();c.fixed[1].voice='';
  const plan=validatePlan({segments:[
    {speaker:'Narrator',voice:'Puck',text:'Alice said,'},
    {speaker:'Alice',voice:'Fenrir',text:'"Hello."'},
    {speaker:'Alice',voice:'Kore',text:'"Again."'}
  ]},'Alice said, "Hello." "Again."',c);
  assert.deepEqual(plan.segments.map(s=>s.voice),['Charon','Fenrir','Fenrir']);
  assert.equal(c.fixed[1].voice,'');
  assert.throws(()=>validatePlan({segments:[{speaker:'Alice',text:'Hello.'}]},'Hello.',c),/LLM-selected voice/);
});
