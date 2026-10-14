import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupedSpeechBatches,geminiRequest,passageKey} from '../src/core.js';
const turn=(speaker,text='Hello.',voice=speaker==='Narrator'?'Charon':'Kore')=>({speaker,text,voice,style:'',route:'gemini'});
const limits=()=>({maxChars:10000,maxBytes:6000,maxSpeakers:2,group:'same'});
const batch=(items,options)=>groupedSpeechBatches(items,3000,'gemini',limits,options);
test('grouped speech reduces alternating turns while preserving order and voices',()=>{
  const turns=Array.from({length:12},(_,i)=>turn(i%2?'Alice':'Narrator',`Turn ${i}.`));
  const result=batch(turns);assert.equal(result.length,1);assert.equal(result[0].dialogue,true);
  assert.deepEqual(result[0].turns,turns);assert.equal(geminiRequest(result[0],'gemini-3.8-flash-tts').contents[0].parts.length,12);
});
test('short opening clip is followed by longer bounded clips without losing text',()=>{
  const text='A sentence with a little room to breathe. '.repeat(150).trim();
  const result=batch([turn('Narrator',text)]);assert.ok(result[0].text.length<=600);
  assert.ok(result.slice(1).some(item=>item.text.length>1800));assert.ok(result.every(item=>item.text.length<=2400));
  assert.equal(result.map(item=>item.text).join(' ').replace(/\s+/g,' '),text);
});
test('SFX stays between clips and bounds later requests to 900 characters',()=>{
  const cue={kind:'sfx',route:'sfx',speaker:'SFX',text:'[SFX: door]',sfx:{query:'door'}};
  const result=batch([turn('Narrator','Before.'),cue,turn('Alice','After. '.repeat(250))],{sfx:true});
  assert.deepEqual(result.slice(0,2).map(item=>item.text),['Before.','[SFX: door]']);
  assert.ok(result.slice(2).every(item=>item.text.length<=900));
});
test('third speaker, route, conflicting voice or unequal mixer group starts another request',()=>{
  for(const extra of [turn('Bob','Third.','Puck'),{...turn('Alice'),route:'native:other'},turn('Alice','Changed.','Puck')]){
    const result=batch([turn('Narrator'),turn('Alice'),extra]);assert.equal(result.length,2);
  }
  const result=groupedSpeechBatches([turn('Narrator'),turn('Alice')],1800,'gemini',segment=>({...limits(),group:segment.speaker}));assert.equal(result.length,2);
});
test('unsupported providers group only compatible adjacent single-voice speech',()=>{
  const result=groupedSpeechBatches([turn('Narrator'),turn('Narrator'),turn('Alice')],1800,'gemini',()=>({...limits(),maxSpeakers:0}));
  assert.equal(result.length,2);assert.equal(result[0].dialogue,false);assert.equal(result[1].speaker,'Alice');
});
test('multilingual text plus per-turn instructions stays in the byte budget',()=>{
  const source=Array.from({length:20},(_,i)=>({...turn(i%2?'Alice':'Narrator','你好世界'.repeat(90)),style:'Warm, natural delivery.'}));
  const result=batch(source,{startup:false});assert.ok(result.length>1);
  for(const item of result)assert.ok((item.turns || [item]).reduce((sum,s)=>sum+new TextEncoder().encode(s.text+s.style).length,0)<=6000);
  assert.equal(result.flatMap(item=>item.turns || [item]).map(item=>item.text).join('').replace(/\s/g,''),source.map(item=>item.text).join(''));
});
test('cache identity includes every dialogue voice and delivery',()=>{
  const clip=batch([turn('Narrator'),turn('Alice')])[0],key=passageKey(clip,{model:'gemini-3.8-flash-tts'});
  const changed=structuredClone(clip);changed.turns[1].voice='Puck';assert.notEqual(passageKey(changed,{model:'gemini-3.8-flash-tts'}),key);
});
