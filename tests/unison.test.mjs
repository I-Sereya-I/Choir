import {test} from 'node:test';
import assert from 'node:assert/strict';
import {characterCardRoleDiscovery} from '../src/core.js';
import {characterCardRoles,fastClassifyPlan,validatePlan,speechSourceUnits,resolvePlanReferences,attributionPlan,restoreAttribution,groupedSpeechBatches,mixUnisonAudio,unisonSpeakers} from '../src/core.js';

const cast=()=>({fixed:[{speaker:'Narrator',voice:'n',style:''},{speaker:'Levi',voice:'l',style:'Gentle',aliases:['Levi Cline']},{speaker:'Cole',voice:'c',style:'Low',aliases:['Cole Lane']}],npcs:[],voices:['n','l','c','x'].map(id=>({id})),useStyle:true});
const passage='They stop at the reception desk. Levi’s hand finds the edge of the counter. Cole’s hand finds his pocket. "User," they say in unison.';

test('collective attribution excludes listeners and observers and supports common speech verbs',()=>{
 const config=cast();config.fixed.push({speaker:'Judy',voice:'x',style:''});
 for(const text of ['"Hello," Levi and Cole said to Judy in unison.','Judy watched Levi and Cole enter. "Hello," they said in unison.','"Hello," Levi and Cole yelled in unison.','Levi and Cole scream together, "Hello."','Together, Levi and Cole chanted, "Hello."']){
  const plan=fastClassifyPlan(text,config,{});assert.ok(plan,text);assert.deepEqual(plan.segments.find(segment=>segment.unison).unison.map(member=>member.speaker),['Levi','Cole'],text);
 }
 const failure={};assert.equal(fastClassifyPlan('Levi, Cole and Judy arrived. "Hello," they both said in unison.',config,failure),null);assert.equal(failure.reason,'ambiguous-unison');
 assert.equal(fastClassifyPlan('Levi told Judy where Cole stood. "Hello," they said in unison.',config,{}),null);
});

test('card profiles include leads outside the title and bound nested headings and other fields',()=>{
 const roles=characterCardRoles({name:'Alice&Bob',description:'# Cast\n## Alice\nName: Alice Ward\n### Voice\nBright.\n## Bob\nName: Bob Gray\nDeep.\n## Clara\nName: Clara Wood\nLow alto.',personality:'<Alice>Warm.</Alice>',scenario:'# Diego\nName: Diego Stone\nA fourth lead.'});
 assert.deepEqual(roles.map(role=>role.name),['Alice','Bob','Clara','Diego']);
 assert.ok(!roles[0].description.includes('Deep.'));assert.ok(!roles[1].description.includes('Low alto.'));assert.ok(!roles.some(role=>role.name==='Cast'));
 const bare=characterCardRoles({name:'Alice & Bob',description:'# Alice\nKind.\n# Bob\nQuiet.\n# Clara\nThe third lead of this card.'});assert.deepEqual(bare.map(role=>role.name),['Alice','Bob','Clara']);
 const unknown=characterCardRoleDiscovery({name:'Alice & Bob',description:'# Alice\nKind.\n# Bob\nQuiet.',scenario:'Clara is also a playable lead.'});assert.equal(unknown.needsAnalysis,true);
 const shared=characterCardRoles({name:'Two Alices',description:'<first>Name: Alice Smith</first><second>Name: Alice Brown</second>',personality:'<first>Name: Alice Smith</first>'});
 assert.deepEqual(shared.map(role=>[role.name,role.aliases]),[['Alice Smith',[]],['Alice Brown',[]]]);
});

test('cached unison applies changed NPC voice pools, routes and shared-voice policy to each member',()=>{
 const original=cast();original.fixed=original.fixed.slice(0,1);original.npcs=[{speaker:'Levi',voice:'l',style:''},{speaker:'Cole',voice:'c',style:''}];
 const text='"Hello," Levi and Cole said in unison.',saved=attributionPlan(fastClassifyPlan(text,original,{}),original);
 for(const mode of ['preferred','single']){
  const updated={...original,voices:[...original.voices,{id:'pool',route:'other'}],npcPolicy:{mode,route:'other',voices:['pool'],voice:'pool'}};
  const line=restoreAttribution(saved,text,updated).segments.find(segment=>segment.unison);
  assert.deepEqual(line.unison.map(member=>[member.voice,member.route]),[['pool','other'],['pool','other']]);
 }
});

test('possessive formatted headings and named XML profiles split the Levi and Cole card',()=>{
 const roles=characterCardRoles({name:'Levi & Cole',description:'<{{char}}>\n<levi_cline>\n# _Levi\'s Data_\n- Name: Levi Cline\n# Speech\nGentle and polite.\n</levi_cline>\n<cole_lane>\n# _Cole\'s Data_\n- Name: Cole Lane\n# Speech\nLow and raspy.\n</cole_lane>\n</{{char}}>'});
 assert.deepEqual(roles.map(role=>[role.name,role.aliases]),[['Levi',['Levi Cline']],['Cole',['Cole Lane']]]);
 assert.match(roles[0].description,/Gentle and polite/);assert.ok(!roles[0].description.includes('Low and raspy'));assert.match(roles[1].description,/Low and raspy/);
 assert.deepEqual(characterCardRoles({name:'War and Peace',description:'# Overview\nA novel.'}),[]);
});

test('local unison detection preserves one quote and narrator attribution across planners',()=>{
 const config=cast(),units=speechSourceUnits(passage),quote=units.find(unit=>unit.kind==='dialogue');
 assert.deepEqual(unisonSpeakers(passage,quote,config),['Levi','Cole']);
 const heuristic=fastClassifyPlan(passage,config,{});assert.ok(heuristic);
 const llm=validatePlan(resolvePlanReferences({segments:units.map(unit=>({speaker:unit.kind==='narration'?'Narrator':'Cole',voice:unit.kind==='narration'?'n':'c',style:'',unit_ids:[unit.id]}))},passage,config),passage,config);
 for(const result of [heuristic,llm]){
   const group=result.segments.find(segment=>segment.unison);assert.equal(group.speaker,'Levi & Cole');assert.equal(group.text,'"User,"');assert.deepEqual(group.unison.map(member=>[member.speaker,member.voice]),[['Levi','l'],['Cole','c']]);
   assert.equal(result.segments.at(-1).speaker,'Narrator');assert.equal(result.segments.at(-1).text,'they say in unison.');assert.equal(result.npcs.length,0);
   const saved=attributionPlan(result,config);const updated=cast();updated.fixed[2].voice='x';const restored=restoreAttribution(saved,passage,updated);
   assert.deepEqual(restored.segments.find(segment=>segment.unison).unison.map(member=>[member.voice,member.style]),[['l','Gentle'],['x','Low']]);
 }
});

test('structural cast discovery supports generic titles, different names, JSON and nested XML',()=>{
 const xml='<world><person><nameplate>profile</nameplate>\n- Name: Alice Ward\nBright voice.</person><person>\n- Name: Bruno Moss\nGravelly voice.</person></world>';
 const roles=characterCardRoles({name:'A Night at the Station',description:xml});assert.deepEqual(roles.map(role=>role.name),['Alice Ward','Bruno Moss']);assert.deepEqual(roles.map(role=>role.aliases),[['Alice'],['Bruno']]);assert.ok(!roles[0].description.includes('Gravelly'));
 const json=characterCardRoles({name:'The Expedition',description:JSON.stringify({characters:[{name:'Ada',description:'Low alto.'},{name:'Ben',description:'Young tenor.'},{name:'Cyril',description:'Quiet baritone.'}]})});assert.deepEqual(json.map(role=>role.name),['Ada','Ben','Cyril']);
 const config=cast();config.fixed[1].speaker='Alice';config.fixed[1].aliases=[];config.fixed[2].speaker='Bruno';config.fixed[2].aliases=[];
 assert.equal(fastClassifyPlan('Alice and Bruno called together, "Ready!"',config,{}).segments.at(-1).unison.length,2);
});

test('explicit unison groups resolve aliases and ambiguous plural tags fail safely',()=>{
 const config=cast();
 for(const text of ['"Hello," Levi Cline and Cole Lane said in unison.','Levi and Cole said together, "Hello."'])assert.ok(fastClassifyPlan(text,config,{}).segments.some(segment=>segment.unison));
 const failure={};assert.equal(fastClassifyPlan('"Hello," they said in unison.',config,failure),null);assert.equal(failure.reason,'ambiguous-unison');
 assert.ok(!fastClassifyPlan('Levi said, "We should work together."',config,{}).segments.some(segment=>segment.unison));
});

test('unison is a batching boundary and does not duplicate the source quote',()=>{
 const plan=fastClassifyPlan(passage,cast(),{});
 const batches=groupedSpeechBatches(plan.segments,1800,'',(segment)=>({maxSpeakers:5,maxChars:10000,group:'same'}),{sfx:false});
 assert.equal(batches.length,3);assert.equal(batches[1].text,'"User,"');assert.equal(batches[1].unison.length,2);assert.ok(!batches[1].turns);
});

test('collective dialogue supports three named leads and newly cast NPCs without alias duplicates',()=>{
 const config=cast();config.fixed.push({speaker:'Judy',voice:'x',style:''});
 const result=fastClassifyPlan('Levi waited. Cole stepped up. Judy joined them. "Hello," they all said in unison.',config,{});
 assert.deepEqual(result.segments.find(segment=>segment.unison).unison.map(member=>member.speaker),['Levi','Cole','Judy']);
 const transcript='"Halt," the two guards shouted together.';
 const npcs=validatePlan({segments:[{speaker:'Guard 1',text:'"Halt,"',style:'',unison:[{speaker:'Guard 1',voice:'l',style:''},{speaker:'Guard 2',voice:'c',style:''}]},{speaker:'Narrator',text:'the two guards shouted together.',style:''}]},transcript,cast());
 assert.deepEqual(npcs.npcs.map(actor=>actor.speaker),['Guard 1','Guard 2']);
 assert.throws(()=>validatePlan({segments:[{speaker:'Levi',text:'"Hello."',unison:[{speaker:'Levi',voice:'l'},{speaker:'Levi Cline',voice:'l'}]}]},'"Hello."',cast()),/must be distinct/);
});

test('unison PCM overlaps audible starts, preserves both tracks, levels and peak headroom',()=>{
 const tracks=[{channels:[Float32Array.from([0,0,0.4,0.2,0.1])],level:1},{channels:[Float32Array.from([0,0.2,0.3,0.4,0.5])],level:0.5}];
 const data=mixUnisonAudio(tracks,24000,{normalize:false}),view=new DataView(data.buffer);
 assert.equal(view.getUint32(40,true),8);assert.equal(view.getInt16(44,true),Math.round(0.5*32767));assert.equal(view.getInt16(46,true),Math.round(0.35*32767));assert.equal(view.getInt16(50,true),Math.round(0.25*32767));
 const loud=mixUnisonAudio([{channels:[Float32Array.of(1)]},{channels:[Float32Array.of(1)]}],24000,{normalize:false});assert.ok(new DataView(loud.buffer).getInt16(44,true)<=Math.ceil(0.95*32767));
 const muted=mixUnisonAudio([{channels:[Float32Array.of(0.5)],level:0},{channels:[Float32Array.of(0.2)],level:1}],24000,{normalize:false});assert.equal(new DataView(muted.buffer).getInt16(44,true),Math.round(0.2*32767));
});
