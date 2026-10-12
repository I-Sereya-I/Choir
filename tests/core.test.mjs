import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan, validateCastConfig, geminiRequest, extractGeminiAudio, splitSegment, speechBatches, speechRequestLimits, audioBytes, transcriptFromMessage, parsePlanJson, normalizeVoiceCatalogue, speechSourceUnits, resolvePlanReferences, planningSections, plannerPrompt, stripAudioTags, fastClassifyPlan, resolvePlannerMode} from '../src/core.js';

test('larger speech chunks respect provider limits while retaining a conservative unknown-provider limit',()=>{
  assert.equal(speechRequestLimits('openai_tts').maxChars,4096);
  assert.equal(speechRequestLimits('fish_audio').maxChars,10000);
  assert.equal(speechRequestLimits('elevenlabs','eleven_v3').maxChars,5000);
  assert.equal(speechRequestLimits('custom').maxChars,2000);
  assert.equal(speechRequestLimits('google_vertex_tts').maxBytes,6000);
  const text='A long neutral phrase '.repeat(400);
  const batches=speechBatches([{speaker:'Narrator',voice:'n',text}],10000,'native:a',false,()=>speechRequestLimits('openai_tts'));
  assert.ok(batches.length>1);assert.ok(batches.every(batch=>batch.text.length<=4096));
  assert.equal(batches.map(batch=>batch.text).join(' ').trim(),text.trim());
  assert.equal(splitSegment({text:'x'.repeat(10000)},10000).length,1);
  assert.throws(()=>splitSegment({text:'x'},10001),/80–10000/);
});

test('multilingual byte-limited chunks preserve text and never split Unicode surrogate pairs',()=>{
  const text='你好🙂世界'.repeat(1200);
  const chunks=splitSegment({text,speaker:'Narrator',style:'Warm'},10000,6000);
  assert.equal(chunks.map(chunk=>chunk.text).join(''),text);
  assert.ok(chunks.every(chunk=>new TextEncoder().encode(chunk.text).length<=6000 && !/[\uD800-\uDBFF]$/.test(chunk.text) && !/^[\uDC00-\uDFFF]/.test(chunk.text)));
});

test('Gemini batching includes delivery metadata in its safe input budget',()=>{
  const batches=speechBatches([{speaker:'A',voice:'Kore',text:'a'.repeat(3000),style:'Warm'},{speaker:'B',voice:'Puck',text:'b'.repeat(3000),style:'Quiet'}],10000,'gemini');
  assert.equal(batches.length,2);assert.ok(batches.every(batch=>geminiRequest(batch,'gemini-3.8-flash-tts')));
  assert.throws(()=>geminiRequest({text:'你'.repeat(2000),voice:'Kore',style:'Warm'},'gemini-3.8-flash-tts'),/safe input budget/);
});

test('Gemini batches preserve turn metadata and split on third speaker or provider change',()=>{
  const turns=['Narrator','Alice','Narrator','Bob','Alice'].map((speaker,i)=>({speaker,voice:speaker==='Narrator'?'Charon':speaker==='Alice'?'Kore':'Puck',text:'Turn '+i,style:'Soft',route:'gemini'}));
  const batches=speechBatches(turns,1800,'gemini');
  assert.equal(batches.length,2);
  assert.deepEqual(batches.flatMap(batch=>batch.turns).map(turn=>turn.text),turns.map(turn=>turn.text));
  const body=geminiRequest(batches[0],'gemini-3.8-flash-tts');
  assert.equal(body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.length,2);
  assert.equal(body.contents[0].parts[1].speech_metadata.speaker,'Alice');
  assert.equal(body.contents[0].parts[1].speech_metadata.style,'Soft');
  assert.equal(speechBatches(turns,1800,'gemini',false).length,5);
  turns[1].route='native:other';
  assert.equal(speechBatches(turns,1800,'gemini')[0].turns.length,1);
});

const config = () => ({voices:[{id:'Charon'},{id:'Kore'},{id:'Puck'},{id:'Fenrir'}],useStyle:true,
  fixed:[{speaker:'Narrator',voice:'Charon',style:'Calm'},{speaker:'Alice',voice:'Kore',style:''}],npcs:[]});

test('speech strips tracker blocks and nested panels while retaining surrounding narration',()=>{
  for(const block of ['<tracker>HP: 50</tracker>','<details><summary>Tracker</summary><div>HP: 50</div></details>', '<div class="tracker"><div>HP: 50</div>Location: room</div>', '<loom_state><tracker>HP: 50</tracker></loom_state>']) {
    assert.equal(transcriptFromMessage('Before. '+block+' After.').replace(/\s+/g,' '),'Before. After.');
  }
  assert.equal(transcriptFromMessage('Before. <tracker>HP: 50'),'Before.');
  assert.equal(transcriptFromMessage('<div>Normal narration.</div>'),'Normal narration.');
  assert.equal(transcriptFromMessage('Before. <!-- HP: 50 --> After.').replace(/\s+/g,' '),'Before. After.');
});
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

test('gender preferences survive NPC casting and do not override assigned voices',()=>{
  const c=config();c.fixed[1].gender='male';
  const plan=validatePlan({segments:[{speaker:'Alice',voice:'Fenrir',text:'Hello.'},
    {speaker:'Guard',voice:'Puck',gender:'neutral',text:'Welcome.'}]},'Hello. Welcome.',c);
  assert.equal(plan.segments[0].voice,'Kore');
  assert.equal(plan.segments[0].gender,'male');
  assert.equal(plan.npcs[0].gender,'neutral');
  assert.equal(plan.segments[1].gender,'neutral');
  c.fixed[1].gender='invalid';assert.throws(()=>validateCastConfig(c),/gender preference/);
});

test('automatic casting respects catalogue gender while manual choices stay fixed',()=>{
  const c=config();c.voices=[{id:'Kore',gender:'female'},{id:'Puck',gender:'male'},{id:'Charon',gender:'male'}];
  c.fixed[1].voice='';c.fixed[1].gender='female';
  assert.throws(()=>validatePlan({segments:[{speaker:'Alice',voice:'Puck',text:'Hello.'}]},'Hello.',c),/must select a female voice/);
  const plan=validatePlan({segments:[{speaker:'Alice',voice:'Kore',text:'Hello.'}]},'Hello.',c);
  assert.equal(plan.segments[0].voice,'Kore');
  c.fixed[1].voice='Puck';assert.equal(validatePlan({segments:[{speaker:'Alice',voice:'Kore',text:'Hello.'}]},'Hello.',c).segments[0].voice,'Puck');
});

test('Lumiverse gender aliases and named Google voices retain usable gender labels',()=>{
  const voices=normalizeVoiceCatalogue([{id:'Kore',gender:'feminine'},{id:'Puck',gender:'masculine'},
    {id:'custom',gender:['FEMALE']},{id:'neutral',ssmlGender:'NEUTRAL'},{id:'Charon'},
    {id:'en-US-Chirp3-HD-Zephyr'},{id:'custom-unknown'}]);
  assert.deepEqual(voices.map(v=>v.gender),['female','male','female','neutral','male','female',undefined]);
});

test('source references preserve exact text and force unquoted character actions to Narrator',()=>{
  const transcript='Alice stood.\n\n"Hello." She waved. “Goodbye.”';
  const units=speechSourceUnits(transcript);
  assert.deepEqual(units.map(unit=>unit.kind),['narration','dialogue','narration','dialogue']);
  const raw={segments:units.map(unit=>({speaker:'Alice',voice:'Kore',unit_ids:[unit.id],text:'Rewritten by model.'}))};
  const plan=validatePlan(resolvePlanReferences(raw,transcript,config()),transcript,config());
  assert.deepEqual(plan.segments.map(segment=>segment.speaker),['Narrator','Alice','Narrator','Alice']);
  assert.deepEqual(plan.segments.map(segment=>segment.text),units.map(unit=>unit.text));
  assert.deepEqual(plan.segments.map(segment=>segment.voice),['Charon','Kore','Charon','Kore']);
});

test('source references reject skipped, duplicated and reordered IDs and preserve merged whitespace',()=>{
  const text='First.\n\nSecond. Third.';
  for(const ids of [[0,2],[0,0,1,2],[1,0,2],[0,1]])assert.throws(()=>resolvePlanReferences({segments:[{speaker:'Narrator',unit_ids:ids}]},text,config()));
  const plan=validatePlan(resolvePlanReferences({segments:[{speaker:'Narrator',unit_ids:[0,1,2]}]},text,config()),text,config());
  assert.equal(plan.segments[0].text,text);
});

test('more than 250 speech turns can be planned without an artificial segment cap',()=>{
  const text=Array.from({length:140},()=> 'She waved. "Hello."').join('\n');
  const units=speechSourceUnits(text);
  const raw={segments:units.map(unit=>({speaker:'Alice',voice:'Kore',unit_ids:[unit.id]}))};
  assert.equal(validatePlan(resolvePlanReferences(raw,text,config()),text,config()).segments.length,280);
});

test('speaker connections remain fixed even when providers share a voice ID',()=>{
  const c={defaultRoute:'gemini',voices:[{id:'same',route:'gemini',gender:'male'},{id:'same',route:'native:other',gender:'female'}],
    fixed:[{speaker:'Narrator',voice:'same',route:'gemini',style:''},{speaker:'Alice',voice:'',route:'native:other',gender:'female',style:''}],npcs:[]};
  const plan=validatePlan({segments:[{speaker:'Narrator',voice:'same',route:'native:other',text:'Alice said,'},
    {speaker:'Alice',voice:'same',route:'gemini',text:'"Hello."'}]},'Alice said, "Hello."',c);
  assert.deepEqual(plan.segments.map(segment=>segment.route),['gemini','native:other']);
  assert.equal(plan.segments[1].voice,'same');
  c.fixed[1].voice='missing';assert.throws(()=>validateCastConfig(c),/selected TTS connection/);
});

test('new NPCs use the default connection and saved NPC overrides remain stable',()=>{
  const c={defaultRoute:'gemini',voices:[{id:'Kore',route:'gemini'},{id:'custom',route:'native:other'}],
    fixed:[{speaker:'Narrator',voice:'Kore',style:''}],npcs:[]};
  assert.throws(()=>validatePlan({segments:[{speaker:'Guard',voice:'custom',route:'native:other',text:'Hello.'}]},'Hello.',c),/selected TTS connection/);
  c.npcs=[{speaker:'Guard',voice:'custom',route:'native:other',style:''}];
  assert.equal(validatePlan({segments:[{speaker:'Guard',voice:'Kore',route:'gemini',text:'Hello.'}]},'Hello.',c).segments[0].route,'native:other');
});

test('long replies split into planning sections without splitting quoted speech or losing whitespace',()=>{
  const text=Array.from({length:120},(_,i)=>'She waved. "Line '+i+'."\n\n').join('');
  const sections=planningSections(text,600,10);
  assert.ok(sections.length>1);assert.equal(sections.join(''),text);
  for(const section of sections){assert.equal((section.match(/"/g) || []).length%2,0);assert.ok(speechSourceUnits(section).length<=10);}
  const quote='"'+ 'word '.repeat(1500)+'"';
  assert.equal(planningSections(quote).length,1);
});

test('very long individual units use compact identification previews while audio keeps the original',()=>{
  const transcript='"'+ 'Hello there. '.repeat(3000)+'"';
  const data=JSON.parse(plannerPrompt(transcript,config(),'')[1].content);
  assert.ok(data.sourceUnits[0].excerpted);assert.ok(data.sourceUnits[0].text.length<2600);
  const plan=validatePlan(resolvePlanReferences({segments:[{speaker:'Alice',voice:'Kore',unit_ids:[0]}]},transcript,config()),transcript,config());
  assert.equal(plan.segments[0].text,transcript);
});

test('default planning sections keep ordinary requests small and preserve every character',()=>{
  const text=Array.from({length:40},()=> 'She nodded. "Hello."\n').join('');
  const sections=planningSections(text);
  assert.equal(sections.length,10);assert.equal(sections.join(''),text);
  assert.ok(sections.every(section=>speechSourceUnits(section).length<=8 && section.length<=1200));
});

test('stripAudioTags and validatePlan allowing inline tags like <sigh> or [whispers] in segment text without failing transcript equality',()=>{
  assert.equal(stripAudioTags('Hello <sigh> world! [whispers]').trim().replace(/\s+/g, ' '), 'Hello world!');
  assert.equal(stripAudioTags('<gasp> Oh no! <laugh> [shouting] Stop! </pause>').trim().replace(/\s+/g, ' '), 'Oh no! Stop!');
  const c=config();
  const plan=validatePlan({
    segments:[
      {speaker:'Narrator',voice:'Charon',text:'<sigh> Hello world.'},
      {speaker:'Alice',voice:'Kore',text:'Wait! [whispers] Are you sure? <gasp>'}
    ]
  },'Hello world. Wait! Are you sure?',c);
  assert.equal(plan.segments[0].text,'<sigh> Hello world.');
  assert.equal(plan.segments[1].text,'Wait! [whispers] Are you sure? <gasp>');
});

test('validatePlan preserving voicePrompt on newly cast NPCs',()=>{
  const c=config();
  const plan=validatePlan({
    segments:[
      {speaker:'Narrator',voice:'Charon',text:'He entered.'},
      {speaker:'Blacksmith',voice:'Fenrir',text:'Welcome to my forge.',voicePrompt:'Gruff Scottish blacksmith, deep gravelly timbre'}
    ]
  },'He entered. Welcome to my forge.',c);
  assert.equal(plan.npcs.length,1);
  assert.equal(plan.npcs[0].speaker,'Blacksmith');
  assert.equal(plan.npcs[0].voice,'Fenrir');
  assert.equal(plan.npcs[0].voicePrompt,'Gruff Scottish blacksmith, deep gravelly timbre');

  // Also test preservation when raw.newNPCs is provided
  const c2=config();
  const plan2=validatePlan({
    segments:[
      {speaker:'Narrator',voice:'Charon',text:'He looked around.'},
      {speaker:'Merchant',voice:'Puck',text:'Looking to buy?'}
    ],
    newNPCs:[
      {name:'Merchant',voice:'Puck',voicePrompt:'Fast-talking traveling merchant, nasal high pitch'}
    ]
  },'He looked around. Looking to buy?',c2);
  assert.equal(plan2.npcs.length,1);
  assert.equal(plan2.npcs[0].speaker,'Merchant');
  assert.equal(plan2.npcs[0].voicePrompt,'Fast-talking traveling merchant, nasal high pitch');
});

test('stripAudioTags strips Fish Audio natural language bracket and parenthetical emotion tags', () => {
  assert.equal(stripAudioTags('[whispering, nervously] Hello!'), 'Hello!');
  assert.equal(stripAudioTags('[laughs warmly] That is great.'), 'That is great.');
  assert.equal(stripAudioTags('(happy) Good morning.'), 'Good morning.');
  assert.equal(stripAudioTags('[sigh: deep] Finally.'), 'Finally.');
});

test('transcriptFromMessage filters HUD status blocks, metadata, and divider lines', () => {
  const message = `Time: Tuesday, October 14, 07:45 AM (Autumn)
Location: Living Room, Subsidized Apartment 402
Costume: White dress shirt, black trousers, black socks
Posture: Sitting on the edge of the sofa, leaning forward
Nearby Races: Cat Girl (Nekomusume)

Approved

Response
---------
Chapter 1: Cohabitation Clause

A warm weight dropped across Jay's lap before he could reach his second sock.

"Nnnh... you're late, Jay-kun," Nia purred.`;

  const clean = transcriptFromMessage(message);
  assert.ok(!clean.includes('Time:'));
  assert.ok(!clean.includes('Location:'));
  assert.ok(!clean.includes('Costume:'));
  assert.ok(!clean.includes('Approved'));
  assert.ok(!clean.includes('Chapter 1'));
  assert.ok(clean.includes("A warm weight dropped across Jay's lap"));
  assert.ok(clean.includes("Nia purred"));
});

test('fastClassifyPlan resolves pure narration immediately without calling planner', () => {
  const c = config();
  const text = 'The castle gates swung open as the dawn mist cleared from the valley.';
  const plan = fastClassifyPlan(text, c);
  assert.ok(plan);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].speaker, 'Narrator');
  assert.equal(plan.segments[0].text, text);
});

test('fastClassifyPlan resolves 1-on-1 character dialogue directly in 0ms', () => {
  const c = config(); // Narrator (Charon), User (Puck), Alice (Kore)
  const text = 'Alice leaned forward. "Are you ready?" She waited for an answer. "We should leave soon."';
  const plan = fastClassifyPlan(text, c);
  assert.ok(plan);
  assert.equal(plan.segments.length, 4);
  assert.equal(plan.segments[0].speaker, 'Narrator');
  assert.equal(plan.segments[1].speaker, 'Alice');
  assert.equal(plan.segments[1].voice, 'Kore');
  assert.equal(plan.segments[2].speaker, 'Narrator');
  assert.equal(plan.segments[3].speaker, 'Alice');
});

test('fastClassifyPlan uses dialogue tag attribution and detects emotion style', () => {
  const c = config();
  c.fixed.push({ speaker: 'Bob', voice: 'Puck', route: 'gemini', style: '' });
  c.voices.push({ id: 'Puck', route: 'gemini', gender: 'male' });
  const text = '"Good morning," Alice smiled. Bob whispered, "Keep your voice down."';
  const plan = fastClassifyPlan(text, c);
  assert.ok(plan);
  assert.equal(plan.segments[0].speaker, 'Alice');
  assert.equal(plan.segments[0].style, 'cheerful');
  assert.equal(plan.segments[2].speaker, 'Bob');
  assert.equal(plan.segments[2].style, 'whispering');
});

test('fastClassifyPlan returns null on ambiguous multi-character dialogue without tags', () => {
  const c = config();
  c.fixed.push({ speaker: 'Bob', voice: 'Puck', route: 'gemini', style: '' });
  c.voices.push({ id: 'Puck', route: 'gemini', gender: 'male' });
  const text = '"Who is there?" + "\n" + "I am not sure."';
  const plan = fastClassifyPlan(text, c);
  assert.equal(plan, null); // Falls back to LLM/Jev
});

test('explicit planner selection wins over stale flags and legacy selections migrate',()=>{
  assert.equal(resolvePlannerMode({plannerMode:'llm',useFastClassifier:true,useJev:true}),'llm');
  assert.equal(resolvePlannerMode({plannerMode:'jev',useFastClassifier:true}),'jev');
  assert.equal(resolvePlannerMode({useJev:true,useFastClassifier:true}),'jev');
  assert.equal(resolvePlannerMode({useFastClassifier:true}),'heuristic');
  assert.equal(resolvePlannerMode({}),'llm');
});

test('local attribution refuses an untagged turn after a tagged multi-character turn',()=>{
  const c=config();c.fixed.push({speaker:'Bob',voice:'Puck',style:''});
  assert.equal(fastClassifyPlan('"Hello," Alice said. The door opened. "Who is there?"',c),null);
});

test('local attribution refuses tags mentioning multiple candidate speakers',()=>{
  const c=config();c.fixed.push({speaker:'Bob',voice:'Puck',style:''});
  assert.equal(fastClassifyPlan('Alice and Bob stood together. "Hello."',c),null);
});

test('local attribution refuses conflicting speaker tags around the same quote',()=>{
  const c=config();c.fixed.push({speaker:'Bob',voice:'Puck',style:''});
  assert.equal(fastClassifyPlan('Alice said, "Hello," Bob replied.',c),null);
});

test('local attribution recognizes Unicode speaker names with curly quotes',()=>{
  const c=config();c.fixed[1].speaker='Élodie';c.fixed.push({speaker:'Bob',voice:'Puck',style:''});
  const plan=fastClassifyPlan('“Hello,” Élodie whispered. Bob said, “Welcome.”',c);
  assert.ok(plan);assert.deepEqual(plan.segments.filter(s=>s.text.startsWith('“')).map(s=>s.speaker),['Élodie','Bob']);
});

test('a tag introducing the next quote never changes the previous quote speaker',()=>{
  const c=config();c.fixed.push({speaker:'Bob',voice:'Puck',style:''});
  const plan=fastClassifyPlan('Alice said, "Hello." Bob said, "Welcome."',c);
  assert.ok(plan);assert.deepEqual(plan.segments.filter(s=>s.text.startsWith('"')).map(s=>s.speaker),['Alice','Bob']);
});

test('local narration and dialogue apply the cast delivery style exactly once',()=>{
  const c=config();c.fixed[0].style='Measured';c.fixed[1].style='Warm';
  const plan=fastClassifyPlan('The room fell quiet. Alice said, "Hello."',c);
  assert.ok(plan);assert.equal(plan.segments[0].style,'Measured');assert.equal(plan.segments.at(-1).style,'Warm');
});

test('transcriptFromMessage strips markdown headers like # Approved, ## Response, and ### Chapter headers', () => {
  const message = `# Approved

## Response

### Chapter 4: Batter and Boundaries

The countertop had never seen this much purposeful flurry.`;

  const clean = transcriptFromMessage(message);
  assert.equal(clean, 'The countertop had never seen this much purposeful flurry.');
});
