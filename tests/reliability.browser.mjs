import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {setup} from '../dist/frontend.js';
import {validatePlan,speechSourceUnits,planningSections,transcriptFromMessage} from '../src/core.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(predicate)=>{for(let i=0;i<250;i++){if(predicate())return;await tick();}throw Error('Timed out waiting for regression state');};

async function harness(mixerPreferences,mobile=false){
  const dom=new JSDOM('<body><nav><button>Another extension</button><div data-choir-toolbar></div></nav><main></main><footer></footer></body>',{url:'https://lumiverse.test'});
  const layoutListeners=new Set(),channelLayout={matches:mobile,addEventListener:(_,fn)=>layoutListeners.add(fn),removeEventListener:(_,fn)=>layoutListeners.delete(fn)};dom.window.matchMedia=()=>channelLayout;
  const original={document:globalThis.document,Audio:globalThis.Audio,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB};
  globalThis.document=dom.window.document;globalThis.indexedDB=new IDBFactory();
  const root=document.querySelector('main'),footer=document.querySelector('footer'),toolbar=document.querySelector('[data-choir-toolbar]');
  const state={active:'chat-a',blockAudio:false,failVoice:null,delay:0,held:false,aborted:0,previewFetches:[],bedFetches:[],previewAborted:0},store=new Map(),requests=[],synthesis=[],audios=[],audioBlobs=[],events=new Map(),subscriptions=new Map(),heldPlans=[],toolbarActions=new Map();
  const createObjectURL=URL.createObjectURL;URL.createObjectURL=blob=>{audioBlobs.push(blob);return createObjectURL(blob);};
  if(mixerPreferences)store.set('ui:mixer',mixerPreferences);
  const message={id:'message-a',content:'At dawn. "Hello." "Wait." The gate closed.',name:'Mira',is_user:false};
  store.set('chat:chat-a',{mode:'native',connection:'a',styleParam:'instructions',chunk:500,concurrency:1,prefetch:0,
    fixed:[{speaker:'Narrator',voice:'n',style:'Calm'},{speaker:'You',voice:'y',style:''},{speaker:'Mira',voice:'m',route:'native:b',style:'',aliases:['Captain'],pronunciation:'Mira: mee-rah',accent:'Irish'}],
    casts:{'native:a':[{speaker:'Guard',voice:'g',style:''}]}});
  class FakeAudio{
    constructor(){this.paused=true;this.currentTime=0;this.duration=20;audios.push(this);}
    play(){
      if(this.loop && state.bedPlayError)return Promise.reject(Object.assign(new Error('Playback requires a user gesture'),{name:'NotAllowedError'}));
      this.paused=false;this.onloadedmetadata?.();
      if(this.loop && state.bedDecodeError)setTimeout(()=>{this.paused=true;this.onerror?.();},2);
      if(!state.blockAudio)setTimeout(()=>{this.currentTime=20;this.onended?.();},2);return Promise.resolve();
    }
    pause(){this.paused=true;}
  }
  globalThis.Audio=FakeAudio;
  const connections=[{id:'a',name:'Narration provider',provider:'openai_tts',model:'model-a'},{id:'b',name:'Character provider',provider:'accent_tts',model:'model-b'}];
  globalThis.fetch=async(url,options={})=>{
    if(url.endsWith('/spindle')){
      state.branchLookups=(state.branchLookups || 0)+1;if(state.branchLookupFails)throw Error('Branch information unavailable');
      return Response.json({extensions:[{identifier:'other-extension',metadata:{branch:'staging'}},{identifier:'choir',metadata:{branch:state.extensionBranch===undefined?'staging':state.extensionBranch}}]});
    }
    if(url.startsWith('https://freesound.test/ambience.mp3?')){state.bedFetches.push(url);if(state.holdBeds)await new Promise(resolve=>state.releaseBed=resolve);return new Response(`AMBIENCE:${new URL(url).searchParams.get('q')}`,{headers:{'Content-Type':'audio/mpeg'}});}
    if(url==='https://freesound.test/preview.mp3'){
      state.previewFetches.push(url);
      if(state.holdPreview)await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{state.previewAborted++;reject(new DOMException('Stopped','AbortError'));},{once:true}));
      return new Response('FREESOUND_PREVIEW',{status:state.previewStatus || 200,headers:{'Content-Type':state.previewType || 'audio/mpeg'}});
    }
    if(url.endsWith('/tts/synthesize')){
      const input=JSON.parse(options.body);synthesis.push(input);const requestNumber=synthesis.length;
      if(state.synthesisError && (!state.failSynthesisAt || requestNumber===state.failSynthesisAt))return new Response(state.synthesisError.body,{status:state.synthesisError.status,headers:{'Content-Type':state.synthesisError.type || 'text/plain'}});
      if(state.allowedVoices && !state.allowedVoices[input.connectionId]?.includes(input.voice))return Response.json({error:'Invalid provider voice ID'},{status:400});
      if(state.delay)await new Promise((resolve,reject)=>{
        const timeout=setTimeout(resolve,state.delay);
        options.signal.addEventListener('abort',()=>{clearTimeout(timeout);state.aborted++;reject(new DOMException('Stopped','AbortError'));},{once:true});
      });
      if(input.voice===state.failVoice || requestNumber===state.failSynthesisAt)return new Response('Provider quota exhausted',{status:429});
      return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}});
    }
    let value;
    if(url.includes('/providers'))value={providers:[{id:'openai_tts',capabilities:{parameters:{instructions:{type:'string'}}}},{id:'accent_tts',capabilities:{parameters:{instructions:{type:'string'},accent:{enum:['Irish','French']}}}}]};
    else if(url.endsWith('/voices')){if(state.failCatalogue)throw Error('Voice catalogue unavailable');value=state.catalogues?.[url.split('/').at(-2)] || {voices:['n','y','m','g','new'].map(id=>({id,name:id,description:id==='m'?'A mature, husky Irish voice.':'A light, youthful voice.'}))};}
    else if(url.includes('/chats/') && url.includes('/messages?')){state.canonicalReads=(state.canonicalReads || 0)+1;value={data:state.savedMessages || []};}
    else if(url.includes('/personas/'))value=state.persona;
    else if(url.includes('/decision-connections?'))value={data:[{id:'decision-a',name:'Decision A',provider:'typesafe',model:'jev'},{id:'decision-b',name:'Decision B',provider:'typesafe',model:'jev'}]};
    else if(url.includes('/connections?'))value={data:[{id:'planner',name:'Planner',model:'text-model'}]};
    else value={data:connections};
    return Response.json(value);
  };
  let backend,decorationCleanup;
  const ctx={settings:{get:async key=>structuredClone(store.get(key) ?? null),set:async(key,value)=>{const snapshot=structuredClone(value);if(state.failPlanSave && /^(plan:|activeplan:)/.test(key) || state.failConfigSave && /^(chat:|settings:)/.test(key) || state.failDefaultsSave && key==='settings:captured-defaults')throw Error('Settings storage failed');if(state.configDelay && /^(chat:|settings:)/.test(key))await new Promise(resolve=>setTimeout(resolve,state.configDelay));store.set(key,snapshot);}},
    messages:{getRecent:()=>state.active==='chat-a'?(state.messages || [message]):[],getContent:id=>state.active==='chat-a'?(state.messages || [message]).find(item=>item.id===id)?.content ?? null:null},
    state:{get:key=>key==='persona.activeId'?state.persona?.id:undefined,subscribe:(key,fn)=>{subscriptions.set(key,fn);return()=>subscriptions.delete(key);}},events:{on:(key,fn)=>{events.set(key,fn);return()=>events.delete(key);}},
    characters:{get:async()=>{if(state.failProfile)throw Error('Character unavailable');return state.character || {name:'Mira'};}},getActiveChat:()=>({chatId:state.active,characterId:'mira'}),dom:{addStyle:()=>()=>{}},
    ui:{mount:point=>point==='chat_actions'?toolbar:undefined,registerDrawerTab:()=>({root,activate(){},destroy(){root.replaceChildren();}}),registerInputBarAction:options=>{const action={...options,onClick(handler){this.click=handler;},destroy(){if(toolbarActions.get(options.id)===action)toolbarActions.delete(options.id);}};toolbarActions.set(options.id,action);return action;},
      registerDomDecorator:options=>{decorationCleanup=options.render(footer,{messageId:message.id});return decorationCleanup;}},
    onBackendMessage:fn=>{backend=fn;return()=>backend=null;},sendToBackend:request=>{
      requests.push(structuredClone(request));if(request.action==='cancel')return;
      setTimeout(()=>{
        if(!backend)return;
        if(request.action==='plan' && state.held || request.action==='designVoice' && state.holdDesignVoice || request.action==='freesound' && state.holdFoley || request.action==='sfx' && state.holdSfx){heldPlans.push(request);return;}
        if(request.action==='plan' && state.failPlanAt===requests.filter(r=>r.action==='plan').length){backend({namespace:'choir',id:request.id,error:'Planner quota exhausted'});return;}
        let result;
        if(request.action==='ping')result={ready:true};
        else if(request.action==='freesound'){
          if(state.foleyError){backend({namespace:'choir',id:request.id,error:state.foleyError});return;}
          const {query,filter}=request.input,bed=filter==='duration:[10 TO 120]';
          result={results:state.noFoleyResults || query.split(' ').length>(state.foleyWords || 9)?[]:[{id:123,name:query,previewUrl:bed?`https://freesound.test/ambience.mp3?q=${encodeURIComponent(query)}`:'https://freesound.test/preview.mp3'}]};
        }
        else if(request.action==='sfx'){
          if(state.sfxError){backend({namespace:'choir',id:request.id,error:state.sfxError});return;}
          const anchored=entries=>request.input.segments.flatMap((segment,index)=>Object.entries(entries).filter(([trigger])=>segment.text.includes(trigger)).map(([trigger,query])=>({segment:index,trigger,...(query?{query}:{stop:true})})));
          result={cues:anchored({'page snapped':'page turn','glass shattered':'glass shatter'}),ambience:anchored({'Rain drummed':'rain','The tavern':'tavern crowd','Silence fell':''})};
        }
        else if(request.action==='gemini')result={base64:'AAABAA==',mimeType:'audio/L16;rate=24000'};
        else if(request.action==='testPlanner')result={provider:'Planner',model:'text-model',response:'READY'};
        else if(request.action==='planJev'){backend({namespace:'choir',id:request.id,...(state.jevInvalid?{result:{}}:{error:'Jev classification failed: The object cannot be cloned'})});return;}
        else if(request.action==='plan' && state.planForCatalogue){
          const cast=request.input.config;
          result=validatePlan({segments:speechSourceUnits(request.input.transcript).map(unit=>{
            const speaker=unit.kind==='narration'?'Narrator':unit.text.includes('Wait')?'Guard':'Mira';
            const actor=[...cast.fixed,...cast.npcs].find(actor=>actor.speaker===speaker),route=actor?.route || cast.defaultRoute;
            const voice=cast.voices.filter(voice=>voice.route===route).at(-1).id;
            return {speaker,voice,route,text:unit.text};
          })},request.input.transcript,cast);
        }
        else if(request.action==='plan')result=validatePlan({segments:speechSourceUnits(request.input.transcript).map(unit=>({
          text:unit.text,speaker:unit.kind==='narration'?'Narrator':unit.text.includes('Wait')?'Guard':'Mira',voice:unit.kind==='narration'?'n':unit.text.includes('Wait')?'g':'m',style:unit.kind==='dialogue'?'Warm':''
        }))},request.input.transcript,request.input.config);
        backend({namespace:'choir',id:request.id,result});
      },2);
    }};
  let cleanup=await setup(ctx);
  const $=name=>(root.querySelector(`[data-et="${name}"]`) || root.ownerDocument.querySelector(`[data-choir-action="${["play","pause","resumePosition"].includes(name)?"playback":name}"]`));
  const click=async(name,done)=>{$(name).click();await until(()=>done($('status').textContent));};
  const plan=async()=>{$('latest').click();await tick();await until(()=>!$('latest').disabled && ($('status').textContent.startsWith('Ready:') || $('status').textContent.includes('Saved attribution')));};
  const play=async()=>{footer.querySelector('button').click();await tick();await until(()=>$('status').textContent.includes('Playback finished'));};
  const reload=async()=>{cleanup();cleanup=await setup(ctx);};
  return {dom,state,store,requests,synthesis,audios,audioBlobs,message,events,subscriptions,toolbarActions,connections,root,footer,toolbar,$,click,plan,play,reload,async remount(){cleanup=await setup(ctx);},
    setMobile(matches){channelLayout.matches=matches;for(const listener of layoutListeners)listener();},
    releaseHeld(){for(const request of heldPlans.splice(0))backend?.({namespace:'choir',id:request.id,result:{segments:[{speaker:'Narrator',voice:'n',text:request.input.transcript,style:''}]}});},
    async close(){cleanup();await tick();URL.createObjectURL=createObjectURL;Object.assign(globalThis,original);dom.window.close();}};
}

test('the staging badge follows the installed Choir branch and unavailable branch information never breaks the drawer',async()=>{
 const h=await harness();try{
  await until(()=>!h.$('branchBadge').hidden);assert.equal(h.$('branchBadge').textContent,'Staging');
  for(const branch of ['main',null,'feature-test']){
   h.state.extensionBranch=branch;const lookups=h.state.branchLookups;await h.reload();await until(()=>h.state.branchLookups>lookups);await tick();
   assert.equal(h.$('branchBadge').hidden,true);assert.ok(h.root.querySelector('.ensemble-tts'));
  }
  h.state.extensionBranch='staging';await h.reload();await until(()=>!h.$('branchBadge').hidden);
  h.state.branchLookupFails=true;await h.reload();await tick();assert.equal(h.$('branchBadge').hidden,true);assert.ok(h.root.querySelector('.ensemble-tts'));await h.plan();
  assert.equal(h.synthesis.length,0);
 }finally{await h.close();}
});

test('autosave hides the manual save button and exposes a working retry only after storage failure',async()=>{
  const h=await harness();try{
    assert.equal(h.$('save').hidden,true);assert.equal(h.$('save').textContent,'Retry save');
    h.state.failConfigSave=true;h.$('prefetch').value='2';h.$('prefetch').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
    await until(()=>h.$('saveState').textContent.includes('Save failed'));assert.equal(h.$('save').hidden,false);
    h.state.failConfigSave=false;await h.click('save',text=>text.includes('retention saved'));
    assert.equal(h.store.get('chat:chat-a').prefetch,2);assert.equal(h.$('save').hidden,true);
    h.$('chunk').value='10001';h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
    assert.equal(h.$('save').hidden,true);assert.match(h.$('saveState').textContent,/Not saved/);
  }finally{await h.close();}
});

const configureFoley=async(h,key='test-freesound-key')=>{h.$('freesoundApiKey').value=key;h.$('freesoundApiKey').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');};
const playedFoley=async h=>(await Promise.all(h.audioBlobs.map(blob=>blob.text()))).filter(text=>text==='FREESOUND_PREVIEW').length;

test('captured defaults stay stable across chats and carry lead voices by role with fresh character identities',async()=>{
 for(const mode of ['one','several']){
  const h=await harness();try{
   h.$('connectionMode').value=mode;h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('saveState').textContent==='Settings saved');
   h.$('planner').value='planner';h.$('chunk').value='8000';h.$('enableSfx').checked=false;h.$('normalizeLoudness').checked=false;h.$('auto-plan').click();
   h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default captured.'));
   const preset=structuredClone(h.store.get('settings:captured-defaults'));
   assert.equal(preset.preferences.chunk,8000);assert.equal(preset.preferences.planner,'planner');assert.equal(preset.preferences.autoPlan,true);assert.equal(preset.preferences.enableSfx,false);
   assert.deepEqual(preset.leadVoices.map(actor=>actor.voice),['n','y','m']);assert.ok(!JSON.stringify(preset).includes('Mira'));assert.ok(!JSON.stringify(preset).includes('Guard'));
   const existing=structuredClone(h.store.get('chat:chat-a'));existing.chunk=9999;existing.fixed[2].speaker='Existing character';h.store.set('chat:existing',existing);
   h.$('chunk').value='1200';h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
   assert.deepEqual(h.store.get('settings:captured-defaults'),preset);
   h.state.persona={id:'persona-new',name:'Lunch'};h.state.character={name:'Laiyah'};h.state.active='chat-new';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Default setup loaded');
   assert.equal(h.$('chunk').value,'8000');assert.equal(h.$('planner').value,'planner');assert.equal(h.$('enableSfx').checked,false);assert.equal(h.$('normalizeLoudness').checked,false);
   assert.deepEqual([...h.$('fixed').children].map(row=>row.querySelector('input').value),['Narrator','Lunch','Laiyah']);
   assert.deepEqual([...h.$('fixed').querySelectorAll('[data-choir-voice]')].map(node=>node.value),['n','y','m']);assert.equal(h.$('npcs').querySelectorAll('.et-card').length,0);
   const characterVoice=h.$('fixed').children[2].querySelector('[data-choir-voice]');characterVoice.value='new';characterVoice.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
   assert.equal(mode==='one'?h.store.get('chat:chat-new').singleVoices['native:a'].Laiyah:h.store.get('chat:chat-new').fixed[2].voice,'new');
   await h.reload();assert.equal(h.$('fixed').children[2].querySelector('[data-choir-voice]').value,'new');assert.deepEqual(h.store.get('settings:captured-defaults'),preset);
   h.state.active='existing';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Saved settings restored' && h.$('fixed').children[2]?.querySelector('input').value==='Existing character');assert.equal(h.$('chunk').value,'9999');
   h.state.character={name:'Jev'};h.state.active='chat-next';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Default setup loaded');assert.equal(h.$('fixed').children[2].querySelector('input').value,'Jev');assert.equal(h.$('fixed').children[2].querySelector('[data-choir-voice]').value,'m');
   h.$('fixed').children[2].querySelector('[data-choir-voice]').value='';h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default captured.'));assert.equal(h.store.get('settings:captured-defaults').leadVoices[2].voice,'');
   h.state.character={name:'Sable'};h.state.active='chat-automatic';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Default setup loaded' && h.$('fixed').children[2]?.querySelector('input').value==='Sable');assert.equal(h.$('fixed').children[2].querySelector('[data-choir-voice]').value,'');
   assert.equal(h.synthesis.length,0);assert.equal(h.requests.filter(request=>request.action==='plan').length,0);
  }finally{await h.close();}
 }
});

test('applying a captured default restores preferences and lead voices while retaining this chat cast and independent edits',async()=>{
 for(const mode of ['one','several']){
  const h=await harness();try{
   h.$('connectionMode').value=mode;h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('saveState').textContent==='Settings saved');
   h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default captured.'));const preset=structuredClone(h.store.get('settings:captured-defaults'));
   const name=h.$('fixed').children[2].querySelector('input');name.value='Captain Mira';name.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
   const voice=h.$('fixed').children[2].querySelector('[data-choir-voice]');voice.value='new';voice.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
   h.$('chunk').value='10000';h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
   h.$('applyDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default applied'));
   assert.equal(h.$('chunk').value,'500');assert.equal(h.$('fixed').children[2].querySelector('input').value,'Captain Mira');assert.equal(h.$('fixed').children[2].querySelector('[data-choir-voice]').value,'m');
   const saved=h.store.get('chat:chat-a');assert.equal(saved.fixed[2].pronunciation,'Mira: mee-rah');assert.deepEqual(saved.fixed[2].aliases,['Captain']);assert.equal(saved.casts['native:a'][0].speaker,'Guard');assert.equal(saved.casts['native:a'][0].voice,'g');assert.deepEqual(h.store.get('settings:captured-defaults'),preset);
   await h.reload();assert.equal(h.$('fixed').children[2].querySelector('input').value,'Captain Mira');assert.equal(h.$('fixed').children[2].querySelector('[data-choir-voice]').value,'m');assert.equal(h.$('chunk').value,'500');assert.equal(h.synthesis.length,0);
   assert.equal(h.requests.filter(request=>request.action==='plan').length,0);
  }finally{await h.close();}
 }
});

test('default capture rejects invalid settings and retains the previous snapshot when storage fails',async()=>{
 const h=await harness();try{
  h.$('key').value='session-gemini-secret';h.$('jevKey').value='session-jev-secret';h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default captured.'));
  const preset=structuredClone(h.store.get('settings:captured-defaults'));assert.ok(!JSON.stringify(preset).includes('session-'));
  h.$('chunk').value='10001';h.$('captureDefaults').click();await until(()=>h.$('status').textContent.includes('whole number from'));assert.deepEqual(h.store.get('settings:captured-defaults'),preset);
  h.$('chunk').value='8000';h.state.failDefaultsSave=true;h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.includes('capture failed'));assert.deepEqual(h.store.get('settings:captured-defaults'),preset);assert.equal(h.$('captureDefaults').disabled,false);
  h.state.failDefaultsSave=false;h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default captured.'));assert.equal(h.store.get('settings:captured-defaults').preferences.chunk,8000);
 }finally{await h.close();}
});

test('applying defaults reports save failure and never changes another chat during a slow navigation',async()=>{
 const h=await harness();try{
  h.$('captureDefaults').click();await until(()=>h.$('defaultStatus').textContent.startsWith('Default captured.'));
  h.$('chunk').value='8000';h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
  h.state.failConfigSave=true;h.$('applyDefaults').click();await until(()=>h.$('defaultStatus').textContent.includes('could not be applied'));assert.match(h.$('saveState').textContent,/Save failed/);assert.equal(h.store.get('chat:chat-a').chunk,8000);
  h.state.failConfigSave=false;await h.click('save',text=>text.includes('retention saved'));assert.equal(h.store.get('chat:chat-a').chunk,500);
  h.state.configDelay=200;h.$('chunk').value='1200';h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));h.$('applyDefaults').click();
  h.state.active='chat-b';h.state.character={name:'Different character'};h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Default setup loaded');
  assert.equal(h.store.get('chat:chat-a').chunk,1200);assert.equal(h.store.has('chat:chat-b'),false);assert.equal(h.$('fixed').children[2].querySelector('input').value,'Different character');assert.equal(h.$('chunk').value,'500');assert.equal(h.synthesis.length,0);
 }finally{await h.close();}
});

test('Fish voice IDs can be assigned, described, auditioned and restored in both connection modes',async()=>{
 for(const mode of ['one','several']){
  const h=await harness();try{
   const connection=mode==='one'?h.connections[0]:h.connections[1];connection.provider='fish_audio';await h.reload();
   h.$('connectionMode').value=mode;h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));
   await until(()=>h.$('saveState').textContent==='Settings saved');
   let card=()=>h.$('fixed').children[2];
   if(mode==='several'){
    const route=card().querySelector('[data-choir-route]');route.value='native:b';route.dispatchEvent(new h.dom.window.Event('change'));
    await until(()=>h.$('status').textContent.includes('Speaker TTS connection selected'));
   }
   const voice=card().querySelector('[data-choir-voice]');voice.value='m';voice.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
   await until(()=>h.$('saveState').textContent==='Saved automatically');
   const before=h.store.get('chat:chat-a');card().querySelector('[data-choir-voice-id]').click();
   assert.equal(card().querySelector('[data-choir-voice-id-input]').value,'m');
   card().querySelector('[data-choir-voice-id-input]').value='not | a voice ID';card().querySelector('[data-choir-apply-voice-id]').click();
   await until(()=>h.$('status').textContent.includes('Enter a Fish Audio voice ID'));assert.deepEqual(h.store.get('chat:chat-a'),before);
   const id='0123456789abcdef0123456789abcdef',description='A warm, deep Irish male voice.';
   card().querySelector('[data-choir-voice-id-input]').value=` ${id} `;card().querySelector('[data-choir-voice-description]').value=description;
   card().querySelector('[data-choir-apply-voice-id]').click();await until(()=>h.$('status').textContent.startsWith('Voice ID saved'));
   assert.equal(card().querySelector('[data-choir-voice]').value,id);assert.equal(h.synthesis.length,0);
   const saved=h.store.get('chat:chat-a');assert.equal(mode==='one'?saved.singleVoices['native:a'].Mira:saved.fixed[2].voice,id);
   assert.equal(saved.extraVoices,`${id} | ${description}`);
   assert.deepEqual(saved.extraVoiceRoutes[id],[`native:${connection.id}`]);
   card().querySelector('[data-choir-preview]').click();await until(()=>h.$('status').textContent==='Audition finished.');
   assert.equal(h.synthesis[0].voice,id);assert.equal(h.synthesis[0].connectionId,connection.id);
   card().querySelector('[data-choir-voice-id]').click();assert.equal(card().querySelector('[data-choir-voice-id-input]').value,id);
   card().querySelector('[data-choir-voice-description]').value='A calm Irish storyteller.';card().querySelector('[data-choir-apply-voice-id]').click();
   await until(()=>h.$('status').textContent.startsWith('Voice ID saved'));
   assert.equal(h.store.get('chat:chat-a').extraVoices,`${id} | A calm Irish storyteller.`);
   await h.reload();assert.equal(card().querySelector('[data-choir-voice]').value,id);
   await h.plan();const casting=h.requests.filter(request=>request.action==='plan').at(-1).input.config;
   assert.equal(casting.fixed.find(actor=>actor.speaker==='Mira').voice,id);
   assert.equal(casting.voices.find(item=>item.id===id && item.route===`native:${connection.id}`).description,'A calm Irish storyteller.');
   assert.ok(casting.voices.filter(item=>item.id===id).every(item=>item.route===`native:${connection.id}`));
   if(mode==='several')assert.equal(h.$('fixed').children[0].querySelector('[data-choir-voice-id]').hidden,true);
  }finally{await h.close();}
 }
});

test('Choir chat plays Freesound preview audio at the cue, preserves speech, caches it across reload and honors the SFX toggle',async()=>{
 const h=await harness();try{
  assert.equal(h.$('enableSfx').closest('label').hidden,false);await configureFoley(h);h.message.content='She listened. The page snapped under her thumb.';
  await h.plan();await h.play();assert.equal(await playedFoley(h),1);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);assert.equal(h.state.previewFetches.length,1);
  assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);assert.equal(h.requests.find(request=>request.action==='sfx').input.segments.map(segment=>segment.text).join(' '),h.message.content);
  assert.equal(h.synthesis.map(request=>request.text).join(' '),h.message.content);assert.ok(h.synthesis.every(request=>!request.text.includes('[SFX:')));
  const sfxIndex=(await Promise.all(h.audioBlobs.map(blob=>blob.text()))).indexOf('FREESOUND_PREVIEW');
  assert.ok(Math.abs(h.audios[sfxIndex].volume/h.audios[0].volume-0.45)<0.001);assert.equal(h.$('sfxStatus').hidden,true);
  await h.reload();await h.play();assert.equal(await playedFoley(h),2);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);assert.equal(h.state.previewFetches.length,1);
  assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);
  h.$('enableSfx').checked=false;h.$('enableSfx').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
  const replay=[...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Replay');replay.click();await until(()=>h.$('status').textContent==='Replay finished.');assert.equal(await playedFoley(h),2);
  await h.play();assert.equal(await playedFoley(h),2);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);await h.reload();assert.equal(h.$('enableSfx').checked,false);
 }finally{await h.close();}
});

test('Freesound failures stay visible, continue speech, and retry without regenerating cached narration',async()=>{
 for(const failure of ['key','choice','auth','empty','preview','type']){
  const h=await harness();try{
   await configureFoley(h,failure==='key'?'':'test-freesound-key');h.message.content='The page snapped under her thumb.';
   if(failure==='choice')h.state.sfxError='Planner quota exhausted';if(failure==='auth')h.state.foleyError='Freesound HTTP 401';if(failure==='empty')h.state.noFoleyResults=true;if(failure==='preview')h.state.previewStatus=503;if(failure==='type')h.state.previewType='text/html';
   await h.plan();await h.play();assert.equal(await playedFoley(h),0);assert.equal(h.synthesis.map(request=>request.text).join(' '),h.message.content);
   assert.equal(h.requests.filter(request=>request.action==='sfx').length,failure==='key'?0:1);
   assert.match(['key','choice'].includes(failure)?h.$('sfxStatus').textContent:h.$('status').textContent,failure==='key'?/Freesound API key/:/SFX skipped/);assert.equal(h.$('sfxStatus').hidden,false);assert.match(h.$('sfxStatus').textContent,/Speech continues/);
   const generated=h.synthesis.length;h.state.sfxError=null;h.state.foleyError=null;h.state.noFoleyResults=false;h.state.previewStatus=200;h.state.previewType='audio/mpeg';if(failure==='key')await configureFoley(h);
   if(['key','choice'].includes(failure))await h.plan();
   await h.play();assert.equal(await playedFoley(h),1);assert.equal(h.synthesis.length,['key','choice'].includes(failure)?generated+2:generated);assert.equal(h.$('sfxStatus').hidden,true);
  }finally{await h.close();}
 }
});

test('replaying an older speech plan never waits for a new sound-effect LLM request',async()=>{
 const h=await harness();try{
  await h.plan();await h.play();const generated=h.synthesis.length,planned=h.requests.filter(request=>request.action==='plan').length;
  await configureFoley(h);h.state.holdSfx=true;await h.reload();
  assert.equal([...h.store].find(([key])=>key.startsWith('plan:'))[1].soundCues,false);
  await h.play();assert.equal(h.synthesis.length,generated);assert.equal(h.requests.filter(request=>request.action==='plan').length,planned);assert.equal(h.requests.filter(request=>request.action==='sfx').length,0);
  h.state.holdSfx=false;h.state.sfxError='Sound effect LLM is unavailable';await h.plan();assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);await h.play();
  assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);assert.match(h.$('sfxStatus').textContent,/Sound effect LLM is unavailable/);
  await h.reload();await h.play();assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);assert.equal(h.synthesis.length,generated);
  h.state.sfxError=null;[...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Plan').click();await until(()=>h.requests.filter(request=>request.action==='sfx').length===2 && h.$('status').textContent.startsWith('Ready:'));
  await h.play();assert.equal(h.synthesis.length,generated);assert.equal(h.requests.filter(request=>request.action==='sfx').length,2);assert.equal(h.$('sfxStatus').hidden,true);
 }finally{await h.close();}
});

test('SFX mixer switch hides its level when off, stops live effects, applies to Cue and persists after reload',async()=>{
 const h=await harness({master:0.5,channels:{SFX:{volume:0.1,mute:true}}});try{
  const level=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000001,`Expected volume ${expected}, got ${actual}`);
  h.$('showMixer').click();const mixer=document.querySelector('[data-choir-mixer]'),sfx=()=>document.querySelector('[data-choir-mixer] [data-choir-action="sfx"]');
  assert.equal(mixer.querySelector('[aria-label="SFX volume"]').value,'1');assert.equal(sfx().parentElement.className,'cm-auto-plan');assert.equal(sfx().textContent,'SFX On');
  await configureFoley(h);h.message.content='The page snapped under her thumb.';await h.plan();h.state.blockAudio=true;h.$('play').click();
  await until(()=>h.audios.length===1 && !h.audios[0].paused);const narrator=h.audios[0];assert.equal(narrator.volume,0.5);narrator.onended();
  await until(()=>h.audios.length===2 && !h.audios[1].paused);const effect=h.audios[1];level(effect.volume,0.225);
  const sfxVolume=mixer.querySelector('[aria-label="SFX volume"]');sfxVolume.value='0.4';sfxVolume.dispatchEvent(new h.dom.window.Event('input'));sfxVolume.dispatchEvent(new h.dom.window.Event('change'));level(effect.volume,0.09);assert.equal(narrator.volume,0.5);
  h.state.blockAudio=false;sfx().click();assert.equal(sfx().textContent,'SFX Off');assert.equal(sfx().getAttribute('aria-pressed'),'false');assert.equal(h.$('enableSfx').checked,false);assert.equal(mixer.querySelector('[data-kind="sfx"]'),null);
  await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(effect.paused,true);assert.equal(h.audios.at(-1).volume,0.5);
  assert.equal(mixer.querySelector('[aria-label="Narrator volume"]').value,'1');await until(()=>h.store.get('chat:chat-a').enableSfx===false);await h.reload();assert.equal(sfx().textContent,'SFX Off');
  const off=await globalThis.__CHOIR_API__.playParagraph({text:h.message.content});assert.equal(off.played,1);assert.equal(await playedFoley(h),1);
  h.$('enableSfx').checked=true;h.$('enableSfx').dispatchEvent(new h.dom.window.Event('change'));assert.equal(sfx().textContent,'SFX On');
  assert.equal(document.querySelector('[aria-label="SFX volume"]').value,'0.4');
  const cueStart=h.audios.length;const on=await globalThis.__CHOIR_API__.playParagraph({text:h.message.content});assert.equal(on.played,3);level(h.audios[cueStart+1].volume,0.09);assert.equal(h.audios[cueStart].volume,0.5);
  const generated=h.synthesis.length,searched=h.requests.filter(request=>request.action==='freesound').length;await h.play();assert.equal(h.synthesis.length,generated);assert.equal(h.requests.filter(request=>request.action==='freesound').length,searched);
 }finally{await h.close();}
});

test('mixer plans silently, plays the latest reply, filters voices by plan and retains hidden preferences',async()=>{
 const h=await harness();try{
  const mixer=document.querySelector('[data-choir-mixer]'),names=()=>[...document.querySelectorAll('[data-choir-mixer] .cm-channel[data-kind="voice"]')].map(row=>row.dataset.speaker);
  assert.deepEqual(names(),[]);assert.match(mixer.textContent,/Plan the latest reply to see its voices/);assert.equal(h.$('play').getAttribute('aria-label'),'Play latest reply');assert.equal(h.$('play').disabled,false);
  h.$('plan-latest').click();await until(()=>h.requests.filter(r=>r.action==='plan').length===1 && !h.$('latest').disabled && names().length===3);
  assert.equal(h.audios.length,0);assert.equal(h.synthesis.length,0);assert.deepEqual(names(),['Narrator','Mira','Guard']);
  const volume=mixer.querySelector('[aria-label="Mira volume"]');volume.value='0.42';volume.dispatchEvent(new h.dom.window.Event('input'));volume.dispatchEvent(new h.dom.window.Event('change'));mixer.querySelector('[aria-label="Mira silent"]').click();
  await until(()=>h.store.get('ui:mixer')?.channels.Mira.mute===true);
  h.state.messages=[h.message,{id:'latest-b',content:'Only the narrator speaks in the latest reply.',is_user:false}];h.subscriptions.get('chat.messageCount')();h.$('play').click();await until(()=>h.$('status').textContent.includes('Playback finished'));
  assert.deepEqual(names(),['Narrator']);assert.equal(h.requests.filter(r=>r.action==='plan').at(-1).input.transcript,'Only the narrator speaks in the latest reply.');assert.equal(h.synthesis.at(-1).text,'Only the narrator speaks in the latest reply.');
  h.state.messages=[h.message];await h.plan();assert.deepEqual(names(),['Narrator','Mira','Guard']);assert.equal(mixer.querySelector('[aria-label="Mira volume"]').value,'0.42');assert.equal(mixer.querySelector('[aria-label="Mira silent"]').getAttribute('aria-pressed'),'true');
  mixer.querySelector('[aria-label="Mira no voice"]').click();await tick();assert.ok(names().includes('Mira'));assert.equal(mixer.querySelector('[aria-label="Mira no voice"]').getAttribute('aria-pressed'),'true');
  await h.reload();assert.equal(document.querySelector('[aria-label="Mira volume"]').value,'0.42');assert.equal(document.querySelector('[aria-label="Mira no voice"]').getAttribute('aria-pressed'),'true');
  h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));assert.deepEqual(names(),[]);assert.equal(h.$('plan-latest').disabled,true);assert.equal(h.$('play').disabled,true);
 }finally{await h.close();}
});

test('SFX can be reenabled before its cue after prefetch skipped it, and disabling cached effects preserves pause',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.message.content='The page snapped under her thumb.';h.$('prefetch').value='1';await h.plan();h.state.delay=50;h.state.blockAudio=true;h.$('play').click();
  await until(()=>h.synthesis.length===1);h.$('sfx').click();await until(()=>h.audios[0]?.paused===false);assert.equal(h.requests.filter(request=>request.action==='freesound').length,0);h.$('sfx').click();
  h.state.blockAudio=false;h.audios[0].onended();await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(await playedFoley(h),1);
  const start=h.audios.length;h.state.blockAudio=true;const replay=[...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Replay');replay.click();await until(()=>h.audios.length===start+1 && !h.audios.at(-1).paused);h.audios.at(-1).onended();
  await until(()=>h.audios.length===start+2 && !h.audios.at(-1).paused);h.$('pause').click();assert.equal(h.audios.at(-1).paused,true);h.$('sfx').click();
  await until(()=>h.audios.length===start+3 && h.$('play').getAttribute('aria-label')==='Resume Choir audio');assert.equal(h.audios.at(-1).paused,true);h.state.blockAudio=false;h.$('play').click();await until(()=>h.$('status').textContent==='Replay finished.');
 }finally{await h.close();}
});

test('Cue and cached recordings show their own speakers rather than the previously planned reply',async()=>{
 const h=await harness();try{
  const names=()=>[...document.querySelectorAll('.cm-channel[data-kind="voice"]')].map(row=>row.dataset.speaker);
  await h.plan();await h.play();const savedPlan=[...h.store.keys()].find(key=>key.startsWith('plan:'));h.store.delete(savedPlan);
  const cue=await globalThis.__CHOIR_API__.playParagraph({text:'A separate narrated paragraph.'});assert.equal(cue.played,1);assert.deepEqual(names(),['Narrator']);
  const replay=[...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Replay');replay.click();await until(()=>h.$('status').textContent==='Replay finished.');assert.deepEqual(names(),['Narrator','Mira','Guard']);
 }finally{await h.close();}
});

test('Stop cancels Freesound search and preview downloads and late results cannot start audio',async()=>{
 for(const stage of ['search','preview']){
  const h=await harness();try{
   await configureFoley(h);h.message.content='The page snapped under her thumb.';await h.plan();
   if(stage==='search')h.state.holdFoley=true;else h.state.holdPreview=true;
   h.footer.querySelector('button').click();await until(()=>stage==='search'?h.requests.some(request=>request.action==='freesound'):h.state.previewFetches.length===1);
   h.$('stop').click();await tick();h.releaseHeld();await tick();assert.equal(h.$('status').textContent,'Stopped.');assert.equal(await playedFoley(h),0);assert.ok(h.audios.every(audio=>audio.paused));
   if(stage==='search')assert.equal(h.state.previewFetches.length,0);else assert.equal(h.state.previewAborted,1);
  }finally{await h.close();}
 }
});

test('automatic streamed Choir playback and Cue share SFX while muted narration stays silent',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.message.content='The page snapped under her thumb. "Hello." A quiet room. '.repeat(4);
  globalThis.__CHOIR_API__.setNarratorMuted(true);h.$('auto').checked=true;h.$('auto').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
  h.events.get('GENERATION_ENDED')({chatId:'chat-a',messageId:h.message.id,content:h.message.content});await until(()=>h.$('status').textContent.includes('Playback finished') && !h.$('latest').disabled);
  assert.equal(await playedFoley(h),4);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);assert.ok(h.synthesis.every(request=>request.text.includes('Hello')));
  const bridge=globalThis.__CHOIR_API__,before=h.requests.filter(request=>request.action==='freesound').length,played=await playedFoley(h);
  assert.equal(bridge.getConfig().enableSfx,true);assert.equal(bridge.planParagraph('The page snapped under her thumb.').segments.filter(segment=>segment.kind==='sfx').length,4);
  const result=await bridge.playParagraph({text:'The page snapped under her thumb.',chatId:'chat-a'});assert.equal(result.played,4);assert.equal(await playedFoley(h),played+4);assert.equal(h.requests.filter(request=>request.action==='freesound').length,before);
  bridge.setNarratorMuted(false);const speechBefore=h.synthesis.length;
  await bridge.playParagraph({text:'The page snapped under her thumb.',chatId:'chat-a'});assert.ok(h.synthesis.length>speechBefore);assert.equal(h.requests.filter(request=>request.action==='freesound').length,before);
  h.$('enableSfx').checked=false;h.$('enableSfx').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
  const effectsBefore=await playedFoley(h);assert.ok(bridge.planParagraph('The page snapped under her thumb.').segments.every(segment=>segment.kind!=='sfx'));
  await bridge.playParagraph({text:'The page snapped under her thumb.',chatId:'chat-a'});assert.equal(await playedFoley(h),effectsBefore);
 }finally{await h.close();}
});

test('Cue fetches real preview blobs, retries failed SFX and honors companion cancellation',async()=>{
 const h=await harness();try{
  await configureFoley(h);const bridge=globalThis.__CHOIR_API__,text='The page snapped under her thumb.';
  h.state.foleyError='Freesound HTTP 401';const statuses=[];
  const failed=await bridge.playParagraph({text,onStatus:status=>statuses.push(status)});assert.equal(failed.played,2);assert.match(failed.warnings[0],/401/);assert.equal(await playedFoley(h),0);assert.match(statuses.at(-1).message,/SFX skipped/);
  h.state.foleyError=null;const result=await bridge.playParagraph({text});assert.equal(result.played,3);assert.equal(await playedFoley(h),1);assert.equal(h.state.previewFetches.length,1);assert.equal(h.synthesis.length,2);
  await bridge.playParagraph({text});assert.equal(await playedFoley(h),2);assert.equal(h.requests.filter(request=>request.action==='freesound').length,2);
  const ctrl=new AbortController();ctrl.abort();const searches=h.requests.length;await assert.rejects(bridge.playParagraph({text,signal:ctrl.signal}),{name:'AbortError'});assert.equal(h.requests.length,searches);
  h.state.holdPreview=true;const pendingCtrl=new AbortController();const pending=bridge.playParagraph({text:'The glass shattered.',signal:pendingCtrl.signal});const stopped=assert.rejects(pending,{name:'AbortError'});
  await until(()=>h.state.previewFetches.length===2);pendingCtrl.abort();await stopped;assert.equal(h.state.previewAborted,1);assert.equal(await playedFoley(h),2);assert.ok(h.audios.every(audio=>audio.paused));
 }finally{await h.close();}
});

const beds=h=>h.audios.filter(audio=>audio.loop),voices=h=>h.audios.filter(audio=>!audio.loop);
const bedName=(h,audio)=>h.audioBlobs[h.audios.indexOf(audio)].text();
const scene='Night fell. Rain drummed on the roof. "Hello." The tavern door swung open. "Wait."';
const toggle=async(h,name,checked)=>{h.$(name).checked=checked;h.$(name).dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');};

test('volume buttons and percent entry change live playback, clamp values, tolerate blank edits and retain all levels after reload',async()=>{
 const h=await harness();try{
  await h.plan();h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios[0]?.paused===false);
  const find=label=>document.querySelector(`[aria-label="${label}"]`),number=name=>find(`${name} volume percent`),range=name=>find(`${name} volume`);
  const type=(name,value)=>{const input=number(name);input.value=value;input.dispatchEvent(new h.dom.window.Event('input'));};
  find('Decrease Master volume').click();assert.equal(number('Master').value,'95');assert.equal(h.audios[0].volume,0.95);
  type('Master','37');assert.equal(range('Master').value,'0.37');assert.equal(h.audios[0].volume,0.37);
  type('Master','');assert.equal(h.audios[0].volume,0.37);number('Master').dispatchEvent(new h.dom.window.Event('blur'));assert.equal(number('Master').value,'37');
  type('Master','150');assert.equal(number('Master').value,'100');assert.equal(find('Increase Master volume').disabled,true);
  type('Master','-4');assert.equal(number('Master').value,'0');assert.equal(find('Decrease Master volume').disabled,true);assert.equal(h.audios[0].volume,0);
  type('Master','80');type('Narrator','25');assert.equal(h.audios[0].volume,0.2);type('SFX','43');type('Ambience','61');assert.equal(h.audios[0].volume,0.2);
  find('Increase SFX volume').click();assert.equal(number('SFX').value,'48');
  const desktop=range('Ambience');desktop.value='0.32';desktop.dispatchEvent(new h.dom.window.Event('input'));desktop.dispatchEvent(new h.dom.window.Event('change'));assert.equal(number('Ambience').value,'32');
  await until(()=>h.store.get('ui:mixer')?.ambience===0.32 && h.store.get('ui:mixer')?.sfx===0.48);h.$('stop').click();await h.reload();
  assert.equal(number('Master').value,'80');assert.equal(number('Narrator').value,'25');assert.equal(number('SFX').value,'48');assert.equal(number('Ambience').value,'32');
 }finally{await h.close();}
});

test('compact mute and skip icons remain distinct, accessible and reversible without losing percent entries',async()=>{
 const h=await harness();try{
  await h.plan();const get=kind=>document.querySelector(`[aria-label="Mira ${kind}"]`),mute=get('silent'),skip=get('no voice');
  assert.equal(mute.textContent,'');assert.equal(skip.textContent,'');assert.equal(mute.querySelectorAll('svg').length,1);assert.equal(skip.querySelectorAll('svg').length,1);assert.notEqual(mute.innerHTML,skip.innerHTML);
  const unmuted=mute.innerHTML,enabled=skip.innerHTML;mute.click();assert.equal(get('silent').getAttribute('aria-pressed'),'true');assert.notEqual(get('silent').innerHTML,unmuted);
  get('no voice').click();await until(()=>get('no voice').getAttribute('aria-pressed')==='true');assert.notEqual(get('no voice').innerHTML,enabled);
  get('silent').click();get('no voice').click();await until(()=>get('no voice').getAttribute('aria-pressed')==='false');assert.equal(get('silent').innerHTML,unmuted);assert.equal(get('no voice').innerHTML,enabled);
  assert.equal(document.querySelector('[aria-label="Mira volume percent"]').value,'100');
 }finally{await h.close();}
});

test('mobile channel tabs show one panel, keep selection through playback and reload, and retain independent levels',async()=>{
 const h=await harness(undefined,true);try{
  h.$('showMixer').click();await h.plan();document.querySelector('[aria-label="Channel levels"]').click();
  const tabs=()=>[...document.querySelectorAll('.cm-channel-tab')],tab=name=>tabs().find(item=>item.textContent===name),visible=()=>[...document.querySelectorAll('.cm-channel')].filter(row=>!row.hidden);
  assert.deepEqual(tabs().map(item=>item.textContent),['Narrator','Mira','Guard','SFX','Ambience']);assert.deepEqual(visible().map(row=>row.dataset.speaker),['Narrator']);
  tab('Mira').click();assert.equal(tab('Mira').getAttribute('aria-selected'),'true');assert.equal(visible().length,1);assert.equal(visible()[0].id,tab('Mira').getAttribute('aria-controls'));assert.equal(visible()[0].getAttribute('aria-labelledby'),tab('Mira').id);
  const percent=document.querySelector('[aria-label="Mira volume percent"]');percent.value='42';percent.dispatchEvent(new h.dom.window.Event('input'));document.querySelector('[aria-label="Mira silent"]').click();
  assert.deepEqual(visible().map(row=>row.dataset.speaker),['Mira']);assert.equal(document.querySelector('[aria-label="Mira volume percent"]').value,'42');
  h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios[0]?.paused===false);assert.deepEqual(visible().map(row=>row.dataset.speaker),['Mira']);assert.equal(h.audios[0].volume,1);h.$('stop').click();
  await until(()=>h.store.get('ui:mixer')?.channelTab==='voice:Mira');await h.reload();assert.deepEqual(visible().map(row=>row.dataset.speaker),['Mira']);assert.equal(document.querySelector('[aria-label="Mira silent"]').getAttribute('aria-pressed'),'true');
  tab('SFX').click();const effects=document.querySelector('[aria-label="SFX volume percent"]');effects.value='31';effects.dispatchEvent(new h.dom.window.Event('input'));
  tab('Mira').click();assert.equal(document.querySelector('[aria-label="Mira volume percent"]').value,'42');assert.equal(document.querySelector('[aria-label="SFX volume percent"]').value,'31');
 }finally{await h.close();}
});

test('mobile tabs support arrow keys and safe fallback when a selected sound or voice disappears, and resize back to a list',async()=>{
 const h=await harness(undefined,true);try{
  await h.plan();const tabs=()=>[...document.querySelectorAll('.cm-channel-tab')],selected=()=>tabs().find(tab=>tab.getAttribute('aria-selected')==='true'),visible=()=>[...document.querySelectorAll('.cm-channel')].filter(row=>!row.hidden);
  selected().dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(selected().textContent,'Mira');assert.equal(document.activeElement,selected());
  selected().dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true}));assert.equal(selected().textContent,'Ambience');assert.equal(tabs().filter(tab=>tab.tabIndex===0).length,1);
  h.$('ambience').click();assert.ok(!tabs().some(tab=>tab.textContent==='Ambience'));assert.equal(selected().textContent,'Narrator');assert.equal(visible().length,1);
  tabs().find(tab=>tab.textContent==='SFX').click();h.$('sfx').click();assert.ok(!tabs().some(tab=>tab.textContent==='SFX'));assert.equal(selected().textContent,'Narrator');
  tabs().find(tab=>tab.textContent==='Mira').click();h.message.content='Only narration remains.';await h.plan();assert.equal(selected().textContent,'Narrator');assert.equal(visible().length,1);
  h.setMobile(false);assert.equal(document.querySelector('.cm-channel-tabs').hidden,true);assert.equal(document.querySelector('[role="tabpanel"]'),null);assert.equal(visible().length,1);
  h.message.content='At dawn. "Hello." "Wait."';await h.plan();assert.equal(visible().length,3);h.setMobile(true);assert.equal(document.querySelector('.cm-channel-tabs').hidden,false);assert.equal(visible().length,1);
 }finally{await h.close();}
});

test('Channel levels collapse independently, persist their state and hide disabled sound levels while retaining voice controls',async()=>{
 const h=await harness();try{
  h.$('showMixer').click();const mixer=()=>document.querySelector('[data-choir-mixer]'),menu=()=>mixer().querySelector('[aria-label="Channel levels"]'),body=()=>mixer().querySelector('.cm-levels-body');
  assert.equal(menu().getAttribute('aria-expanded'),'false');assert.equal(body().hidden,true);assert.equal(mixer().querySelector('[aria-label="Master volume"]').closest('.cm-levels-body'),null);
  menu().click();assert.equal(menu().getAttribute('aria-expanded'),'true');assert.equal(body().hidden,false);await until(()=>h.store.get('ui:mixer')?.levelsCollapsed===false);
  await h.plan();assert.deepEqual([...mixer().querySelectorAll('.cm-channel')].map(row=>row.dataset.speaker),['Narrator','Mira','Guard','SFX','Ambience']);
  h.$('ambience').click();assert.equal(h.$('ambience').textContent,'Ambience Off');assert.equal(h.$('ambience').getAttribute('aria-pressed'),'false');assert.equal(h.$('enableAmbience').checked,false);assert.equal(mixer().querySelector('[data-kind="ambience"]'),null);
  h.$('sfx').click();assert.equal(mixer().querySelector('[data-kind="sfx"]'),null);assert.equal(mixer().querySelectorAll('.cm-channel[data-kind="voice"]').length,3);assert.equal(menu().getAttribute('aria-expanded'),'true');
  await until(()=>h.$('saveState').textContent==='Saved automatically');await h.reload();assert.equal(menu().getAttribute('aria-expanded'),'true');assert.equal(body().hidden,false);assert.equal(h.$('ambience').textContent,'Ambience Off');assert.equal(mixer().querySelector('[data-kind="ambience"]'),null);
  await toggle(h,'enableAmbience',true);assert.equal(h.$('ambience').textContent,'Ambience On');assert.equal(mixer().querySelector('[aria-label="Ambience volume"]').value,'1');
  menu().click();await until(()=>h.store.get('ui:mixer')?.levelsCollapsed===true);await h.reload();assert.equal(body().hidden,true);assert.equal(menu().getAttribute('aria-expanded'),'false');
 }finally{await h.close();}
});

test('mixer Ambience toggle stops the carried loop, keeps speech playing and remembers Off after reload',async()=>{
 const h=await harness();try{
  await configureFoley(h);const bridge=globalThis.__CHOIR_API__;h.state.blockAudio=true;
  const paragraph=bridge.playParagraph({text:'Rain drummed on the roof.'});await until(()=>beds(h).length===1 && !beds(h)[0].paused && voices(h).length===1 && !voices(h)[0].paused);
  h.$('ambience').click();assert.equal(beds(h)[0].paused,true);assert.equal(voices(h)[0].paused,false);assert.equal(document.querySelector('[data-kind="ambience"]'),null);
  h.state.blockAudio=false;voices(h)[0].onended();assert.equal((await paragraph).played,1);await until(()=>h.store.get('chat:chat-a').enableAmbience===false);
  await h.reload();assert.equal(h.$('ambience').textContent,'Ambience Off');assert.equal(document.querySelector('[aria-label="Ambience volume"]'),null);
 }finally{await h.close();}
});

test('turning Ambient sound off stops a carried Cue bed and prevents later beds without interrupting speech',async()=>{
 const h=await harness();try{
  await configureFoley(h);const bridge=globalThis.__CHOIR_API__;
  await bridge.playParagraph({text:'Rain drummed on the roof.'});await until(()=>beds(h).length===1 && !beds(h)[0].paused);
  await toggle(h,'enableAmbience',false);assert.equal(beds(h)[0].paused,true);
  assert.equal((await bridge.playParagraph({text:'The tavern was full.'})).played,1);assert.equal(beds(h).length,1);
  await toggle(h,'enableAmbience',true);await bridge.playParagraph({text:'The tavern was full.'});await until(()=>beds(h).length===2 && !beds(h)[1].paused);
 }finally{await h.close();}
});

test('Ambient sound off stops both crossfading beds while speech continues and no later marker restarts them',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.message.content=scene;await h.plan();h.state.blockAudio=true;h.$('play').click();
  await until(()=>voices(h).length===1 && !voices(h)[0].paused);voices(h)[0].onended();
  await until(()=>beds(h).length===1 && !beds(h)[0].paused && voices(h).length===2);voices(h)[1].onended();
  await until(()=>voices(h).length===3 && !voices(h)[2].paused);voices(h)[2].onended();
  await until(()=>beds(h).length===2 && beds(h).every(audio=>!audio.paused) && voices(h).length===4);
  await toggle(h,'enableAmbience',false);assert.ok(beds(h).every(audio=>audio.paused));assert.equal(voices(h)[3].paused,false);
  h.state.blockAudio=false;voices(h)[3].onended();await until(()=>h.$('status').textContent.includes('Playback finished'));
  assert.equal(beds(h).length,2);assert.ok(beds(h).every(audio=>audio.paused));
 }finally{await h.close();}
});

test('Ambient sound off prevents a late bed download from starting and reenabling can retry it',async()=>{
 const h=await harness();try{
  await configureFoley(h);const bridge=globalThis.__CHOIR_API__;h.state.holdBeds=true;
  await bridge.playParagraph({text:'Rain drummed on the roof.'});await until(()=>h.state.releaseBed);
  await toggle(h,'enableAmbience',false);h.state.holdBeds=false;h.state.releaseBed();await tick();assert.equal(beds(h).length,0);
  await toggle(h,'enableAmbience',true);await bridge.playParagraph({text:'Rain drummed on the roof.'});await until(()=>beds(h).length===1 && !beds(h)[0].paused);
 }finally{h.state.releaseBed?.();await h.close();}
});

test('ambience beds start at their anchor, loop under speech, crossfade, follow pause and fade out at the end',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.message.content=scene;await h.plan();assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);
  h.state.blockAudio=true;h.$('play').click();
  await until(()=>voices(h).length===1 && !voices(h)[0].paused);assert.equal(beds(h).length,0);assert.equal(h.synthesis[0].text,'Night fell.');voices(h)[0].onended();
  await until(()=>beds(h).length===1 && !beds(h)[0].paused && voices(h).length===2);const rain=beds(h)[0];
  assert.equal(await bedName(h,rain),'AMBIENCE:rain');assert.match(h.synthesis[1].text,/^Rain drummed/);await until(()=>rain.volume===0.25);
  voices(h)[1].onended();await until(()=>voices(h).length===3 && !voices(h)[2].paused);assert.equal(beds(h).length,1);assert.equal(rain.paused,false);
  voices(h)[2].onended();await until(()=>beds(h).length===2 && !beds(h)[1].paused);const tavern=beds(h)[1];
  assert.equal(await bedName(h,tavern),'AMBIENCE:tavern crowd');await until(()=>rain.volume<0.2);assert.equal(rain.paused,false);
  await until(()=>rain.paused);await until(()=>tavern.volume===0.25);
  h.$('pause').click();assert.equal(voices(h)[3].paused,true);assert.equal(tavern.paused,true);
  h.$('pause').click();assert.equal(voices(h)[3].paused,false);assert.equal(tavern.paused,false);
  h.state.blockAudio=false;voices(h)[3].onended();await until(()=>h.$('status').textContent.includes('Playback finished'));
  assert.equal(tavern.paused,false);await until(()=>tavern.paused);assert.equal(h.$('stop').disabled,true);
  assert.equal(h.state.bedFetches.length,2);assert.deepEqual(h.requests.filter(request=>request.action==='freesound').map(request=>request.input.filter),['duration:[10 TO 120]','duration:[10 TO 120]']);
  assert.equal(h.synthesis.map(request=>request.text.replace(/^\[Calm\]\s*/,'')).join(' '),scene);
 }finally{await h.close();}
});

test('saved beds survive reload, replay from the recording, follow Next, Previous, Stop and resume, and honor the persisted Ambient sound toggle',async()=>{
 const h=await harness();try{
  const replay=async()=>{[...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Replay').click();await until(()=>h.$('status').textContent==='Replay finished.');};
  await configureFoley(h);h.message.content=scene;await h.plan();await h.play();await until(()=>beds(h).every(audio=>audio.paused));
  await h.reload();const searches=h.requests.filter(request=>request.action==='freesound').length,generated=h.synthesis.length,start=beds(h).length;
  await replay();assert.deepEqual(await Promise.all(beds(h).slice(start).map(audio=>bedName(h,audio))),['AMBIENCE:rain','AMBIENCE:tavern crowd']);await until(()=>beds(h).every(audio=>audio.paused));
  const ready=()=>until(()=>!h.$('next').disabled && voices(h).at(-1).paused===false),newBeds=()=>beds(h).slice(start+2);
  const playing=async(count,name)=>{await until(()=>newBeds().length===count && !newBeds().at(-1).paused);assert.equal(await bedName(h,newBeds().at(-1)),name);await ready();};
  h.state.blockAudio=true;h.$('play').click();await ready();assert.equal(newBeds().length,0);
  h.$('next').click();await playing(1,'AMBIENCE:rain');h.$('next').click();await until(()=>/Speaking: Mira/.test(document.querySelector('[data-choir-mixer]').textContent));await ready();assert.equal(newBeds().length,1);
  h.$('next').click();await playing(2,'AMBIENCE:tavern crowd');h.$('previous').click();await playing(3,'AMBIENCE:rain');
  h.$('stop').click();assert.ok(beds(h).every(audio=>audio.paused));h.$('play').click();await playing(4,'AMBIENCE:rain');assert.match(document.querySelector('[data-choir-mixer]').textContent,/Speaking: Mira/);
  h.$('stop').click();assert.ok(beds(h).every(audio=>audio.paused));assert.equal(h.requests.filter(request=>request.action==='freesound').length,searches);assert.equal(h.synthesis.length,generated);
  h.state.blockAudio=false;await toggle(h,'enableAmbience',false);const silent=beds(h).length;await h.play();await replay();assert.equal(beds(h).length,silent);
  await h.reload();assert.equal(h.$('enableAmbience').checked,false);assert.equal(h.store.get('chat:chat-a').enableAmbience,false);
 }finally{await h.close();}
});

test('Ambience slider sets bed level live without touching speech and persists after reload',async()=>{
 const h=await harness();try{
  h.$('showMixer').click();assert.equal(document.querySelector('[data-speaker="Ambience"]').dataset.kind,'ambience');
  await configureFoley(h);h.message.content='Rain drummed on the roof. "Hello."';await h.plan();h.state.blockAudio=true;h.$('play').click();
  await until(()=>beds(h).length===1 && beds(h)[0].volume===0.25);const rain=beds(h)[0],speech=voices(h)[0];
  const volume=document.querySelector('[aria-label="Ambience volume"]');volume.value='0.4';volume.dispatchEvent(new h.dom.window.Event('input'));volume.dispatchEvent(new h.dom.window.Event('change'));
  assert.ok(Math.abs(rain.volume-0.1)<0.000001);assert.equal(speech.volume,1);
  await until(()=>h.store.get('ui:mixer')?.ambience===0.4);h.$('stop').click();await h.reload();
  assert.equal(document.querySelector('[aria-label="Ambience volume"]').value,'0.4');
  h.$('play').click();await until(()=>beds(h).length===2 && beds(h)[1].volume>0);assert.ok(beds(h)[1].volume<=0.1+0.000001);
 }finally{await h.close();}
});

test('Cue keeps a bed across paragraphs until a stop entry, stop() or cancellation, and a failed bed never blocks speech',async()=>{
 const h=await harness();try{
  await configureFoley(h);const bridge=globalThis.__CHOIR_API__;
  assert.equal((await bridge.playParagraph({text:'Rain drummed on the roof.',chatId:'chat-a'})).played,1);await until(()=>beds(h).length===1 && !beds(h)[0].paused);const rain=beds(h)[0];
  assert.equal((await bridge.playParagraph({text:'"Hello."',chatId:'chat-a'})).played,1);assert.equal(rain.paused,false);assert.equal(beds(h).length,1);assert.equal(h.$('stop').disabled,false);
  await bridge.playParagraph({text:'Silence fell over the hall.',chatId:'chat-a'});assert.equal(rain.paused,false);await until(()=>rain.paused);
  await bridge.playParagraph({text:'Rain drummed again.'});await until(()=>beds(h).length===2 && !beds(h)[1].paused);bridge.stop();assert.ok(beds(h).every(audio=>audio.paused));
  h.state.blockAudio=true;const ctrl=new AbortController(),pending=bridge.playParagraph({text:'Rain drummed once more.',signal:ctrl.signal});
  await until(()=>beds(h).length===3 && !beds(h)[2].paused);ctrl.abort();await assert.rejects(pending,{name:'AbortError'});assert.ok(h.audios.every(audio=>audio.paused));
  h.state.blockAudio=false;h.state.noFoleyResults=true;assert.equal((await bridge.playParagraph({text:'The tavern was full.'})).played,1);
  await until(()=>/SFX skipped: No Freesound result for "tavern crowd"/.test(h.$('sfxStatus').textContent));assert.equal(beds(h).length,3);
  assert.deepEqual(h.requests.filter(request=>request.action==='freesound').map(request=>request.input.query).slice(-2),['tavern crowd','tavern']);
 }finally{await h.close();}
});

test('ambience playback and decode failures stay visible, keep speech running and allow a later paragraph to retry',async()=>{
 for(const failure of ['start','decode','resume']){
  const h=await harness();let pending;try{
   await configureFoley(h);h.state.blockAudio=true;
   h.state.bedPlayError=failure==='start';h.state.bedDecodeError=failure==='decode';
   const bridge=globalThis.__CHOIR_API__,text='Rain drummed on the roof.';
   pending=bridge.playParagraph({text}).then(result=>({result}),error=>({error}));
   await until(()=>beds(h).length===1 && voices(h).length===1 && !voices(h)[0].paused);
   if(failure==='resume'){h.$('play').click();await until(()=>voices(h)[0].paused);h.state.bedPlayError=true;h.$('play').click();}
   await until(()=>h.$('sfxStatus').textContent.includes('Ambience skipped'));
   assert.match(h.$('sfxStatus').textContent,/rain/);assert.match(h.$('sfxStatus').textContent,failure==='decode'?/decode/i:/blocked/i);
   assert.equal(h.$('sfxStatus').hidden,false);assert.equal(voices(h)[0].paused,false);assert.equal(beds(h)[0].paused,true);
   h.state.bedPlayError=false;h.state.bedDecodeError=false;h.state.blockAudio=false;
   assert.equal((await bridge.playParagraph({text})).played,1);assert.equal((await pending).error?.name,'AbortError');
   await until(()=>beds(h).length===2 && !beds(h)[1].paused);assert.equal(h.$('sfxStatus').hidden,true);
  }finally{await h.close();await pending;}
 }
});

test('one sound request serves both toggles and none is made with both off',async()=>{
 const h=await harness();try{
  await configureFoley(h);await toggle(h,'enableSfx',false);h.message.content='Rain drummed. The page snapped under her thumb.';
  await h.plan();assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);await h.play();assert.equal(beds(h).length,1);assert.equal(await playedFoley(h),0);
  await toggle(h,'enableSfx',true);await toggle(h,'enableAmbience',false);await h.play();assert.equal(beds(h).length,1);assert.equal(await playedFoley(h),1);
  await toggle(h,'enableSfx',false);await h.plan();await h.play();assert.equal(h.requests.filter(request=>request.action==='sfx').length,1);assert.equal(h.$('sfxStatus').hidden,true);
 }finally{await h.close();}
});

test('Freesound searches drop trailing words until a sound matches',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.state.foleyWords=1;h.message.content='The page snapped under her thumb.';await h.plan();await h.play();
  assert.equal(await playedFoley(h),1);assert.deepEqual(h.requests.filter(request=>request.action==='freesound').map(request=>request.input.query),['page turn','page']);
 }finally{await h.close();}
});

test('each Freesound search carries the story moment at its anchor, its sound kind and the Decision connection',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.$('decisionConnection').value='decision-b';h.$('decisionConnection').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
  await until(()=>h.store.get('chat:chat-a').decisionConnection==='decision-b');
  h.message.content='Rain drummed on the roof while the old clock ticked, the candles burned low and she listened until the page snapped under her thumb.';await h.plan();await h.play();
  const searches=h.requests.filter(request=>request.action==='freesound').map(({input})=>({query:input.query,kind:input.kind,moment:input.moment,decisionConnection:input.decisionConnection}));
  assert.deepEqual(searches.sort((a,b)=>a.query.localeCompare(b.query)),[
   {query:'page turn',kind:'sfx',moment:'k ticked, the candles burned low and she listened until the page snapped under her thumb.',decisionConnection:'decision-b'},
   {query:'rain',kind:'ambience',moment:h.message.content,decisionConnection:'decision-b'}]);
 }finally{await h.close();}
});

test('mixer Auto-plan is opt-in, persists, reuses cached plans, and never automatically starts TTS',async()=>{
  const h=await harness();try{
    const event=()=>h.events.get('GENERATION_ENDED')({chatId:'chat-a',messageId:h.message.id,content:h.message.content});
    event();await tick();assert.equal(h.requests.length,0);
    h.$('showMixer').click();h.$('auto-plan').click();assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'true');
    event();await until(()=>h.$('status').textContent.startsWith('Ready:') && !h.$('latest').disabled);
    assert.equal(h.requests.filter(request=>request.action==='plan').length,1);assert.equal(h.synthesis.length,0);assert.equal(h.audios.length,0);
    event();await until(()=>h.$('status').textContent==='Saved attribution reused.');assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
    await h.reload();assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'true');assert.equal(h.$('auto').checked,false);
    h.message.content='A fresh reply.';event();await until(()=>h.requests.filter(request=>request.action==='plan').length===2 && !h.$('latest').disabled);
    assert.equal(h.synthesis.length,0);h.$('auto-plan').click();await until(()=>h.$('saveState').textContent==='Saved automatically');
    h.message.content='Another reply.';event();await tick();assert.equal(h.requests.filter(request=>request.action==='plan').length,2);
  }finally{await h.close();}
});

test('Auto-plan toolbar visibility and mixer state stay synchronized through reload and teardown',async()=>{
  const h=await harness();try{
    assert.equal(h.toolbarActions.has('choir_auto_plan'),false);
    assert.equal(h.toolbar.childElementCount,0);
    h.$('showAutoPlanAction').checked=true;h.$('showAutoPlanAction').dispatchEvent(new h.dom.window.Event('change'));
    await until(()=>h.$('saveState').textContent==='Saved automatically');assert.equal(h.toolbarActions.get('choir_auto_plan').label,'Auto-plan Off');
    const shortcut=h.toolbar.querySelector('button');assert.ok(shortcut);assert.equal(shortcut.textContent,'Auto-plan Off');assert.equal(shortcut.getAttribute('aria-pressed'),'false');
    shortcut.click();assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'true');assert.equal(h.toolbarActions.get('choir_auto_plan').label,'Auto-plan On');assert.equal(shortcut.textContent,'Auto-plan On');assert.equal(shortcut.getAttribute('aria-pressed'),'true');
    await until(()=>h.$('saveState').textContent==='Saved automatically');await h.reload();
    assert.equal(h.$('showAutoPlanAction').checked,true);assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'true');assert.equal(h.toolbarActions.get('choir_auto_plan').label,'Auto-plan On');
    assert.equal(h.toolbar.childElementCount,1);assert.equal(h.toolbar.querySelector('button').getAttribute('aria-pressed'),'true');
    h.$('auto-plan').click();assert.equal(h.toolbarActions.get('choir_auto_plan').label,'Auto-plan Off');
    assert.equal(h.toolbar.querySelector('button').textContent,'Auto-plan Off');assert.equal(h.toolbar.querySelector('button').getAttribute('aria-pressed'),'false');
    await h.toolbarActions.get('choir_auto_plan').click();assert.equal(h.toolbar.querySelector('button').getAttribute('aria-pressed'),'true');assert.equal(h.toolbar.childElementCount,1);
    await until(()=>h.$('saveState').textContent==='Saved automatically');
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Connection preferences restored');
    assert.equal(h.toolbar.childElementCount,1);assert.equal(h.toolbar.querySelector('button').getAttribute('aria-pressed'),'true');
    h.toolbar.querySelector('button').click();await until(()=>h.$('saveState').textContent==='Saved automatically');assert.equal(h.store.get('chat:chat-b').autoPlan,false);
    h.state.active='chat-a';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Saved settings restored');
    assert.equal(h.toolbar.querySelector('button').getAttribute('aria-pressed'),'true');assert.equal(h.synthesis.length,0);
    h.$('showAutoPlanAction').checked=false;h.$('showAutoPlanAction').dispatchEvent(new h.dom.window.Event('change'));assert.equal(h.toolbarActions.has('choir_auto_plan'),false);
    assert.equal(h.toolbar.childElementCount,0);assert.equal(h.dom.window.document.querySelector('nav > button').textContent,'Another extension');
    await until(()=>h.$('saveState').textContent==='Saved automatically');await h.reload();assert.equal(h.toolbarActions.has('choir_auto_plan'),false);
    assert.equal(h.toolbar.childElementCount,0);h.$('showAutoPlanAction').checked=true;h.$('showAutoPlanAction').dispatchEvent(new h.dom.window.Event('change'));assert.equal(h.toolbar.childElementCount,1);
  }finally{await h.close();assert.equal(h.toolbarActions.size,0);assert.equal(h.toolbar.childElementCount,0);}
});

test('WebSocket completion metadata cannot make Auto-plan or Auto-play wait for an already published reply',async()=>{
 for(const mode of ['auto-plan','auto-play']){
  const h=await harness();try{
   h.$(mode).click();
   const event={generationId:`websocket-${mode}`,chatId:'chat-a',messageId:h.message.id,content:h.message.content};
   const metadata={stateRevision:{epoch:'server-session',sequence:42},runtimeMutationId:'saved-reply'};
   // Lumiverse forwards the WebSocket callback's second argument to extensions.
   h.events.get('GENERATION_ENDED')(event,metadata);
   await until(()=>h.$('status').textContent.includes(mode==='auto-play'?'Playback finished':'Ready:') && !h.$('latest').disabled);
   assert.equal(h.state.canonicalReads || 0,0);assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
   assert.equal(h.synthesis.length>0,mode==='auto-play');
   h.events.get('GENERATION_ENDED')(event,metadata);await new Promise(resolve=>setTimeout(resolve,150));
   assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
  }finally{await h.close();}
 }
});

test('automatic planning recovers missed completion events and waits for the saved swipe before planning',async()=>{
 for(const playing of [false,true]){
  const h=await harness();try{
   h.$(playing?'auto-play':'auto-plan').click();
   const original=h.message.content,completed='The saved reply arrived. "Hello."';
   h.state.savedMessages=[{...h.message,content:completed,swipes:[original,completed],swipe_id:1}];
   const event={generationId:'metrics-fallback',chatId:'chat-a',messageId:h.message.id,swipeId:1};
   h.events.get('GENERATION_METRICS_READY')(event,{stateRevision:{epoch:'server-session',sequence:42}});await until(()=>h.$('status').textContent.includes('Waiting for the completed reply'));
   assert.equal(h.requests.filter(request=>request.action==='plan').length,0);assert.equal(h.synthesis.length,0);
   h.message.content=completed;h.message.swipe_id=1;
   await until(()=>h.$('status').textContent.includes(playing?'Playback finished':'Ready:') && !h.$('latest').disabled);
   assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
   h.events.get('GENERATION_METRICS_READY')(event);h.events.get('GENERATION_ENDED')({...event,content:completed});await tick();
   assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
   assert.equal(h.synthesis.length,playing?2:0);
  }finally{await h.close();}
 }
});

test('automatic planning uses the full saved continuation and preserves final message normalization',async()=>{
 for(const generationType of ['continue','normal']){
  const h=await harness();try{
   h.$('auto-plan').click();const appended=' Then she smiled.',raw=generationType==='continue'?h.message.content+appended:'A saved reply. "Hello."';
   const completed=`${raw}\n`;
   h.state.savedMessages=[{...h.message,content:completed,swipes:[raw],swipe_id:0}];
   h.events.get('GENERATION_ENDED')({generationId:`canonical-${generationType}`,chatId:'chat-a',messageId:h.message.id,content:generationType==='continue'?appended:raw,generationType});
   if(generationType==='continue')h.message.content=appended; // A transient store projection must not plan just the suffix.
   await until(()=>h.$('status').textContent.includes('Waiting for the completed reply'));assert.equal(h.requests.filter(request=>request.action==='plan').length,0);
   h.message.content=completed;await until(()=>h.$('status').textContent.startsWith('Ready:') && !h.$('latest').disabled);
   assert.equal(h.requests.filter(request=>request.action==='plan').at(-1).input.transcript,transcriptFromMessage(completed));assert.equal(h.synthesis.length,0);
  }finally{await h.close();}
 }
});

test('completion recovery respects swipe selection, disabling automation and navigation',async()=>{
 for(const cancel of ['swipe','off','chat']){
  const h=await harness();try{
   h.$('auto-plan').click();const completed='A different saved reply.';
   h.state.savedMessages=[{...h.message,content:completed,swipes:[h.message.content,completed],swipe_id:cancel==='swipe'?0:1}];
   const event={generationId:`cancel-${cancel}`,chatId:'chat-a',messageId:h.message.id,swipeId:1};
   h.events.get('GENERATION_METRICS_READY')(event);await until(()=>h.$('status').textContent.includes('Waiting for the completed reply'));
   if(cancel==='off')h.$('auto-plan').click();
   if(cancel==='chat'){h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Connection preferences restored');}
   h.message.content=completed;await new Promise(resolve=>setTimeout(resolve,250));assert.equal(h.requests.filter(request=>request.action==='plan').length,0);
  }finally{await h.close();}
 }
});

test('late completion metadata cannot automate a generation that finished with automation off',async()=>{
 const h=await harness();try{
  const event={generationId:'finished-while-off',chatId:'chat-a',messageId:h.message.id};
  h.events.get('GENERATION_ENDED')({...event,content:h.message.content});h.$('auto-plan').click();
  h.state.savedMessages=[{...h.message,swipes:[h.message.content],swipe_id:0}];h.events.get('GENERATION_METRICS_READY')({...event,swipeId:0});
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(h.requests.filter(request=>request.action==='plan').length,0);
 }finally{await h.close();}
});

test('automatic planning ignores unsuitable events and duplicate events during a pending plan',async()=>{
  const h=await harness();try{
    h.$('auto-plan').click();const emit=extra=>h.events.get('GENERATION_ENDED')({chatId:'chat-a',messageId:h.message.id,content:h.message.content,...extra});
    emit({chatId:'chat-b'});emit({error:'Failed'});emit({generationType:'impersonate'});
    h.message.is_user=true;emit({});h.message.is_user=false;h.message.extra={is_system:true};emit({});h.message.extra={};await tick();assert.equal(h.requests.length,0);
    h.state.held=true;emit({});await until(()=>h.requests.some(request=>request.action==='plan'));emit({});await tick();
    assert.equal(document.querySelector('.cm-caption').textContent,'Planning speech');
    assert.equal(h.requests.filter(request=>request.action==='plan').length,1);h.$('stop').click();await tick();h.releaseHeld();await tick();
    assert.equal(h.$('status').textContent,'Stopped.');assert.equal(h.synthesis.length,0);
  }finally{await h.close();}
});

test('mixer Auto-play toggle syncs with settings, persists, and plays even when Auto-plan is off',async()=>{
  const h=await harness();try{
    assert.equal(h.$('auto-play').textContent,'Auto-play Off');assert.equal(h.$('auto-play').getAttribute('aria-pressed'),'false');
    h.$('auto-play').click();assert.equal(h.$('auto').checked,true);assert.equal(h.$('auto-play').textContent,'Auto-play On');assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'false');
    await until(()=>h.$('saveState').textContent==='Saved automatically');assert.equal(h.store.get('chat:chat-a').auto,true);assert.equal(h.synthesis.length,0);
    await h.reload();assert.equal(h.$('auto-play').getAttribute('aria-pressed'),'true');assert.equal(h.$('auto').checked,true);
    h.$('auto').checked=false;h.$('auto').dispatchEvent(new h.dom.window.Event('change'));assert.equal(h.$('auto-play').getAttribute('aria-pressed'),'false');
    h.$('auto').checked=true;h.$('auto').dispatchEvent(new h.dom.window.Event('change'));assert.equal(h.$('auto-play').getAttribute('aria-pressed'),'true');
    h.events.get('GENERATION_ENDED')({chatId:'chat-a',messageId:h.message.id,content:h.message.content});
    await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'false');assert.ok(h.synthesis.length>0);
    h.$('auto-plan').click();h.$('auto-play').click();assert.equal(h.$('auto').checked,false);assert.equal(h.$('auto-play').getAttribute('aria-pressed'),'false');assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'true');
    await until(()=>h.$('saveState').textContent==='Saved automatically');await h.reload();assert.equal(h.$('auto-play').textContent,'Auto-play Off');assert.equal(h.$('auto-plan').getAttribute('aria-pressed'),'true');
  }finally{await h.close();}
});

test('Auto-plan and Auto-play wait for message publication after the host completion event, including same-ID regeneration',async()=>{
 for(const mode of ['auto-plan','auto-play'])for(const existing of [false,true]){
  const h=await harness();try{
   h.$(mode).click();const finalContent='A completed assistant reply.';h.state.messages=existing?[{...h.message,content:'Previous swipe.'}]:[];
   const event={generationId:`generated-${mode}-${existing}`,chatId:'chat-a',messageId:h.message.id,content:finalContent};h.events.get('GENERATION_ENDED')(event,{stateRevision:{epoch:'server-session',sequence:42}});
   await new Promise(resolve=>setTimeout(resolve,150));assert.equal(h.requests.length,0,'Do not plan an unpublished reply');assert.equal(h.audios.length,0);
   h.message.content=finalContent;h.state.messages=[h.message];h.subscriptions.get('chat.messageCount')();
   await until(()=>h.$('status').textContent.includes(mode==='auto-play'?'Playback finished':'Ready:') && !h.$('latest').disabled);
   assert.equal(h.requests.filter(request=>request.action==='plan').length,1);assert.equal(h.requests.find(request=>request.action==='plan').input.transcript,finalContent);
   assert.equal(h.audios.length>0,mode==='auto-play');const audioCount=h.audios.length;h.events.get('GENERATION_ENDED')(event);await new Promise(resolve=>setTimeout(resolve,150));assert.equal(h.audios.length,audioCount);assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
  }finally{await h.close();}
 }
});

test('new reply automation queues behind active planning, playback or Cue instead of dropping the completion event',async()=>{
 for(const activity of ['planning','playback','Cue']){
  const h=await harness();try{
   const playing=activity!=='planning';let companion;
   h.message.content='First reply.';h.$(playing?'auto-play':'auto-plan').click();
   if(playing){h.state.blockAudio=true;if(activity==='Cue')companion=globalThis.__CHOIR_API__.playParagraph({text:h.message.content});else{await h.plan();h.$('play').click();}await until(()=>h.audios.length===1 && !h.audios[0].paused);}
   else{h.state.held=true;h.$('latest').click();await until(()=>h.requests.some(request=>request.action==='plan'));}
   const initialPlans=activity==='Cue'?0:1,next={id:'message-next',name:'Mira',is_user:false,content:'Second reply.'};h.state.messages=[h.message,next];h.events.get('GENERATION_ENDED')({generationId:'next-generation',chatId:'chat-a',messageId:next.id,content:next.content});await new Promise(resolve=>setTimeout(resolve,150));assert.equal(h.requests.filter(request=>request.action==='plan').length,initialPlans);
   if(playing){h.state.blockAudio=false;h.audios[0].onended();await companion;}else{h.state.held=false;h.releaseHeld();}
   await until(()=>h.requests.filter(request=>request.action==='plan').length===initialPlans+1 && h.$('preview').textContent.includes(next.content) && !h.$('latest').disabled && (!playing || h.$('status').textContent.includes('Playback finished')));
   assert.equal(h.audios.length,playing?2:0);assert.equal(h.requests.filter(request=>request.action==='plan').at(-1).input.transcript,next.content);
  }finally{await h.close();}
 }
});

test('removed drawer narrator mute remains visible and reversible through mixer No voice and the Cue bridge',async()=>{
 const h=await harness();try{
  const saved=h.store.get('chat:chat-a');saved.muteNarrator=true;await h.reload();
  await h.plan();
  assert.equal(h.$('muteNarrator'),null);assert.ok(!h.root.textContent.includes('Mute narrator (dialogue only)'));
  const button=()=>h.dom.window.document.querySelector('[aria-label="Narrator no voice"]');assert.equal(button().getAttribute('aria-pressed'),'true');assert.equal(globalThis.__CHOIR_API__.isNarratorMuted(),true);
  button().click();await until(()=>h.store.get('chat:chat-a').muteNarrator===false);assert.equal(button().getAttribute('aria-pressed'),'false');assert.equal(h.store.get('settings:global').muteNarrator,false);
  await h.reload();assert.equal(globalThis.__CHOIR_API__.isNarratorMuted(),false);button().click();await until(()=>h.store.get('chat:chat-a').fixed[0].excluded===true);assert.equal(globalThis.__CHOIR_API__.isNarratorMuted(),true);
  globalThis.__CHOIR_API__.setNarratorMuted(false);await until(()=>h.store.get('chat:chat-a').fixed[0].excluded===false);assert.equal(button().getAttribute('aria-pressed'),'false');
  const result=await globalThis.__CHOIR_API__.playParagraph({text:'Narration is audible again.'});assert.equal(result.played,1);assert.ok(h.synthesis.some(request=>request.voice==='n'));
 }finally{await h.close();}
});

test('Stop, disabling automation, navigation and teardown discard waiting automatic replies',async()=>{
 for(const cancellation of ['stop','off','navigate','teardown']){
  const h=await harness();try{
   h.$('auto-play').click();h.state.messages=[];h.events.get('GENERATION_ENDED')({generationId:'late-generation',chatId:'chat-a',messageId:h.message.id,content:h.message.content});await tick();
   if(cancellation==='stop')h.$('stop').click();else if(cancellation==='off')h.$('auto-play').click();else if(cancellation==='navigate'){h.state.active='chat-b';h.subscriptions.get('chat.active')();}else await h.reload();
   h.state.messages=[h.message];h.subscriptions.get('chat.messageCount')?.();await new Promise(resolve=>setTimeout(resolve,160));assert.equal(h.requests.length,0);assert.equal(h.audios.length,0);
  }finally{await h.close();}
 }
});

test('larger native requests apply OpenAI, Fish, and unknown-provider chunk limits without losing text',async()=>{
  for(const [provider,limit] of [['openai_tts',4096],['fish_audio',10000],['custom_tts',2000]]){
    const h=await harness();try{
      h.connections[0].provider=provider;await h.reload();h.message.content='A neutral phrase '.repeat(400)+'ends.';
      h.$('chunk').value='10000';h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
      await h.plan();await h.play();assert.ok(h.synthesis.every(request=>request.text.length<=limit));
      if(provider!=='custom_tts')assert.ok(h.synthesis.some(request=>request.text.length>2000));
      const spoken=h.synthesis.map(request=>request.text.replace(/^\[Calm\]\s*/,''));
      assert.ok(spoken.join(' ').replace(/\s+/g,' ').trim()===h.message.content.replace(/\s+/g,' ').trim(),'Native chunks must preserve the original speech text.');
    }finally{await h.close();}
  }
});

test('larger Gemini requests preserve multilingual text and reserve input space for delivery instructions',async()=>{
  const h=await harness();try{
    const saved=h.store.get('chat:chat-a');h.store.set('chat:chat-a',{...saved,mode:'gemini',chunk:10000,fixed:[{speaker:'Narrator',voice:'Charon',style:'Calm'}],casts:{gemini:[]}});
    await h.reload();h.$('key').value='test-session-key';h.message.content=Array.from({length:1500},(_,index)=>`你好世界${index}`).join(' ');
    await h.plan();await h.play();const segments=h.requests.filter(request=>request.action==='gemini').map(request=>request.input.segment);
    assert.ok(segments.length>1);assert.ok(segments.every(segment=>new TextEncoder().encode(segment.text+segment.style).length<=6000));
    assert.ok(segments.map(segment=>segment.text).join(' ').replace(/\s+/g,' ').trim()===h.message.content,'Gemini chunks must preserve the original multilingual text.');
  }finally{await h.close();}
});

test('companion paragraph playback also applies native provider limits and Fish delivery tags',async()=>{
  for(const [provider,limit] of [['openai_tts',4096],['fish_audio',10000]]){
    const h=await harness();try{
      h.connections[0].provider=provider;const saved=h.store.get('chat:chat-a');h.store.set('chat:chat-a',{...saved,chunk:10000});await h.reload();
      const text='A neutral phrase '.repeat(400)+'ends.';
      await globalThis.__CHOIR_API__.playParagraph({text,speaker:'Narrator'});
      assert.ok(h.synthesis.length>0);assert.ok(h.synthesis.every(request=>request.text.length<=limit));
      if(provider==='fish_audio')assert.ok(h.synthesis.every(request=>request.text.startsWith('[Calm]')));
      assert.ok(h.synthesis.map(request=>request.text.replace(/^\[Calm\]\s*/,'')).join(' ').replace(/\s+/g,' ').trim()===text,'Companion chunks must preserve the original paragraph.');
    }finally{await h.close();}
  }
});

test('heuristic planning and its test stay local without any backend request',async()=>{
  const h=await harness();try{
    h.$('plannerMode').value='heuristic';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));
    h.message.content='The room fell quiet.';await h.plan();
    assert.equal(h.requests.length,0);assert.match(h.$('preview').textContent,/Narrator/);
    await h.click('testPlanner',text=>text.startsWith('Heuristic test passed'));
    assert.equal(h.requests.length,0);assert.equal(h.synthesis.length,0);assert.equal(h.$('stop').disabled,true);
  }finally{await h.close();}
});

test('ambiguous heuristic dialogue stops without an LLM fallback or audio synthesis',async()=>{
  const h=await harness();try{
    h.$('allowLlmFallback').checked=true;h.$('plannerMode').value='heuristic';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));
    await h.click('latest',text=>text.includes('No LLM request was made'));
    assert.equal(h.requests.length,0);assert.equal(h.synthesis.length,0);assert.equal(h.$('preview').children.length,0);
    assert.equal(h.$('llmPlannerBox').hidden,true);assert.equal(h.$('stop').disabled,true);
  }finally{await h.close();}
});

test('switching from heuristic to LLM clears legacy flags and preserves the selected engine on reload',async()=>{
  const h=await harness();try{
    h.$('plannerMode').value='heuristic';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));
    h.$('plannerMode').value='llm';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));
    assert.equal(h.$('useFastClassifier').checked,false);assert.equal(h.$('llmPlannerBox').hidden,false);
    await until(()=>h.$('saveState').textContent==='Saved automatically');
    assert.equal(h.store.get('chat:chat-a').useFastClassifier,false);await h.reload();assert.equal(h.$('plannerMode').value,'llm');
    h.message.content='The room fell quiet.';await h.plan();assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
  }finally{await h.close();}
});

test('explicit planner selections survive stale flags and legacy Jev settings restore correctly',async()=>{
  const h=await harness();try{
    const saved=h.store.get('chat:chat-a');saved.plannerMode='jev';saved.useFastClassifier=true;h.store.set('chat:chat-a',saved);
    await h.reload();assert.equal(h.$('plannerMode').value,'jev');assert.equal(h.$('useFastClassifier').checked,false);
    await h.click('latest',text=>text.includes('The object cannot be cloned'));
    assert.equal(h.requests.filter(r=>r.action==='planJev').length,1);assert.equal(h.requests.filter(r=>r.action==='plan').length,0);
    delete saved.plannerMode;saved.useFastClassifier=false;saved.useJev=true;await h.reload();assert.equal(h.$('plannerMode').value,'jev');
  }finally{await h.close();}
});

test('Decision connection autosaves, survives reload and is inherited by a new chat',async()=>{
  const h=await harness();try{
    h.$('plannerMode').value='jev';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));
    h.$('decisionConnection').value='decision-b';h.$('decisionConnection').dispatchEvent(new h.dom.window.Event('change'));
    await until(()=>h.$('saveState').textContent==='Saved automatically');
    assert.equal(h.store.get('chat:chat-a').decisionConnection,'decision-b');assert.equal(h.store.get('settings:global').decisionConnection,'decision-b');
    await h.reload();assert.equal(h.$('decisionConnection').value,'decision-b');
    await h.click('testPlanner',text=>text.includes('Planner test passed'));
    assert.equal(h.requests.findLast(r=>r.action==='testPlanner').input.decisionConnection,'decision-b');
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Connection preferences restored');
    assert.equal(h.$('decisionConnection').value,'decision-b');assert.equal(h.$('plannerMode').value,'jev');
  }finally{await h.close();}
});

test('an incomplete Jev response never enables an unapproved LLM fallback',async()=>{
  const h=await harness();try{
    h.state.jevInvalid=true;h.$('plannerMode').value='jev';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));
    await h.click('latest',text=>text.includes('Jev returned no valid speech plan'));
    assert.equal(h.requests.filter(r=>r.action==='plan').length,0);assert.equal(h.synthesis.length,0);
  }finally{await h.close();}
});

test('drawer Stop cancels pending planning and discards a late result with the mixer hidden',async()=>{
  const h=await harness();try{
    const stop=h.root.querySelector('[data-et="stop"]');assert.ok(stop);assert.equal(stop.disabled,true);
    h.state.held=true;h.$('latest').click();await until(()=>h.requests.some(r=>r.action==='plan'));await tick();
    assert.equal(stop.disabled,false);assert.equal(h.$('decisionConnection').disabled,true);
    stop.click();await tick();assert.equal(h.$('status').textContent,'Stopped.');assert.equal(stop.disabled,true);assert.equal(h.$('decisionConnection').disabled,false);
    assert.ok(h.requests.some(r=>r.action==='cancel'));h.releaseHeld();await tick();
    assert.equal(h.$('status').textContent,'Stopped.');assert.equal(h.$('preview').children.length,0);assert.equal(h.audios.length,0);
  }finally{await h.close();}
});

test('drawer Stop cancels in-flight speech and paused audio without opening the mixer',async()=>{
  const h=await harness();try{
    await h.plan();h.state.delay=200;h.$('play').click();await until(()=>h.synthesis.length>0);
    h.root.querySelector('[data-et="stop"]').click();await tick();assert.equal(h.state.aborted,1);assert.equal(h.audios.length,0);
    h.state.delay=0;h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);
    h.$('pause').click();assert.equal(h.root.querySelector('[data-et="stop"]').disabled,false);
    h.root.querySelector('[data-et="stop"]').click();await tick();assert.ok(h.audios.every(audio=>audio.paused));assert.equal(h.$('status').textContent,'Stopped.');
  }finally{await h.close();}
});

test('drawer Stop during automatic NPC voice design preserves Stopped status and rejects late results',async()=>{
  const h=await harness();try{
    const saved=h.store.get('chat:chat-a');h.store.set('chat:chat-a',{...saved,mode:'gemini',autoDesignNPCs:true,extraVoices:'n | Narrator\ny | Persona\ng | Guard',casts:{gemini:[]}});
    await h.reload();h.$('key').value='test-session-key';h.state.holdDesignVoice=true;
    h.$('latest').click();await until(()=>h.requests.some(r=>r.action==='designVoice'));await tick();
    h.root.querySelector('[data-et="stop"]').click();await tick();h.releaseHeld();await tick();
    assert.equal(h.$('status').textContent,'Stopped.');assert.equal(h.$('stop').disabled,true);assert.equal(h.synthesis.length,0);
    assert.ok(h.requests.some(r=>r.action==='cancel'));assert.equal(h.store.has('activeplan:chat-a'),false);
  }finally{await h.close();}
});

test('reload and chat navigation restore plans; recasting and edited text regenerate only affected passages',async()=>{
  const h=await harness();try{
    assert.equal(h.footer.querySelector('button').title,'Play Choir · click again to stop'); // New ctx.ui decorator API.
    await h.plan();await h.play();assert.equal(h.synthesis.length,4);
    assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
    assert.equal(h.synthesis.find(r=>r.voice==='m').parameters.accent,'Irish');
    assert.match(h.synthesis.find(r=>r.voice==='m').parameters.instructions,/mee-rah/);
    await h.reload();assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    await until(()=>h.$('preview').textContent.includes('Cached'));
    await h.play();assert.equal(h.synthesis.length,4);
    h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value='new';
    await h.click('save',text=>text.includes('retention saved'));await h.play();assert.equal(h.synthesis.length,5);
    assert.equal(h.synthesis.at(-1).voice,'new');assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));
    assert.equal(h.$('preview').children.length,0);
    h.state.active='chat-a';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('restored'));
    assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    h.message.content='At dawn. "Greetings." "Wait." The gate closed.';h.events.get('MESSAGE_EDITED')({messageId:'message-a'});
    assert.equal(h.$('preview').children.length,0);await h.plan();await h.play();
    assert.equal(h.requests.filter(r=>r.action==='plan').length,2);assert.equal(h.synthesis.length,6);
    assert.equal(h.synthesis.at(-1).text,'"Greetings."');
  }finally{await h.close();}
});

test('connection speed and format changes regenerate only affected saved speech',async()=>{
  const h=await harness();try{
    h.connections[0].default_parameters={speed:1,output_format:'mp3'};await h.reload();await h.plan();await h.play();
    assert.equal(h.synthesis.length,4);
    h.connections[0].default_parameters.speed=1.2;await h.reload();await h.play();
    assert.equal(h.synthesis.length,7);assert.ok(h.synthesis.slice(4).every(request=>request.connectionId==='a'));
    h.connections[0].default_parameters.output_format='wav';await h.reload();await h.play();
    assert.equal(h.synthesis.length,10);assert.ok(h.synthesis.slice(7).every(request=>request.connectionId==='a'));
    h.connections[0].default_parameters.use_streaming_endpoint=true;await h.reload();await h.play();assert.equal(h.synthesis.length,10);
    assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
  }finally{await h.close();}
});

test('companion speech applies actor pronunciation and accent just like the main player',async()=>{
  const h=await harness();try{
    await globalThis.__CHOIR_API__.playParagraph({text:'"A companion-only line."',speaker:'Mira'});
    assert.equal(h.synthesis.length,1);assert.equal(h.synthesis[0].connectionId,'b');
    assert.equal(h.synthesis[0].parameters.accent,'Irish');assert.match(h.synthesis[0].parameters.instructions,/mee-rah/);
    await globalThis.__CHOIR_API__.playParagraph({text:'"A companion-only line."',speaker:'Mira'});assert.equal(h.synthesis.length,1);
  }finally{await h.close();}
});

test('companion cache changes with the Gemini model and delivery settings',async()=>{
  const h=await harness();try{
    const saved=h.store.get('chat:chat-a');h.store.set('chat:chat-a',{...saved,mode:'gemini',fixed:[{speaker:'Narrator',voice:'Charon',style:'Calm'}],casts:{gemini:[]}});await h.reload();
    h.$('key').value='test-key';const text='A companion-only narration.';
    const calls=()=>h.requests.filter(request=>request.action==='gemini');
    await globalThis.__CHOIR_API__.playParagraph({text});await globalThis.__CHOIR_API__.playParagraph({text});assert.equal(calls().length,1);
    h.$('model').value='gemini-3.8-flash-lite-tts';h.$('model').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
    await globalThis.__CHOIR_API__.playParagraph({text});assert.equal(calls().length,2);assert.equal(calls()[1].input.model,'gemini-3.8-flash-lite-tts');
    await toggle(h,'useStyle',false);await globalThis.__CHOIR_API__.playParagraph({text});assert.equal(calls().length,3);assert.equal(calls()[2].input.segment.style,'');
  }finally{await h.close();}
});

test('companion sound-choice requests cancel on Stop or external abort before speech starts',async()=>{
  for(const cancel of ['stop','signal','replacement']){
    const h=await harness();let pending;try{
      await configureFoley(h);h.state.holdSfx=true;const ctrl=new AbortController();
      pending=globalThis.__CHOIR_API__.playParagraph({text:'A companion-only narration.',signal:ctrl.signal}).then(result=>({result}),error=>({error}));
      await until(()=>h.requests.some(request=>request.action==='sfx'));
      assert.equal(h.$('stop').disabled,false,'Stop must be usable while optional sound choices are pending');
      if(cancel==='stop')globalThis.__CHOIR_API__.stop();
      else if(cancel==='signal')ctrl.abort();
      else{h.state.holdSfx=false;assert.equal((await globalThis.__CHOIR_API__.playParagraph({text:'The replacement narration.'})).played,1);}
      const outcome=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),500))]);
      assert.equal(outcome.error?.name,'AbortError');assert.equal(h.synthesis.length,cancel==='replacement'?1:0);assert.equal(h.audios.length,cancel==='replacement'?1:0);
      assert.ok(h.requests.some(request=>request.action==='cancel'));
    }finally{h.releaseHeld();await h.close();await pending;}
  }
});

test('replacing a companion request for the same text retries an aborted flight and caches the completed audio',async()=>{
  const h=await harness();try{
    h.state.delay=60;const bridge=globalThis.__CHOIR_API__,text='A companion-only narration.';
    const first=bridge.playParagraph({text}).then(result=>({result}),error=>({error}));await until(()=>h.synthesis.length===1);
    assert.equal((await bridge.playParagraph({text})).played,1);assert.equal((await first).error?.name,'AbortError');assert.equal(h.synthesis.length,2);
    assert.equal((await bridge.playParagraph({text})).played,1);assert.equal(h.synthesis.length,2);
  }finally{await h.close();}
});

test('429 retains completed audio across reload and retry bills only missing passages',async()=>{
  const h=await harness();try{
    await h.plan();h.state.failVoice='g';await h.click('play',text=>text.includes('Completed passages were retained'));
    assert.equal(h.synthesis.length,3);await until(()=>h.$('preview').textContent.includes('Cached'));
    await h.reload();h.state.failVoice=null;await h.play();
    assert.equal(h.synthesis.length,5);assert.deepEqual(h.synthesis.slice(3).map(r=>r.voice),['g','n']);
    assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
  }finally{await h.close();}
});

test('Fish 502 shows the selected connection, model, voice and returned error while retaining completed audio',async()=>{
  for(const failure of [
    {status:502,body:'Fish upstream: voice is unavailable'},
    {status:502,body:JSON.stringify({error:{message:'Fish synthesis timed out'}}),type:'application/json'},
    {status:502,body:'<html><head><style>hidden proxy styles</style></head><body><h1>502 Bad Gateway</h1><p>Upstream timed out</p></body></html>',type:'text/html'},
    {status:502,body:''}
  ]){
    const h=await harness();try{
      h.connections[1].provider='fish_audio';h.connections[1].model='s2.1-pro';await h.reload();await h.plan();
      h.state.failSynthesisAt=2;h.state.synthesisError=failure;
      await h.click('play',text=>text.includes('Completed passages were retained'));
      const error=h.$('status').textContent;
      assert.match(error,/Fish Audio speech failed/);assert.match(error,/Character provider/);assert.match(error,/s2\.1-pro/);assert.match(error,/voice m/);assert.match(error,/HTTP 502/);
      if(failure.type==='application/json')assert.match(error,/Fish synthesis timed out/);
      else if(failure.type==='text/html'){assert.match(error,/Upstream timed out/);assert.ok(!error.includes('hidden proxy styles'));assert.ok(!error.includes('<html>'));}
      else if(failure.body)assert.match(error,/voice is unavailable/);
      else assert.match(error,/returned no error details/);
      assert.equal(h.synthesis.length,2);await h.reload();h.state.synthesisError=null;h.state.failSynthesisAt=null;await h.play();
      assert.equal(h.synthesis.length,5);assert.deepEqual(h.synthesis.slice(2).map(request=>request.voice),['m','g','n']);
      assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
    }finally{await h.close();}
  }
});

test('mixer Silent and No voice retain text; resume, volume and position survive reload',async()=>{
  const h=await harness();try{
    h.$('showMixer').click();
    await h.plan();document.querySelector('[aria-label="Guard no voice"]').click();await tick();
    assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);
    const audio=h.audios.at(-1);audio.currentTime=7;audio.ontimeupdate?.();
    const mixer=document.querySelector('[data-choir-mixer]');assert.match(mixer.textContent,/Speaking: Narrator/);
    const master=mixer.querySelector('[aria-label="Master volume"]');master.value='0.5';master.dispatchEvent(new h.dom.window.Event('input'));master.dispatchEvent(new h.dom.window.Event('change'));assert.equal(audio.volume,0.5);
    mixer.querySelector('[aria-label="Narrator silent"]').click();assert.equal(audio.volume,0);
    mixer.querySelector('[aria-label="Narrator silent"]').click();mixer.querySelector('[aria-label="Mira no voice"]').click();assert.equal(audio.volume,0.5);await tick();
    const header=mixer.firstChild;header.dispatchEvent(new h.dom.window.MouseEvent('pointerdown',{bubbles:true,clientX:20,clientY:80}));header.dispatchEvent(new h.dom.window.MouseEvent('pointermove',{bubbles:true,clientX:90,clientY:160}));header.dispatchEvent(new h.dom.window.MouseEvent('pointerup',{bubbles:true}));
    h.$('stop').click();await tick();assert.equal(h.store.get('position:chat-a').seconds,7);
    await h.reload();assert.equal(document.querySelector('[data-choir-mixer]').style.left,'90px');assert.equal(document.querySelector('[aria-label="Guard no voice"]').getAttribute('aria-pressed'),'true');
    const before=h.synthesis.length;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);assert.equal(h.audios.at(-1).currentTime,7);
    h.state.blockAudio=false;h.audios.at(-1).onended();await until(()=>h.$('status').textContent.includes('Playback finished'));
    assert.equal(h.synthesis.length,before+1);assert.ok(!h.synthesis.some(r=>r.voice==='g'));
    h.$('showMixer').click();document.querySelector('[aria-label="Collapse Choir voice mixer"]').click();assert.equal(document.querySelector('[data-choir-mixer]').children[1].hidden,true);
    h.$('showMixer').click();assert.equal(document.querySelector('[data-choir-mixer]').children[1].hidden,false);
  }finally{await h.close();}
});

test('mixer starts as a draggable sound icon even with old expanded preferences, and dragging does not open it',async()=>{
  const h=await harness({master:0.4,channels:{},x:50,y:100,collapsed:false});try{
    const mixer=document.querySelector('[data-choir-mixer]'),button=mixer.querySelector('[aria-label="Open Choir voice mixer"]');
    assert.equal(mixer.style.width,'44px');assert.equal(mixer.children[1].hidden,true);assert.equal(mixer.firstChild.firstChild.hidden,true);assert.ok(button.querySelector('svg'));assert.equal(button.getAttribute('aria-expanded'),'false');
    button.dispatchEvent(new h.dom.window.MouseEvent('pointerdown',{bubbles:true,clientX:50,clientY:100}));button.dispatchEvent(new h.dom.window.MouseEvent('pointermove',{bubbles:true,clientX:90,clientY:140}));button.dispatchEvent(new h.dom.window.MouseEvent('pointerup',{bubbles:true}));button.dispatchEvent(new h.dom.window.MouseEvent('click',{bubbles:true,detail:1}));
    assert.equal(mixer.style.left,'90px');assert.equal(mixer.children[1].hidden,true);
    button.click();assert.equal(mixer.children[1].hidden,false);assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(mixer.querySelector('[aria-label="Master volume"]').value,'0.4');
    button.click();assert.equal(mixer.style.width,'44px');assert.equal(mixer.children[1].hidden,true);
    await h.reload();assert.equal(document.querySelector('[data-choir-mixer]').style.left,'90px');assert.equal(document.querySelector('[data-choir-mixer]').dataset.collapsed,'true');
  }finally{await h.close();}
});

test('host remount replaces the previous mixer and cancels its playback',async()=>{
  const h=await harness();try{
    await h.plan();h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);
    h.$('showMixer').click();await h.remount();assert.ok(h.audios.every(audio=>audio.paused));
    assert.equal(document.querySelectorAll('[data-choir-mixer]').length,1);assert.equal(document.querySelector('[data-choir-mixer]').style.width,'44px');
  }finally{await h.close();}
});

test('latest planned notice invites an explicit redo without discarding cached audio',async()=>{
  const h=await harness();try{
    assert.equal(h.$('latestNotice').hidden,true);await h.plan();await h.play();
    assert.equal(h.$('latestNotice').hidden,false);assert.equal(h.$('latestNotice').textContent,'latest already planned, click on plan latest to redo it');
    const before=h.synthesis.length;await h.plan();assert.equal(h.requests.filter(r=>r.action==='plan').length,2);await h.play();assert.equal(h.synthesis.length,before);
    await h.reload();assert.equal(h.$('latestNotice').hidden,false);await h.plan();assert.equal(h.requests.filter(r=>r.action==='plan').length,3);
    h.store.set('activeplan:chat-a','another-message');await h.reload();await until(()=>!h.$('latestNotice').hidden);
    assert.equal(h.$('preview').children.length,0);await h.plan();assert.equal(h.requests.filter(r=>r.action==='plan').length,4);
    h.message.content='A different scene. "Hello."';h.events.get('MESSAGE_EDITED')({messageId:h.message.id});assert.equal(h.$('latestNotice').hidden,true);
  }finally{await h.close();}
});

test('message play reuses the current validated plan even when saving it fails, and overlapping clicks do not replan',async()=>{
  const h=await harness();try{
    h.state.failPlanSave=true;h.$('latest').click();await until(()=>h.$('status').textContent.includes('Settings storage failed'));
    assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
    const button=h.footer.querySelector('button');assert.equal(button.textContent,'');assert.equal(button.style.width,'28px');
    button.click();button.click();await until(()=>h.$('status').textContent.includes('Playback finished'));
    assert.equal(h.requests.filter(r=>r.action==='plan').length,1);const synthesized=h.synthesis.length;
    button.click();await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(h.requests.filter(r=>r.action==='plan').length,1);assert.equal(h.synthesis.length,synthesized);
  }finally{await h.close();}
});

test('section playback is an optional persisted toggle and synthesizes only the selected planner section',async()=>{
  const h=await harness();try{
    h.message.content='The hall was quiet '.repeat(70)+'. "Welcome." '+'The road was dark '.repeat(80)+'.';
    await h.plan();const planned=h.requests.filter(r=>r.action==='plan').length;assert.ok(planned>=3);
    assert.equal(h.footer.querySelector('details').hidden,true);
    h.$('sectionButtons').checked=true;h.$('sectionButtons').dispatchEvent(new h.dom.window.Event('change'));await tick();
    const sections=h.footer.querySelector('details');assert.equal(sections.hidden,false);assert.equal(sections.querySelectorAll('[data-choir-section]').length,planned);
    sections.querySelector('[data-choir-section="1"]').click();await until(()=>h.$('status').textContent.includes('Playback finished'));
    assert.equal(h.synthesis.length,1);assert.equal(h.synthesis[0].voice,'m');assert.match(h.synthesis[0].text,/Welcome/);assert.equal(h.requests.filter(r=>r.action==='plan').length,planned);
    await h.reload();assert.equal(h.$('sectionButtons').checked,true);await until(()=>h.footer.querySelectorAll('[data-choir-section]').length===planned);
    h.$('sectionButtons').checked=false;h.$('sectionButtons').dispatchEvent(new h.dom.window.Event('change'));await tick();assert.equal(h.footer.querySelector('details').hidden,true);
    assert.equal(h.$('preview').querySelectorAll('[data-choir-section]').length,0);
  }finally{await h.close();}
});

test('retrying message play after a planner failure and reload reuses completed attribution sections',async()=>{
  const h=await harness();try{
    h.message.content='The hall was quiet '.repeat(70)+'. "Welcome." '+'The road was dark '.repeat(80)+'.';
    const count=planningSections(h.message.content).length;h.state.failPlanAt=2;
    h.$('latest').click();await until(()=>h.$('status').textContent.includes('Planner quota exhausted'));
    const first=h.requests.find(r=>r.action==='plan').input.transcript;
    h.state.failPlanAt=null;await h.reload();h.footer.querySelector('button').click();await until(()=>h.$('status').textContent.includes('Playback finished'));
    assert.equal(h.requests.filter(r=>r.action==='plan' && r.input.transcript===first).length,1);
    assert.equal(h.requests.filter(r=>r.action==='plan').length,count+1);
    h.message.content='A changed reply. "Hello."';h.events.get('MESSAGE_EDITED')({messageId:h.message.id});await h.plan();assert.equal(h.requests.filter(r=>r.action==='plan').length,count+2);
  }finally{await h.close();}
});

test('bounded prefetch stops requests on chat switch; late planning cannot repopulate the next chat',async()=>{
  const h=await harness();try{
    await h.plan();h.$('prefetch').value='1';h.$('concurrency').value='4';h.state.blockAudio=true;
    h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);await tick();assert.equal(h.synthesis.length,2);
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));
    assert.ok(h.audios.every(audio=>audio.paused));assert.equal(h.synthesis.length,2);assert.equal(h.$('preview').children.length,0);
    h.state.active='chat-a';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('restored'));
    h.message.content='A new scene. "Hello."';h.events.get('MESSAGE_EDITED')({messageId:'message-a'});h.state.held=true;h.$('latest').click();await until(()=>h.requests.filter(r=>r.action==='plan').length===2);
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));
    assert.ok(h.requests.some(r=>r.action==='cancel'));assert.equal(h.$('preview').children.length,0);
    h.releaseHeld();await tick();assert.equal(h.$('preview').children.length,0);
  }finally{await h.close();}
});

test('edits and swipes cancel planning and in-flight synthesis before stale replies or audio can play',async()=>{
  const h=await harness();try{
    h.state.held=true;h.$('latest').click();await until(()=>h.requests.some(request=>request.action==='plan'));
    h.message.content='The reply was edited. "Hello."';h.events.get('MESSAGE_EDITED')({messageId:'message-a',chatId:'chat-a'});
    h.releaseHeld();await tick();assert.equal(h.$('preview').children.length,0);assert.equal(h.audios.length,0);
    h.state.held=false;await h.plan();h.state.delay=200;h.$('play').click();await until(()=>h.synthesis.length>0);
    h.message.content='A different swipe.';h.events.get('MESSAGE_SWIPED')({messageId:'message-a',chatId:'chat-a'});
    await tick();assert.equal(h.state.aborted,1);assert.equal(h.audios.length,0);assert.equal(h.$('preview').children.length,0);
    assert.equal(h.$('play').disabled,false);assert.equal(h.$('play').getAttribute('aria-label'),'Play latest reply');
  }finally{await h.close();}
});

test('storage failure preserves generated audio in the session and reports the persistence limit',async()=>{
  const h=await harness();try{
    await h.plan();globalThis.indexedDB=undefined;
    await h.click('play',text=>text.includes('Audio could not be saved'));
    assert.equal(h.synthesis.length,4);assert.match(h.$('status').textContent,/unavailable/);
    await h.click('play',text=>text.includes('Audio could not be saved'));assert.equal(h.synthesis.length,4);
  }finally{await h.close();}
});

test('duplicate prefetched passages share one synthesis request',async()=>{
  const h=await harness();try{
    h.message.content='At dawn. At dawn.';h.$('prefetch').value='1';h.$('concurrency').value='2';h.state.delay=30;
    await h.plan();await h.play();assert.equal(h.synthesis.length,1);assert.equal(h.audios.length,2);
  }finally{await h.close();}
});

test('character exclusions preserve attribution and reenabling generates only those characters',async()=>{
  const h=await harness();try{
    await h.plan();
    document.querySelector('[aria-label="Mira no voice"]').click();document.querySelector('[aria-label="Guard no voice"]').click();await tick();await h.play();
    assert.deepEqual(h.synthesis.map(input=>input.voice),['n','n']);assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    document.querySelector('[aria-label="Mira no voice"]').click();document.querySelector('[aria-label="Guard no voice"]').click();await tick();await h.play();
    assert.deepEqual(h.synthesis.slice(2).map(input=>input.voice),['m','g']);assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
  }finally{await h.close();}
});

test('cancellation during audio decoding never starts the decoded passage',async()=>{
  const h=await harness(),originalContext=globalThis.AudioContext;let decode;
  globalThis.AudioContext=class{async resume(){}decodeAudioData(){return new Promise(resolve=>decode=resolve);}async close(){}};
  try{
    await h.plan();h.$('play').click();await until(()=>decode);assert.equal(h.$('pause').disabled,true);
    h.$('stop').click();decode({numberOfChannels:1,getChannelData:()=>new Float32Array([0.1])});await tick();
    assert.ok(h.audios.every(audio=>audio.paused));assert.match(document.querySelector('[data-choir-mixer]').textContent,/Ready to play/);
  }finally{globalThis.AudioContext=originalContext;await h.close();}
});

test('connection tests are independent; Jev fallback is off by default and keys never enter saved settings or cast export',async()=>{
  const h=await harness();try{
    assert.equal(h.$('setupGuide'),null);await h.click('testPlanner',text=>text.includes('Planner test passed'));assert.equal(h.synthesis.length,0);
    await h.click('testTts',text=>text.includes('Audition finished'));assert.equal(h.requests.filter(r=>r.action==='plan').length,0);assert.equal(h.synthesis.length,1);
    h.$('plannerMode').value='jev';h.$('plannerMode').dispatchEvent(new h.dom.window.Event('change'));h.$('jevKey').value='secret-jev-session';
    await h.click('latest',text=>text.includes('The object cannot be cloned'));assert.equal(h.requests.filter(r=>r.action==='plan').length,0);
    h.$('allowLlmFallback').checked=true;h.$('allowLlmFallback').dispatchEvent(new h.dom.window.Event('change'));await h.plan();
    assert.match(h.$('status').textContent,/Jev failed.*The object cannot be cloned/);
    h.$('exportCast').click();const exported=JSON.parse(h.$('castJson').value);assert.equal(exported.fixed[2].aliases[0],'Captain');
    assert.ok(!JSON.stringify([...h.store.values()]).includes('secret-jev-session'));assert.ok(!h.$('castJson').value.includes('secret-jev-session'));
    const before=h.store.get('chat:chat-a');h.$('castJson').value=JSON.stringify({...exported,fixed:exported.fixed.map(actor=>({...actor,voice:'missing'}))});
    await h.click('importCast',text=>text.includes('not in the selected'));assert.deepEqual(h.store.get('chat:chat-a'),before);
    h.$('castJson').value=JSON.stringify(exported);await h.click('importCast',text=>text.includes('Cast imported'));assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
  }finally{await h.close();}
});

test('compact cast editors retain hidden preferences through save, recasting and reload',async()=>{
  const h=await harness();try{
    const row=h.$('fixed').querySelectorAll('.et-card')[2],edit=row.querySelector('[data-choir-edit]'),editor=row.querySelector('[data-choir-cast-editor]');
    assert.equal(editor.hidden,true);assert.equal(row.querySelector('strong').textContent,'Mira');edit.click();assert.equal(editor.hidden,false);
    row.querySelector('[data-choir-voice]').value='new';edit.click();assert.equal(editor.hidden,true);
    await h.plan();await h.click('save',text=>text.includes('retention saved'));const actor=h.store.get('chat:chat-a').fixed[2];
    assert.equal(actor.voice,'new');assert.equal(actor.route,'native:b');assert.deepEqual(actor.aliases,['Captain']);assert.equal(actor.pronunciation,'Mira: mee-rah');assert.equal(actor.accent,'Irish');
    await h.reload();assert.equal(h.$('fixed').querySelectorAll('[data-choir-cast-editor]')[2].hidden,true);assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
    await h.play();assert.equal(h.synthesis.find(input=>input.connectionId==='b').voice,'new');
    h.$('add').click();const added=h.$('fixed').lastElementChild;assert.equal(added.querySelector('[data-choir-cast-editor]').hidden,false);
    const name=added.querySelector('input');name.value='Echo';name.dispatchEvent(new h.dom.window.Event('input'));assert.equal(added.querySelector('strong').textContent,'Echo');
  }finally{await h.close();}
});

test('next skips a whole multi-chunk block; previous reuses audio, paused navigation and seeking preserve position',async()=>{
  const h=await harness();try{
    h.message.content='The hall was silent '.repeat(65)+'. "Hello." The door closed.';await h.plan();const planned=h.requests.filter(r=>r.action==='plan').length;h.state.blockAudio=true;
    h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false && !h.$('next').disabled);assert.equal(h.synthesis.length,1);
    const first=h.audios[0];h.$('pause').click();assert.equal(first.paused,true);h.$('next').click();
    await until(()=>h.audios.length===2 && !h.$('next').disabled);assert.equal(h.synthesis[1].voice,'m');assert.equal(h.audios[1].paused,true);assert.equal(h.$('pause').getAttribute('aria-label'),'Resume Choir audio');
    const seek=document.querySelector('[data-choir-mixer] [aria-label="Seek in current spoken block"]');seek.value='7.5';seek.dispatchEvent(new h.dom.window.Event('input'));await tick();
    assert.equal(h.audios[1].currentTime,7.5);assert.equal(h.store.get('position:chat-a').seconds,7.5);assert.equal(h.store.get('position:chat-a').passage,1);assert.equal(h.synthesis.length,2);
    h.$('previous').click();await until(()=>h.audios.length===3 && !h.$('next').disabled);assert.equal(h.synthesis.length,2);assert.equal(h.audios[2].paused,true);
    h.$('next').click();await until(()=>h.audios.length===4 && !h.$('next').disabled);assert.equal(h.synthesis.length,2);
    h.$('pause').click();assert.equal(h.audios[3].paused,false);h.$('next').click();
    await until(()=>h.audios.length===5 && h.audios[4].paused===false);assert.equal(h.synthesis.length,3);assert.match(h.synthesis[2].text,/door closed/);
    h.$('next').click();await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(h.$('next').disabled,true);assert.equal(h.$('previous').disabled,true);assert.equal(seek.parentElement.hidden,true);
    assert.equal(h.requests.filter(r=>r.action==='plan').length,planned);
  }finally{await h.close();}
});

test('a failed prefetched chunk can be skipped; cancellation disables transport and preserves completed audio',async()=>{
  const h=await harness();try{
    h.message.content=Array.from({length:160},(_,index)=>`lantern${index}`).join(' ')+'. "Hello."';h.$('prefetch').value='1';h.state.failSynthesisAt=2;h.state.blockAudio=true;await h.plan();
    h.$('play').click();await until(()=>h.synthesis.length===2 && h.audios[0]?.paused===false);await tick();h.$('next').click();
    await until(()=>h.audios.length===2 && h.audios[1].paused===false);assert.equal(h.synthesis[2].voice,'m');assert.equal(h.synthesis.length,3);
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));assert.ok(h.audios.every(audio=>audio.paused));assert.equal(h.$('next').disabled,true);
    h.state.active='chat-a';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('restored'));
    h.state.failSynthesisAt=null;h.footer.querySelector('button').click();await until(()=>h.audios.length===3 && h.audios[2].paused===false);await tick();assert.equal(h.synthesis.length,4); // only the formerly failed prefetched chunk is new
  }finally{await h.close();}
});

test('saved recording playback supports previous, next and seeking without synthesis',async()=>{
  const h=await harness();try{
    await h.plan();await h.play();const generated=h.synthesis.length,before=h.audios.length;h.state.blockAudio=true;
    [...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Replay').click();await until(()=>h.audios.length===before+1 && !h.$('next').disabled);
    h.$('next').click();await until(()=>h.audios.length===before+2 && !h.$('next').disabled);assert.match(document.querySelector('[data-choir-mixer]').textContent,/Speaking: Mira/);
    h.$('previous').click();await until(()=>h.audios.length===before+3 && !h.$('previous').disabled);assert.match(document.querySelector('[data-choir-mixer]').textContent,/Speaking: Narrator/);
    const seek=document.querySelector('[data-choir-mixer] [aria-label="Seek in current spoken block"]');seek.value='9';seek.dispatchEvent(new h.dom.window.Event('input'));assert.equal(h.audios.at(-1).currentTime,9);
    h.$('stop').click();await tick();assert.equal(h.synthesis.length,generated);assert.equal(h.store.get('position:chat-a').seconds,9);assert.equal(h.$('previous').disabled,true);
  }finally{await h.close();}
});

test('previous remains available before a saved resume point and does not reapply the old seek offset',async()=>{
  const h=await harness();try{
    await h.plan();await h.play();const generated=h.synthesis.length;h.state.blockAudio=true;h.$('play').click();await until(()=>!h.$('next').disabled);
    h.$('next').click();await until(()=>document.querySelector('[data-choir-mixer]').textContent.includes('Speaking: Mira') && !h.$('next').disabled);
    const slider=document.querySelector('[data-choir-mixer] [aria-label="Seek in current spoken block"]');slider.value='8';slider.dispatchEvent(new h.dom.window.Event('input'));h.$('stop').click();await tick();await h.reload();
    h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false && !h.$('previous').disabled);assert.equal(h.audios.at(-1).currentTime,8);
    const before=h.audios.length;h.$('previous').click();await until(()=>h.audios.length===before+1 && !h.$('next').disabled);assert.match(document.querySelector('[data-choir-mixer]').textContent,/Speaking: Narrator/);
    h.$('next').click();await until(()=>h.audios.length===before+2 && !h.$('next').disabled);assert.match(document.querySelector('[data-choir-mixer]').textContent,/Speaking: Mira/);assert.equal(h.audios.at(-1).currentTime,0);
    assert.equal(h.synthesis.length,generated);assert.equal(h.requests.filter(request=>request.action==='plan').length,1);
  }finally{await h.close();}
});


test('drawer Stop shares the mixer transport; legacy solo and passage selections do not hide audio',async()=>{
  const h=await harness({master:1,channels:{Mira:{volume:1,solo:true},Narrator:{volume:1,mute:false}}});try{
    await h.plan();for(const [key,value] of h.store)if(key.startsWith('plan:'))h.store.set(key,{...value,excluded:[0]});await h.reload();
    for(const name of ['play','pause','next','previous','playSelected','resumePosition','seekHost'])assert.equal(h.root.querySelector('[data-et="'+name+'"]'),null);
    assert.equal(h.root.querySelector('[data-et="stop"]').disabled,true);
    assert.equal(h.root.querySelector('[aria-label^="Select passage"]'),null);assert.equal(h.root.querySelector('[aria-label^="Exclude passage"]'),null);
    assert.equal(h.root.querySelector('[data-et="planDetails"]').open,false);assert.equal(h.footer.querySelector('[aria-label="Next spoken block"]'),null);assert.equal(h.footer.querySelector('input[type="range"]'),null);
    assert.equal(document.querySelectorAll('[aria-label="Next spoken block"]').length,1);assert.equal(document.querySelector('[aria-label="Mira solo"]'),null);
    h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);assert.equal(h.audios.at(-1).volume,1);
    document.querySelector('[aria-label="Narrator silent"]').click();assert.equal(h.audios.at(-1).volume,0);h.$('stop').click();await tick();await h.reload();
    assert.equal(document.querySelector('[aria-label="Narrator silent"]').getAttribute('aria-pressed'),'true');assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
  }finally{await h.close();}
});

test('No voice skips an in-flight failed speaker, persists per chat and reenables only missing audio',async()=>{
  const h=await harness();try{
    await h.plan();h.state.delay=80;h.state.failVoice='n';h.$('play').click();await until(()=>h.synthesis.length===1);
    document.querySelector('[aria-label="Narrator no voice"]').click();await until(()=>h.$('status').textContent.includes('Playback finished'));
    assert.deepEqual(h.synthesis.map(v=>v.voice),['n','m','g']);assert.equal(h.audios.length,2);assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    await h.reload();assert.equal(document.querySelector('[aria-label="Narrator no voice"]').getAttribute('aria-pressed'),'true');
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));assert.equal(document.querySelector('[aria-label="Narrator no voice"]'),null);assert.equal(globalThis.__CHOIR_API__.isNarratorMuted(),false);
    h.state.active='chat-a';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('restored'));assert.equal(document.querySelector('[aria-label="Narrator no voice"]').getAttribute('aria-pressed'),'true');
    h.state.failVoice=null;h.state.delay=0;document.querySelector('[aria-label="Narrator no voice"]').click();await tick();await h.play();
    assert.deepEqual(h.synthesis.slice(3).map(v=>v.voice),['n','n']);assert.equal(h.requests.filter(v=>v.action==='plan').length,1);
  }finally{await h.close();}
});

test('One TTS routes the entire cast without replanning and Several TTS restores saved character routes',async()=>{
  const h=await harness();try{
    await h.plan();await h.play();const planned=h.requests.filter(v=>v.action==='plan').length;
    h.$('connectionMode').value='one';h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.startsWith('One TTS now'));
    assert.ok(JSON.parse(h.$('planJson').value).segments.every(v=>v.route==='native:a'));assert.equal(h.store.get('chat:chat-a').fixed[2].route,'native:b');
    assert.ok([...h.$('fixed').querySelectorAll('[data-choir-route]')].every(v=>v.parentElement.hidden));
    const voices=h.$('fixed').querySelectorAll('[data-choir-voice]');voices[2].value='new';await h.click('save',text=>text.includes('retention saved'));await h.play();
    assert.equal(h.synthesis.at(-1).connectionId,'a');assert.equal(h.synthesis.at(-1).voice,'new');assert.equal(h.requests.filter(v=>v.action==='plan').length,planned);
    await h.reload();assert.equal(h.$('connectionMode').value,'one');assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'new');
    h.$('connectionMode').value='several';h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.startsWith('Several TTS restored'));
    assert.equal(h.$('fixed').querySelectorAll('[data-choir-route]')[2].value,'native:b');assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');
    const before=h.synthesis.length;await h.play();assert.equal(h.synthesis.length,before);assert.equal(h.requests.filter(v=>v.action==='plan').length,planned);
  }finally{await h.close();}
});


test('No voice skips already cached audio and changing it during paused playback preserves the pause',async()=>{
 const h=await harness();try{
  await h.plan();await h.play();const generated=h.synthesis.length;
  document.querySelector('[aria-label="Mira no voice"]').click();await tick();const count=h.audios.length;await h.play();assert.equal(h.audios.length-count,3);assert.equal(h.synthesis.length,generated);
  document.querySelector('[aria-label="Mira no voice"]').click();await tick();h.state.blockAudio=true;h.footer.querySelector('button').click();await until(()=>!h.$('next').disabled);h.$('next').click();await until(()=>document.querySelector('[data-choir-mixer]').textContent.includes('Speaking: Mira') && !h.$('next').disabled);
  h.$('pause').click();document.querySelector('[aria-label="Mira no voice"]').click();await until(()=>document.querySelector('[data-choir-mixer]').textContent.includes('Speaking: Guard') && !h.$('next').disabled);assert.equal(h.audios.at(-1).paused,true);assert.equal(h.synthesis.length,generated);
  h.$('stop').click();await tick();document.querySelector('[aria-label="Mira no voice"]').click();await tick();h.state.blockAudio=false;await h.play();assert.equal(h.synthesis.length,generated);
 }finally{await h.close();}
});

test('One TTS changes the whole cast connection and restores each provider voice choice without replanning',async()=>{
 const h=await harness();try{
  await h.plan();h.$('connectionMode').value='one';h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.startsWith('One TTS now'));
  h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value='new';await h.click('save',text=>text.includes('retention saved'));await h.play();const planned=h.requests.filter(v=>v.action==='plan').length;
  h.$('connection').value='b';h.$('connection').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.includes('Provider selected.'));
  assert.ok(JSON.parse(h.$('planJson').value).segments.every(v=>v.route==='native:b'));await h.click('save',text=>text.includes('retention saved'));const before=h.synthesis.length;await h.play();assert.ok(h.synthesis.slice(before).every(v=>v.connectionId==='b'));
  h.$('connection').value='a';h.$('connection').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.includes('Provider selected.'));
  assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'new');assert.ok(JSON.parse(h.$('planJson').value).segments.every(v=>v.route==='native:a'));assert.equal(h.requests.filter(v=>v.action==='plan').length,planned);
 }finally{await h.close();}
});


test('One TTS rejects an unavailable manually selected voice instead of silently replacing it',async()=>{
 const h=await harness();try{
  await h.plan();h.$('connectionMode').value='one';h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.startsWith('One TTS now'));
  const voice=h.$('fixed').querySelectorAll('[data-choir-voice]')[2],option=document.createElement('option');option.value='missing-voice';option.textContent='Missing';voice.append(option);voice.value='missing-voice';h.$('save').click();await until(()=>h.$('status').classList.contains('et-error'));
  assert.match(h.$('status').textContent,/voice/i);assert.equal(h.synthesis.length,0);assert.equal(h.requests.filter(v=>v.action==='plan').length,1);
 }finally{await h.close();}
});


test('NPC No voice follows the character across One TTS provider changes and can be cleared there',async()=>{
 const h=await harness();try{
  await h.plan();document.querySelector('[aria-label="Guard no voice"]').click();await tick();
  h.$('connectionMode').value='one';h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.startsWith('One TTS now'));
  h.$('connection').value='b';h.$('connection').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.includes('Provider selected.'));
  assert.equal(document.querySelector('[aria-label="Guard no voice"]').getAttribute('aria-pressed'),'true');await h.click('save',text=>text.includes('retention saved'));await h.play();assert.ok(!h.synthesis.some(v=>v.text.includes('Wait')));
  document.querySelector('[aria-label="Guard no voice"]').click();await tick();const before=h.synthesis.length;await h.play();assert.equal(h.synthesis.length,before+1);assert.match(h.synthesis.at(-1).text,/Wait/);
  h.$('connection').value='a';h.$('connection').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.includes('Provider selected.'));assert.equal(document.querySelector('[aria-label="Guard no voice"]').getAttribute('aria-pressed'),'false');assert.equal(h.requests.filter(v=>v.action==='plan').length,1);
 }finally{await h.close();}
});

test('Fish automatic casting excludes foreign voice IDs and plays with the chosen reference ID in both TTS modes',async()=>{
 for(const mode of ['one','several']){
  const h=await harness();try{
   const fishId='0123456789abcdef0123456789abcdef';h.connections[1].provider='fish_audio';
   h.state.catalogues={a:{voices:[{id:'alloy',name:'Alloy'},{id:'coral',name:'Coral'}]},b:{voices:[{id:fishId,name:'Storyteller'}]}};
   h.state.allowedVoices={a:['alloy','coral'],b:[fishId]};h.state.planForCatalogue=true;
   const saved=h.store.get('chat:chat-a');saved.connectionMode=mode;saved.connection=mode==='one'?'b':'a';
   saved.fixed.forEach(actor=>{actor.voice='';});saved.casts={'native:a':[{speaker:'Guard',voice:'',style:''}],'native:b':[{speaker:'Guard',voice:'',style:''}]};
   saved.extraVoices=`${fishId} | A warm Irish storyteller.\nKore | Firm\nvoice_bespoke_old | Gemini design\ncoral | Bright`;
   h.store.set('chat:chat-a',saved);await h.reload();await h.plan();
   const planned=h.requests.find(request=>request.action==='plan').input.config;
   assert.deepEqual(planned.voices.filter(voice=>voice.route==='native:b').map(voice=>voice.id),[fishId]);
   assert.equal(planned.voices.find(voice=>voice.route==='native:b').description,'A warm Irish storyteller.');
   await h.play();assert.ok(h.synthesis.some(request=>request.connectionId==='b'));
   assert.ok(h.synthesis.filter(request=>request.connectionId==='b').every(request=>request.voice===fishId));
   await h.reload();assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,fishId);
   h.message.content='A new dawn. "Hello again."';await h.plan();await h.play();
   assert.ok(h.synthesis.filter(request=>request.connectionId==='b').every(request=>request.voice===fishId));
   if(mode==='one'){
    h.$('connection').value='a';h.$('connection').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.includes('Provider selected.'));
    await h.plan();const switched=h.requests.filter(request=>request.action==='plan').at(-1).input.config;
    assert.ok(switched.voices.every(voice=>voice.route==='native:a' && ['alloy','coral'].includes(voice.id)));
    await h.play();assert.ok(h.synthesis.filter(request=>request.connectionId==='a').every(request=>['alloy','coral'].includes(request.voice)));
   }
  }finally{await h.close();}
 }
});

test('GPT TTS retains unknown-gender choices, recovers built-in voices, and excludes saved Fish voices',async()=>{
 for(const failure of ['normal','empty','error','network']){
  const h=await harness();try{
   const fishId='0123456789abcdef0123456789abcdef';
   h.state.catalogues={a:failure==='normal'?{voices:[{id:'coral',name:'Coral'},{id:'onyx',name:'Onyx'}]}:failure==='error'?{voices:[],error:'Catalogue unavailable'}:{voices:[]}};h.state.failCatalogue=failure==='network';
   const saved=h.store.get('chat:chat-a');saved.connectionMode='one';saved.fixed.forEach(actor=>{actor.voice='';actor.gender='female';});saved.casts={'native:a':[]};
   saved.extraVoices=`${fishId} | Fish storyteller\nKore | Firm`;
   h.store.set('chat:chat-a',saved);h.state.planForCatalogue=true;h.message.content='At dawn. "Hello."';
   h.state.allowedVoices={a:['alloy','ash','ballad','cedar','coral','echo','fable','marin','nova','onyx','sage','shimmer','verse']};
   await h.reload();
   for(const select of h.$('fixed').querySelectorAll('[data-choir-voice]')){
    assert.ok([...select.options].some(option=>option.value==='coral'));
    assert.ok(![...select.options].some(option=>option.value===fishId || option.value==='Kore'));
   }
   await h.plan();assert.equal(h.requests.find(request=>request.action==='plan').input.config.voices.length,failure==='normal'?2:13);
   await h.play();assert.ok(h.synthesis.length);assert.ok(h.synthesis.every(request=>h.state.allowedVoices.a.includes(request.voice)));
   await h.reload();assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,failure==='normal'?'onyx':'verse');
  }finally{await h.close();}
 }
});

test('LLM-selected fixed and NPC voices persist across new replies and reload in both TTS modes',async()=>{
 for(const mode of ['several','one']){
  const h=await harness();try{
   if(mode==='one'){h.$('connectionMode').value='one';h.$('connectionMode').dispatchEvent(new h.dom.window.Event('change'));await until(()=>h.$('status').textContent.startsWith('One TTS now'));}
   for(const node of [h.$('fixed').querySelectorAll('[data-choir-voice]')[2],h.$('npcs').querySelector('[data-choir-voice]')]){node.value='';node.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));}
   await until(()=>h.$('saveState').textContent==='Saved automatically');await h.plan();
   assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');assert.equal(h.$('npcs').querySelector('[data-choir-voice]').value,'g');
   h.message.content='Another dawn. "Hello again." "Wait here." The gate closed.';await h.plan();
   const planned=h.requests.filter(v=>v.action==='plan').at(-1).input.config;assert.equal(planned.fixed.find(actor=>actor.speaker==='Mira').voice,'m');assert.equal(planned.npcs.find(actor=>actor.speaker==='Guard').voice,'g');
   await h.reload();assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');assert.equal(h.$('npcs').querySelector('[data-choir-voice]').value,'g');
  }finally{await h.close();}
 }
});

test('Let LLM choose makes and saves a real choice despite current or reloaded attribution and audio caches',async()=>{
 for(const reload of [false,true]){
  const h=await harness();try{
   await h.plan();await h.play();const voice=h.$('fixed').querySelectorAll('[data-choir-voice]')[2];voice.value='';voice.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
   await until(()=>h.$('saveState').textContent==='Saved automatically');if(reload)await h.reload();
   assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'');assert.equal(h.requests.filter(v=>v.action==='plan').length,1);
   await h.play();assert.equal(h.requests.filter(v=>v.action==='plan').length,2);assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');assert.equal(h.store.get('chat:chat-a').fixed[2].voice,'m');
   h.$('prefetch').value='2';h.$('prefetch').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
   await h.reload();assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');await h.play();assert.equal(h.requests.filter(v=>v.action==='plan').length,2);
  }finally{await h.close();}
 }
});

test('LLM casting receives bounded character and persona descriptions with voice catalogue descriptions',async()=>{
 const h=await harness();try{
  h.state.character={name:'Mira',description:'A mature captain with a husky Irish voice. '+ 'Detail. '.repeat(1500),personality:'Calm, direct, and warm.',system_prompt:'Private card instructions',creator_notes:'Private notes'};
  h.state.persona={id:'persona-a',name:'Alex',description:'A young, softly spoken traveller.'};
  const name=h.$('fixed').children[2].querySelector('input');name.value='Captain Mira';name.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
  await h.plan();const snapshot=h.requests.find(v=>v.action==='plan').input.config;
  assert.deepEqual(snapshot.characterProfiles,[{speaker:'Captain Mira',description:h.state.character.description.slice(0,8000),personality:h.state.character.personality},{speaker:'You',description:h.state.persona.description,personality:''}]);
  assert.equal(snapshot.voices.find(voice=>voice.id==='m' && voice.route==='native:b').description,'A mature, husky Irish voice.');
  assert.ok(!JSON.stringify(snapshot).includes('Private'));assert.ok(!JSON.stringify(h.store.get('chat:chat-a')).includes('mature captain'));
  h.state.failProfile=true;h.message.content='A new dawn.';await h.plan();assert.equal(h.requests.filter(v=>v.action==='plan').at(-1).input.config.characterProfiles.length,1);
 }finally{await h.close();}
});

test('a chosen voice remains visible after a save failure and Retry save persists that choice',async()=>{
 const h=await harness();try{
  const voice=h.$('fixed').querySelectorAll('[data-choir-voice]')[2];voice.value='';voice.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
  h.state.failConfigSave=true;h.$('latest').click();await until(()=>h.$('status').textContent.includes('Settings storage failed') && !h.$('latest').disabled);
  assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');assert.equal(h.$('save').hidden,false);
  h.state.failConfigSave=false;await h.click('save',text=>text.includes('retention saved'));await h.reload();assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');
 }finally{await h.close();}
});

test('retrying partial planning asks the LLM for unassigned voices instead of restoring catalogue defaults',async()=>{
 const h=await harness();try{
  const voice=h.$('fixed').querySelectorAll('[data-choir-voice]')[2];voice.value='';voice.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
  h.message.content=h.message.content.repeat(6);h.state.failPlanAt=2;h.$('latest').click();await until(()=>h.$('status').textContent.includes('Planner quota exhausted') && !h.$('latest').disabled);
  assert.ok([...h.store.keys()].some(key=>key.startsWith('progress:')));assert.equal(h.store.get('chat:chat-a').fixed[2].voice,'');
  const before=h.requests.filter(v=>v.action==='plan');await h.plan();const after=h.requests.filter(v=>v.action==='plan');
  assert.equal(after[before.length].input.transcript,before[0].input.transcript);assert.equal(after[before.length].input.config.fixed[2].voice,'');
  assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'m');assert.equal(h.store.get('chat:chat-a').fixed[2].voice,'m');
 }finally{await h.close();}
});

test('cast and planner edits autosave without Save and survive reload without replanning',async()=>{
 const h=await harness();try{
  await h.plan();const edit=(node,value)=>{node.value=value;node.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));};
  const row=h.$('fixed').children[2];edit(row.querySelector('[data-choir-voice]'),'new');
  const fields=row.querySelectorAll('input');edit(fields[2],'Softer delivery');edit(fields[3],'Captain, Lady Mira');edit(fields[4],'mee-rah');edit(fields[5],'French');
  edit(h.$('planner'),'planner');h.$('normalizeLoudness').checked=false;h.$('normalizeLoudness').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
  await until(()=>h.$('saveState').textContent==='Saved automatically');assert.equal(h.store.get('chat:chat-a').fixed[2].voice,'new');
  await h.reload();assert.equal(h.$('planner').value,'planner');assert.equal(h.$('normalizeLoudness').checked,false);assert.equal(h.$('fixed').querySelectorAll('[data-choir-voice]')[2].value,'new');
  await h.play();assert.equal(h.synthesis.find(v=>v.text.includes('Hello')).voice,'new');assert.equal(h.requests.filter(v=>v.action==='plan').length,1);
 }finally{await h.close();}
});

test('navigation flushes the old chat draft and new chats inherit connections without copying its cast',async()=>{
 const h=await harness();try{
  h.$('planner').value='planner';h.$('planner').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
  const name=h.$('fixed').children[2].querySelector('input');name.value='Captain Mira';name.dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
  h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('saveState').textContent==='Connection preferences restored');
  assert.equal(h.store.get('chat:chat-a').fixed[2].speaker,'Captain Mira');assert.equal(h.$('connection').value,'a');assert.equal(h.$('planner').value,'planner');assert.equal(h.$('fixed').children[2].querySelector('input').value,'Mira');
  h.state.active='chat-a';h.subscriptions.get('chat.active')();await until(()=>h.$('fixed').children[2]?.querySelector('input').value==='Captain Mira');assert.equal(h.$('planner').value,'planner');
 }finally{await h.close();}
});

test('provider selection persists even when its catalogue fails',async()=>{
 const h=await harness();try{
  h.state.failCatalogue=true;h.$('connection').value='b';h.$('connection').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('status').textContent.includes('catalogue unavailable'));
  assert.equal(h.store.get('chat:chat-a').connection,'b');h.state.failCatalogue=false;await h.reload();assert.equal(h.$('connection').value,'b');
 }finally{await h.close();}
});

test('autosave serializes delayed writes, reports storage failure and recovers on the next edit',async()=>{
 const h=await harness();try{
  h.state.configDelay=200;h.$('plannerTokens').value='4096';h.$('plannerTokens').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,280));
  h.$('plannerTokens').value='6144';h.$('plannerTokens').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');assert.equal(h.store.get('chat:chat-a').plannerTokens,6144);
  h.state.configDelay=0;h.state.failConfigSave=true;h.$('prefetch').value='2';h.$('prefetch').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent.includes('Save failed'));assert.equal(h.$('prefetch').value,'2');
  h.state.failConfigSave=false;h.$('prefetch').value='3';h.$('prefetch').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');await h.reload();assert.equal(h.$('prefetch').value,'3');assert.equal(h.$('plannerTokens').value,'6144');
  assert.ok(!JSON.stringify(h.store.get('settings:global')).includes('jevApiKey'));
 }finally{await h.close();}
});

test('chat navigation cancels playback immediately while a pending settings save is slow',async()=>{
 const h=await harness();try{
  await h.plan();h.state.configDelay=200;h.$('plannerTokens').value='4096';h.$('plannerTokens').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
  h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);
  h.state.active='chat-b';h.subscriptions.get('chat.active')();assert.ok(h.audios.every(audio=>audio.paused));assert.equal(h.$('next').disabled,true);
  await until(()=>h.$('saveState').textContent==='Connection preferences restored');assert.equal(h.store.get('chat:chat-a').plannerTokens,4096);
 }finally{await h.close();}
});

test('invalid TTS chunk edits never overwrite saved settings and valid boundaries survive reload',async()=>{
 const h=await harness();try{
  for(const value of ['', '79', '10001', '80.5']){
   h.$('chunk').value=value;h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
   h.$('planner').value='planner';h.$('planner').dispatchEvent(new h.dom.window.Event('change'));
   await new Promise(resolve=>setTimeout(resolve,280));
   assert.equal(h.store.get('chat:chat-a').chunk,500);assert.equal(h.store.has('settings:global'),false);
   assert.match(h.$('status').textContent,/Max characters per request.*80.*10000.*1800/);
   assert.match(h.$('saveState').textContent,/Not saved/);
   h.$('save').click();await tick();assert.equal(h.store.get('chat:chat-a').chunk,500);
  }
  for(const value of ['80','2000','10000']){
   h.$('chunk').value=value;h.$('chunk').dispatchEvent(new h.dom.window.Event('input',{bubbles:true}));
   await until(()=>h.$('saveState').textContent==='Saved automatically');
   assert.equal(h.store.get('chat:chat-a').chunk,Number(value));await h.reload();assert.equal(h.$('chunk').value,value);
  }
 }finally{await h.close();}
});

test('several LLM sound effects in one passage play in story order before their anchor words',async()=>{
 const h=await harness();try{
  await configureFoley(h);h.message.content='The page snapped as the glass shattered on the floor.';
  await h.plan();await h.play();
  assert.deepEqual(h.requests.filter(request=>request.action==='freesound').map(request=>request.input.query),['page turn','glass shatter']);
  const order=(await Promise.all(h.audioBlobs.map(blob=>blob.text()))).map(text=>text==='FREESOUND_PREVIEW'?'sfx':'speech');
  assert.deepEqual(order,['speech','sfx','speech','sfx','speech']);
  assert.deepEqual(h.synthesis.map(request=>request.text),['The','page snapped as the','glass shattered on the floor.']);
 }finally{await h.close();}
});

test('edits that only add images or trackers keep the plan, playback and saved audio; spoken edits still replan',async()=>{
  const h=await harness();try{
    await h.plan();h.state.delay=50;h.$('play').click();await until(()=>h.synthesis.length>0);
    h.message.content='At dawn. ![scene](https://img.test/a.png) "Hello." <img src="b.png">\n\n"Wait." The gate closed.\n<div class="tracker">Time: 06:00 | Mood: calm</div>';
    h.events.get('MESSAGE_EDITED')({messageId:'message-a',chatId:'chat-a'});await tick();
    assert.equal(h.state.aborted,0);assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(h.synthesis.length,4);
    h.state.delay=0;await h.reload();await h.play();
    assert.equal(h.synthesis.length,4);assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
    h.message.content='At dawn. "Greetings." "Wait." The gate closed.';h.events.get('MESSAGE_EDITED')({messageId:'message-a',chatId:'chat-a'});
    assert.equal(h.$('preview').children.length,0);
  }finally{await h.close();}
});
