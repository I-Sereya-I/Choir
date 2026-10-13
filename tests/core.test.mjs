import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {speechPanel} from './fixtures/speech-panel.mjs';
import {randomUuid,sha256Hex,ignoredTagNames,characterCardRoles,reconcileCardCast} from '../src/core.js';
import {validatePlan, validateCastConfig, geminiRequest, extractGeminiAudio, splitSegment, speechBatches, speechRequestLimits, audioBytes, transcriptFromMessage, parsePlanJson, normalizeVoiceCatalogue, speechSourceUnits, resolvePlanReferences, planningSections, plannerPrompt, stripAudioTags, fastClassifyPlan, resolvePlannerMode, soundCuePrompt, parseSoundCues, applySoundCues, rankMusic, cueOffset, readableText, readAlongIndex, locatePassages, spokenLength, attributionPlan, restoreAttribution, apiErrorMessage} from '../src/core.js';

test('ignored tags skip nested, attributed, mixed-case and unfinished blocks without dropping ordinary story markup',()=>{
  assert.deepEqual(ignoredTagNames('Summary, <private-note>\nsummary; invalid.*'),['summary','private-note']);
  const text='Before. <Summary title="a > b">Hidden. <summary>Nested.</summary><b>Also hidden.</b></Summary> <b>After.</b> <private-note/> End.';
  assert.equal(transcriptFromMessage(text,'summary, private-note').replace(/\s+/g,' '),'Before. After. End.');
  assert.equal(transcriptFromMessage('Safe. <summary>Never finished','summary'),'Safe.');
  assert.equal(transcriptFromMessage('<summary>Entirely ignored.</summary>','summary'),'');
  assert.equal(transcriptFromMessage('Read <story>this.</story>','other'),'Read this.');
});

test('ignored entries accept exact classes and IDs, optionally scoped to a tag',()=>{
  assert.deepEqual(ignoredTagNames('Summary, <private-note>, .UI-note, #Panel-ID, div.ui-note, aside#sidebar, .ui-note, invalid.*, div[hidden], .one.two'),['summary','private-note','.ui-note','#panel-id','div.ui-note','aside#sidebar']);
  const source=`Before. <div class="note extra" title="a > b">Hidden. <div>Nested.</div></div> <p class="note">Read this.</p> <aside id='sidebar'>Hidden too.</aside> <span class=not-note>After.</span>`;
  assert.equal(transcriptFromMessage(source,'div.note, #sidebar').replace(/\s+/g,' '),'Before. Read this. After.');
  assert.equal(transcriptFromMessage(source,'.NOTE, aside#SIDEBAR').replace(/\s+/g,' '),'Before. After.');
  assert.equal(transcriptFromMessage('Read. <div class="note">An unfinished excluded block','.note'),'Read.');
  assert.equal(transcriptFromMessage('<div id=sidebar/><p>Read.</p>','#sidebar'),'Read.');
});

test('complete radio-tabbed panels are removed automatically with their notification and status chrome',()=>{
  assert.equal(transcriptFromMessage(speechPanel),'');
  for(const wrapper of ['Before. '+speechPanel+' After.',`<div class="story"><p>Before.</p>${speechPanel}<p>After.</p></div>`]){
    assert.equal(transcriptFromMessage(wrapper).replace(/\s+/g,' '),'Before. After.');
  }
  assert.equal(transcriptFromMessage(`<div><p>Before.</p>${speechPanel}${speechPanel}<p>After.</p></div>`).replace(/\s+/g,' '),'Before. After.');
});

test('ARIA tabbed panels are filtered as complete components while surrounding HTML prose survives',()=>{
  const panel='<section class="browser-panel"><div role="tablist"><button role="tab" aria-controls="one">One</button><button role="tab" aria-controls="two">Two</button></div><div role="tabpanel" id="one">Interface article.</div><div role="tabpanel" id="two">Another article.</div></section>';
  assert.equal(transcriptFromMessage(`<article><p>He opened the page.</p>${panel}<div>"Hello," she said.</div></article>`).replace(/\s+/g,' '),'He opened the page. "Hello," she said.');
});

test('interface controls, hidden text and SVG labels do not enter the speech transcript',()=>{
  const widgets=['<button>Next page</button>','<select><option>Choose a tab</option></select>','<textarea>UI draft</textarea>','<svg><title>Battery</title><text>84%</text></svg>','<div hidden>Hidden panel</div>','<div aria-hidden="true">Decorative text</div>','<div style="color: red; display: none !important;">Invisible text</div>','<div role="toolbar"><button>Save</button>Toolbar label</div>'];
  for(const widget of widgets)assert.equal(transcriptFromMessage('Before. '+widget+' After.').replace(/\s+/g,' '),'Before. After.');
  assert.equal(transcriptFromMessage('Before. <style>.x::after { content: "<div>not HTML</div>"; }</style> After.').replace(/\s+/g,' '),'Before. After.');
});

test('styled story layouts, literal UI descriptions and incomplete tab markup are retained conservatively',()=>{
  const story='<div style="background: navy; border: 1px solid blue"><p>She tapped the browser tab.</p><div class="tab-content">"Wait," he said.</div><span>Then he closed the window.</span></div>';
  assert.equal(transcriptFromMessage(story).replace(/\s+/g,' '),'She tapped the browser tab."Wait," he said.Then he closed the window.');
  const incomplete=speechPanel.slice(0,speechPanel.lastIndexOf('</div>'))+'<p>The story continues outside the incomplete widget.</p>';
  assert.ok(transcriptFromMessage(incomplete).includes('The story continues outside the incomplete widget.'));
  assert.equal(transcriptFromMessage('<div class="kb-content-wrap">Ordinary narration.</div>'),'Ordinary narration.');
  assert.equal(transcriptFromMessage('<div data-class="hud">Actual story.</div>'),'Actual story.');
  const mixed=speechPanel.replace('  <style>','Phone screen description. <style>');
  const surrounding=`<div style="background: navy"><p>Story before.</p>${mixed}<p>Story after.</p></div>`;
  assert.ok(transcriptFromMessage(surrounding).includes('Story before.'));assert.ok(transcriptFromMessage(surrounding).includes('Story after.'));
});

test('multiple card characters keep separate profiles even when the second begins beyond the description budget',()=>{
  const card={name:'Adrian and Ethan | Show and Tell',description:'<adrian>\n# Adrian\nA male captain. '+ 'Captain. '.repeat(1000)+'\n</adrian>\n<ethan>\n# Ethan\nA male teammate with a different voice.\n</ethan>'};
  const roles=characterCardRoles(card);assert.deepEqual(roles.map(role=>role.name),['Adrian','Ethan']);assert.equal(roles[0].description.length,8000);assert.match(roles[1].description,/different voice/);assert.ok(!roles[1].description.includes('Captain.'));
  assert.deepEqual(characterCardRoles({name:'War and Peace',description:'A story about many people.'}),[]);
  assert.deepEqual(characterCardRoles({name:'Mira',description:'# Appearance\nTall.\n# Personality\nCalm.'}),[]);
  assert.deepEqual(characterCardRoles({...card,name:'Swimming team'}).map(role=>role.name),['Adrian','Ethan']);
});

test('decorated card titles reconcile existing lead identities and duplicate NPCs across providers without changing lead voices',()=>{
  const title='Kellin Beckett || Toxic Fans',lead={speaker:'Kellin Beckett',voice:'lead',route:'native:b',style:'',aliases:['Kellin']};
  const duplicate={speaker:title,voice:'npc',style:''},mikey={speaker:'Mikey Ross',voice:'npc',style:''};
  const original={fixed:[{speaker:'Narrator',voice:'n',style:''},{speaker:'Laiyah',voice:'y',style:''},lead],casts:{'native:a':[mikey,duplicate],'native:b':[duplicate]},singleVoices:{'native:a':{[title]:'npc','Kellin Beckett':'lead','Mikey Ross':'npc'}}};
  const clean=reconcileCardCast(original,{name:title});
  assert.equal(clean.fixed[2].voice,'lead');assert.equal(clean.fixed[2].route,'native:b');assert.deepEqual(clean.fixed[2].aliases,['Kellin',title]);
  assert.deepEqual(clean.casts,{'native:a':[mikey],'native:b':[]});assert.deepEqual(clean.singleVoices['native:a'],{'Kellin Beckett':'lead','Mikey Ross':'npc'});
  assert.equal(original.casts['native:a'].length,2);assert.deepEqual(original.fixed[2].aliases,['Kellin']);
  const cast={...clean,voices:[{id:'n',route:'native:a'},{id:'y',route:'native:a'},{id:'lead',route:'native:b'},{id:'npc',route:'native:a'}],npcs:clean.casts['native:a'],defaultRoute:'native:a'};
  const plan=validatePlan({segments:[{speaker:title,voice:'npc',text:'"Hello."'}]},'"Hello."',cast);
  assert.equal(plan.segments[0].speaker,'Kellin Beckett');assert.equal(plan.segments[0].voice,'lead');assert.deepEqual(plan.npcs,[mikey]);
});

test('card title identity matching preserves scenario casts, manual names, conflicting leads and separate characters',()=>{
  const value={fixed:[{speaker:'Narrator'},{speaker:'Persona'},{speaker:'Kellin Beckett'}],casts:{'native:a':[{speaker:'Mikey Ross'}]}};
  assert.strictEqual(reconcileCardCast(value,{name:'A crowded backstage'}),value);
  const conflict={...value,fixed:[...value.fixed,{speaker:'Kellin Beckett || Toxic Fans'}]};assert.strictEqual(reconcileCardCast(conflict,{name:'Kellin Beckett || Toxic Fans'}),conflict);
  const group={...value,fixed:[...value.fixed.slice(0,2),{speaker:'Adrian'},{speaker:'Ethan'}]};
  assert.strictEqual(reconcileCardCast(group,{name:'Adrian and Ethan | Show and Tell',description:'# Adrian\nA captain.\n# Ethan\nA teammate.'}),group);
  const named={...value,fixed:[...value.fixed.slice(0,2),{speaker:'My chosen name',aliases:['Kellin Beckett']}]};
  assert.equal(reconcileCardCast(named,{name:'Kellin Beckett || Toxic Fans'}).fixed[2].speaker,'My chosen name');
  const renamed={...value,fixed:[...value.fixed.slice(0,2),{speaker:'Kellin Beckett || Toxic Fans',aliases:['Kellin Beckett || Toxic Fans']}]};
  assert.deepEqual(reconcileCardCast(renamed,{name:'Kellin Beckett || Toxic Fans'}).fixed[2].aliases,['Kellin Beckett']);
});

test('HTTP UUID fallback uses secure random bytes, preserves v4 bits and generates distinct IDs',()=>{
  const httpCrypto={getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)};
  const ids=Array.from({length:1000},()=>randomUuid(httpCrypto));assert.equal(new Set(ids).size,1000);
  for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(randomUuid({getRandomValues:bytes=>bytes.fill(255)}),'ffffffff-ffff-4fff-bfff-ffffffffffff');
  const secureCrypto={randomUUID(){assert.equal(this,secureCrypto);return 'native-id';}};
  assert.equal(randomUuid(secureCrypto),'native-id');
});

test('HTTP SHA-256 fallback preserves native saved-plan keys for UTF-8 and block boundaries',async()=>{
  const values=['','abc',JSON.stringify(['chat-a','message-a']),JSON.stringify(['チャット🙂','réponse/雨']), '\ud800'];
  for(const length of [55,56,63,64,65,119,120,127,128,129,10000])values.push('a'.repeat(length));
  for(const value of values){
    const expected=createHash('sha256').update(value).digest('hex');
    assert.equal(await sha256Hex(value,{}),expected);assert.equal(await sha256Hex(value),expected);
  }
});

test('API errors preserve provider details across Lumiverse and gateway response formats',()=>{
  for(const body of [{error:'Fish quota exhausted'},{error:{message:'Fish quota exhausted'}},{detail:'Fish quota exhausted'},{message:'Fish quota exhausted'},'Fish quota exhausted']){
    assert.match(apiErrorMessage(JSON.stringify(body),502),/HTTP 502: Fish quota exhausted/);
  }
  assert.match(apiErrorMessage('<style>private styles</style><script>private script</script><h1>Bad Gateway</h1><p>Upstream&nbsp;timed out</p>',502),/HTTP 502: Bad Gateway Upstream timed out$/);
  assert.match(apiErrorMessage('',502),/returned no error details/);
  assert.ok(!apiErrorMessage('{"error":{}}',502).includes('[object Object]'));
  assert.ok(apiErrorMessage('x'.repeat(10000),502).length<600);
});

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

test('consecutive Foley cues keep separate audio parts when narration is muted',()=>{
  const cues=['page turn','door creak','page turn'].map(query=>({kind:'sfx',speaker:'SFX',voice:'',route:'sfx',text:`[SFX: ${query}]`,sfx:{query}}));
  const batches=speechBatches(cues,1800,'native:a',false);
  assert.deepEqual(batches.map(batch=>batch.sfx.query),['page turn','door creak','page turn']);
  assert.deepEqual(batches.map(batch=>batch.text),cues.map(cue=>cue.text));
});

test('speech around an ambience marker never merges into it',()=>{
  const narration=text=>({speaker:'Narrator',voice:'n',style:'',text});
  const batches=speechBatches([narration('Night fell.'),{kind:'ambience',speaker:'Ambience',voice:'',route:'ambience',text:'[Ambience: rain]',ambience:{query:'rain'}},narration('Rain hammered the roof.')],1800,'native:a',false);
  assert.deepEqual(batches.map(batch=>batch.text),['Night fell.','[Ambience: rain]','Rain hammered the roof.']);
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

test('sound choices accept complete JSON surrounded by commentary and ignore reasoning examples',()=>{
  const segments=[{speaker:'Narrator',text:'She slammed the door marked "{exit}". Rain fell outside.'}];
  const chosen={cues:[{segment:0,trigger:'She slammed the door',query:'door slam'}],ambience:[{segment:0,trigger:'Rain fell outside',query:'rain'}]};
  const expected={cues:[{segment:0,trigger:'She slammed the door',query:'door slam'}],ambience:[{segment:0,trigger:'Rain fell outside',query:'rain'}],music:[]};
  for(const response of [
    `Metadata: {"status":"ready"}\n\`\`\`json\n${JSON.stringify(chosen)}\n\`\`\`\nSummary: {"count":2}`,
    `<think>{"cues":[{"segment":0,"query":"footsteps"}],"ambience":[]}</think>\n${JSON.stringify(chosen)}`,
    `Here are the choices for the door marked "{exit}":\n${JSON.stringify(chosen)}`
  ])assert.deepEqual(parseSoundCues(response,segments),expected);
  assert.throws(()=>parseSoundCues('{"cues":[{"segment":0,"query":"door slam"}',segments),/not valid JSON/);
  assert.throws(()=>parseSoundCues('<think>{"cues":[]}</think>',segments),/no text/);
});

test('LLM sound cues and ambience beds are validated against the segments, keep the story language and survive saved attribution',()=>{
  const segments=[{speaker:'Narrator',text:'La puerta se cerró de golpe. Afuera llovía.'},{speaker:'Mira',text:'"¿Quién anda ahí?"'}];
  const prompt=soundCuePrompt(segments);
  assert.match(prompt[0].content,/English Freesound search of 1 to 3 words/);assert.match(prompt[0].content,/"stop":true/);assert.equal(JSON.parse(prompt[1].content).segments[1].index,1);
  const {cues,ambience}=parseSoundCues('```json\n'+JSON.stringify({cues:[
    {segment:5,trigger:'x',query:'thunder'},
    {segment:0,trigger:'La puerta se cerró',query:'door   slam '},
    {segment:1,trigger:'not in the text',query:'footsteps'},
    {segment:0,trigger:'Afuera llovía',query:'rain'},
    {segment:0,trigger:'Afuera',query:''}
  ],ambience:[
    {segment:0,trigger:'Afuera llovía',query:' rain '},
    {segment:1,trigger:'¿Quién',stop:'yes'},
    {segment:1,trigger:'¿Quién',stop:true,query:'ignored'},
    {segment:1,trigger:'anda',query:'wind'},
    {segment:0,query:'tavern crowd'}
  ]})+'\n```',segments);
  // Short replies allow two effects and three bed entries; invalid segments, empty searches and non-boolean stops never count.
  assert.deepEqual(cues,[
    {segment:0,query:'door slam',trigger:'La puerta se cerró'},
    {segment:1,query:'footsteps',trigger:''}
  ]);
  assert.deepEqual(ambience,[
    {segment:0,query:'rain',trigger:'Afuera llovía'},
    {segment:1,stop:true,trigger:'¿Quién'},
    {segment:1,query:'wind',trigger:'anda'}
  ]);
  assert.deepEqual(parseSoundCues('{"cues":[]}',segments),{cues:[],ambience:[],music:[]});
  assert.throws(()=>parseSoundCues('no json here',segments),/not valid JSON/);
  assert.throws(()=>parseSoundCues('{"effects":[]}',segments),/no cues list/);
  const config={voices:[{id:'n'},{id:'m'}],fixed:[{speaker:'Narrator',voice:'n',style:''},{speaker:'Mira',voice:'m',style:''}],npcs:[]};
  const transcript=segments.map(segment=>segment.text).join(' ');
  const plan=validatePlan({segments:applySoundCues(segments.map(segment=>({...segment,voice:segment.speaker==='Mira'?'m':'n'})),{cues:[...cues,{segment:0,trigger:'Afuera llovía',query:'rain'}],ambience})},transcript,config);
  assert.deepEqual(plan.segments[0].sfx,[{query:'door slam',trigger:'La puerta se cerró'},{query:'rain',trigger:'Afuera llovía'}]);
  assert.deepEqual(plan.segments.map(segment=>segment.ambience),[[{query:'rain',trigger:'Afuera llovía'}],[{stop:true,trigger:'¿Quién'},{query:'wind',trigger:'anda'}]]);
  const restored=restoreAttribution(structuredClone(attributionPlan(plan,config)),transcript,config);
  assert.deepEqual(restored.segments.map(({sfx,ambience})=>({sfx,ambience})),plan.segments.map(({sfx,ambience})=>({sfx,ambience})));
});

test('music entries are asked for only when enabled, keep known feels and genres, and survive saved attribution',()=>{
  const segments=[{speaker:'Narrator',text:'The forest grew dark. Then the sun rose.'}];
  assert.doesNotMatch(soundCuePrompt(segments)[0].content,/music entries/);
  const prompt=soundCuePrompt(segments,{music:true})[0].content;
  assert.match(prompt,/music entries follow/);assert.match(prompt,/Suspenseful/);assert.match(prompt,/Silent Film Score/);assert.match(prompt,/"music":\[\]/);
  assert.doesNotMatch(prompt,/already playing/);
  assert.match(soundCuePrompt(segments,{music:true,currentMusic:{title:'Crypto',feels:['Dark']}})[0].content,/Music "Crypto" \(Dark\) is already playing from the previous text and carries on: return a music entry only when this text clearly changes the mood or setting/);
  assert.doesNotMatch(soundCuePrompt(segments,{currentMusic:{title:'Crypto',feels:['Dark']}})[0].content,/already playing/);
  const {music}=parseSoundCues(JSON.stringify({cues:[],music:[
    {segment:0,trigger:'The forest',feels:['eerie','Spooky','Dark','Mysterious','Intense'],genres:['soundtrack','Horror','Jazz'],keywords:[' harp ','forest','','x','y','z','w']},
    {segment:0,trigger:'Then the sun',stop:true},
    {segment:0,feels:['Spooky'],genres:['Trap']},
    {segment:0,feels:['Spooky'],genres:['Trap'],keywords:['drums']},
    {segment:0,trigger:'Then the sun',feels:['Uplifting']},
    {segment:0,trigger:'rose',genres:['Classical']}
  ]}),segments);
  assert.deepEqual(music,[
    {segment:0,feels:['Eerie','Dark','Mysterious'],genres:['Soundtrack','Horror'],keywords:['harp','forest','x','y','z'],trigger:'The forest'},
    {segment:0,stop:true,trigger:'Then the sun'},
    {segment:0,feels:[],genres:[],keywords:['drums'],trigger:''}
  ]);
  const config={voices:[{id:'n'}],fixed:[{speaker:'Narrator',voice:'n',style:''}],npcs:[]};
  const plan=validatePlan({segments:applySoundCues(segments.map(segment=>({...segment,voice:'n'})),{music})},segments[0].text,config);
  assert.deepEqual(plan.segments[0].music,music.map(({segment,...entry})=>entry));
  assert.deepEqual(restoreAttribution(structuredClone(attributionPlan(plan,config)),segments[0].text,config).segments[0].music,plan.segments[0].music);
});

test('cue triggers match across typographic and ASCII quotes and keep the story offset',()=>{
  const text='She whispered “Don’t go” and the door creaked.';
  assert.equal(cueOffset(text,'"Don\'t go"'),text.indexOf('“'));
  assert.equal(cueOffset('He said "it\'s late" twice.','“it’s late”'),8);
  const {cues}=parseSoundCues(JSON.stringify({cues:[{segment:0,trigger:'"Don\'t go" and the door',query:'door creak'}]}),[{speaker:'Narrator',text}]);
  assert.equal(cues[0].trigger,'"Don\'t go" and the door');
});

test('rankMusic scores feels, genre, keywords and full-length tracks',()=>{
  const piece=(title,feel,genre,length='00:03:00',extra={})=>({title,filename:`${title}.mp3`,feel,genre,length,instruments:'',description:'',...extra});
  const pieces=[
    piece('Sting','Dark, Mysterious','22','00:00:08'),
    piece('Jolly','Bouncy, Humorous','15'),
    piece('Shadows','Dark, Mysterious, Eerie','10'),
    piece('Woods','Mysterious','22','00:02:00',{instruments:'Harp, Strings',description:'A walk in the forest.'}),
    piece('Broken','Dark','22','00:04:00',{filename:''}),
    piece('Night','Dark','25')
  ];
  const want={feels:['Dark','Mysterious'],genres:['Soundtrack'],keywords:['harp','forest']};
  // Sting 3+3+2, Woods 3+2+2+0.5, Shadows 3+3+0.5, Night 3+0.5, Jolly 0.5; tracks without a file are skipped.
  assert.deepEqual(rankMusic(pieces,want).map(track=>track.title),['Sting','Woods','Shadows','Night','Jolly']);
  assert.deepEqual(rankMusic(pieces,want,2).map(track=>track.title),['Sting','Woods']);
  assert.equal(rankMusic(pieces,{}).at(-1).title,'Sting');
});

test('Fish community routes ask the planner to describe new voices and hide that route\'s own catalogue; My Fish voices keep the old prompt',()=>{
  const cast={voices:[{id:'own',route:'native:fish'},{id:'kept',route:'native:both'},{id:'Kore',route:'gemini'}],fixed:[{speaker:'Narrator',voice:'Kore',style:'',route:'gemini'}],npcs:[],defaultRoute:'native:fish'};
  const own=plannerPrompt('Hello.',cast,'');
  assert.doesNotMatch(own[0].content,/voiceSearch/);
  assert.deepEqual(Object.keys(JSON.parse(own[1].content)),['fixedCast','existingNPCs','characterProfiles','availableVoices','defaultRoute','context','sourceUnits']);
  const community=plannerPrompt('Hello.',{...cast,communityRoutes:{'native:fish':'community','native:both':'both'}},'');
  assert.match(community[0].content,/"voiceSearch":\{"gender":"female\|male\|neutral","age":"young\|middle-aged\|old"/);
  assert.match(community[0].content,/top-level "language" with the ISO 639-1 code/);
  const data=JSON.parse(community[1].content);
  assert.deepEqual(data.availableVoices.map(voice=>voice.id),['kept','Kore']);
  assert.deepEqual(data.communityRoutes,{'native:fish':'community','native:both':'both'});
});

test('read-along maps transcript passages onto rendered text nodes across markup, quote styles, repeats and scripts',()=>{
  const nodes=['The gate',' creaked. “Hello,” said ','Mira','. “Hello,” the echo answered. ','Nested ','tags',' stay readable. ','「こんにちは」と','彼女は言った。Привет, ','МИР!'];
  const {stream,at}=readAlongIndex(nodes);
  const shown=span=>{
    if(!span)return null;
    const [startNode,startOffset]=at[span[0]],[endNode,endOffset]=at[span[1]-1];
    return nodes.slice(startNode,endNode+1).map((text,i)=>text.slice(i?0:startOffset,startNode+i===endNode?endOffset+1:undefined)).join('');
  };
  const passages=['*The gate* creaked.','"Hello,"','said **Mira**.','Missing words.','"Hello,"','the echo answered.','Nested tags stay readable.','「こんにちは」と彼女は言った。','Привет, мир!'];
  assert.deepEqual(locatePassages(stream,passages).map(shown),['The gate creaked','Hello','said Mira',null,'Hello','the echo answered','Nested tags stay readable','こんにちは」と彼女は言った','Привет, МИР']);
  const spans=locatePassages(stream,passages);
  assert.equal(at[spans[4][0]][0],3,'the second Hello resolves to its own occurrence');
  assert.equal(readableText('“Don’t,” she SAID — İ.'),'dontshesaidİ');
  assert.deepEqual(locatePassages(stream,['', '...']),[null,null]);
});

test('read-along word progress is monotonic, snaps to word ends and lingers on punctuation pauses',()=>{
  const text='The gate closed. Then, slowly — it opened again…';
  let previous=0;
  for(let step=0;step<=100;step++){
    const end=spokenLength(text,step/100);
    assert.ok(end>=previous,'progress never moves backwards');
    assert.ok(end===text.length || /\s/.test(text[end]),'the highlight ends on a word boundary');
    previous=end;
  }
  assert.equal(spokenLength(text,0),3);
  assert.equal(spokenLength(text,1),text.length);
  assert.equal(spokenLength(text,-1),3);
  assert.equal(spokenLength(text,2),text.length);
  assert.equal(spokenLength('Stop. Go now',0.5),5,'a sentence end holds the highlight during its pause');
  assert.equal(spokenLength('Stop Go now',0.5),7);
});
