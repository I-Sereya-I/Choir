import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attributionPlan,restoreAttribution,validatePlan,validateCastConfig,passageKey,mixerVolume,loudnessGain,castExport,castImport,fastClassifyPlan} from '../src/core.js';
const config={defaultRoute:'native:a',useStyle:true,voices:[{id:'n',route:'native:a'},{id:'m',route:'native:a'},{id:'new',route:'native:b'}],fixed:[{speaker:'Narrator',voice:'n',style:'Calm'},{speaker:'Mira',voice:'m',style:'Bright',aliases:['Captain']}],npcs:[]};

test('attribution survives voice, route and base style changes without repeating delivery styles',()=>{
  const transcript='It rained. "Hello."';
  const plan=validatePlan({segments:[{speaker:'Narrator',text:'It rained.',style:'Slow'},{speaker:'Captain',text:'"Hello."',style:'Warm'}]},transcript,config);
  assert.equal(plan.segments[1].speaker,'Mira');
  const saved=attributionPlan(plan,config);
  assert.equal(saved.segments[1].style,'Warm');assert.ok(!JSON.stringify(saved).includes('Bright'));
  const changed={...config,fixed:[config.fixed[0],{...config.fixed[1],voice:'new',route:'native:b',style:'Quiet'}]};
  const restored=restoreAttribution(saved,transcript,changed);
  assert.equal(restored.segments[1].voice,'new');assert.equal(restored.segments[1].route,'native:b');assert.equal(restored.segments[1].style,'Quiet. Warm');
  assert.deepEqual(attributionPlan(restored,changed),saved);
  assert.throws(()=>restoreAttribution(saved,'It snowed. "Hello."',changed),/changes or skips/);
});

test('aliases identify the canonical actor locally and ambiguous or conflicting aliases fail',()=>{
  const local={...config,fixed:[...config.fixed,{speaker:'Guard',voice:'n',style:''}]};
  const plan=fastClassifyPlan('Captain said, "Hello."',local);
  assert.equal(plan.segments.at(-1).speaker,'Mira');
  assert.throws(()=>validateCastConfig({...config,fixed:[config.fixed[0],{...config.fixed[1],aliases:['Narrator']}]}),/Conflicting character alias/);
});

test('cache identity changes only with synthesis inputs, never mixer controls or credentials',()=>{
  const segment={speaker:'Mira',voice:'m',route:'native:a',text:'Hello.',style:'Warm'};
  const settings={model:'model',useStyle:true,styleParam:'instructions'},connection={model:'model',provider:'openai',api_url:'https://provider.test'};
  const key=passageKey(segment,settings,connection,{accent:'Irish'});
  assert.equal(passageKey(segment,{...settings,master:0.1,apiKey:'different',normalizeLoudness:false},connection,{accent:'Irish'}),key);
  for(const changed of [{text:'Edited.'},{voice:'new'},{route:'native:b'},{style:'Angry'}])assert.notEqual(passageKey({...segment,...changed},settings,connection,{accent:'Irish'}),key);
  assert.notEqual(passageKey(segment,settings,{...connection,model:'new-model'},{accent:'Irish'}),key);
  assert.notEqual(passageKey(segment,settings,connection,{accent:'French'}),key);
});

test('mixer handles mute, multiple solos, clamping and speaker names that match object properties',()=>{
  const channels={Mira:{volume:0.4,solo:true},Guard:{volume:1},Narrator:{volume:0.5,solo:true,mute:true}};
  assert.equal(mixerVolume(0.5,'Mira',channels),0.2);assert.equal(mixerVolume(1,'Guard',channels),0);assert.equal(mixerVolume(1,'Narrator',channels),0);
  assert.equal(mixerVolume(1,'constructor',{}),1);assert.equal(mixerVolume(2,'Mira',{Mira:{volume:2}}),1);
});

test('mixed-provider loudness matching raises quiet audio, lowers loud audio and caps peaks without amplifying silence',()=>{
  const quiet=new Float32Array(24000).fill(0.03),loud=new Float32Array(24000).fill(0.24);
  assert.ok(Math.abs(0.03*loudnessGain([quiet])-0.12)<0.0001);assert.ok(Math.abs(0.24*loudnessGain([loud])-0.12)<0.0001);
  const peaked=new Float32Array(24000).fill(0.01);peaked[0]=0.9;assert.ok(loudnessGain([peaked])*peaked[0]<=0.95);
  assert.equal(loudnessGain([new Float32Array(32)]),1);
});

test('versioned cast exchange round-trips preferences and strips credentials and unknown fields',()=>{
  const c={fixed:[...config.fixed.map(actor=>({...actor,accent:'Irish',pronunciation:'mee-rah',excluded:true}))],casts:{'native:a':[]},jevApiKey:'secret',apiKey:'secret'};
  const exported=castExport({...c,fixed:c.fixed.map(actor=>({...actor,apiKey:'secret'}))});assert.ok(!JSON.stringify(exported).includes('secret'));
  const imported=castImport({...exported,fixed:exported.fixed.map(actor=>({...actor,apiKey:'secret',untrusted:'unknown'}))});
  assert.deepEqual(imported,{fixed:c.fixed,casts:c.casts});
  assert.throws(()=>castImport({...exported,version:2}),/version 1/);
  assert.throws(()=>castImport({...exported,casts:{unknown:[]}}),/provider/);
});


test('cast exchange preserves connection mode and per-provider single voices while rejecting malformed routing',()=>{
 const config={fixed:[{speaker:'Narrator',voice:'n',style:'',excluded:true}],casts:{'native:a':[]},connectionMode:'one',singleVoices:{'native:a':{Narrator:'new',Mira:''}},apiKey:'private-key'};
 const exported=castExport(config);assert.equal(JSON.stringify(exported).includes('private-key'),false);
 assert.deepEqual(castImport(exported),{fixed:config.fixed,casts:config.casts,connectionMode:'one',singleVoices:config.singleVoices});
 assert.throws(()=>castImport({...exported,connectionMode:'unknown'}),/connection mode/);
 assert.throws(()=>castImport({...exported,singleVoices:{'https://evil.test':{Narrator:'n'}}}),/voice choices/);
 assert.throws(()=>castImport({...exported,singleVoices:{'native:a':{Narrator:{secret:'private-key'}}}}),/voice choice/);
});
