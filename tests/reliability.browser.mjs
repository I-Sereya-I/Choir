import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {setup} from '../dist/frontend.js';
import {validatePlan,speechSourceUnits,planningSections} from '../src/core.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(predicate)=>{for(let i=0;i<250;i++){if(predicate())return;await tick();}throw Error('Timed out waiting for regression state');};

async function harness(mixerPreferences){
  const dom=new JSDOM('<body><nav><button>Another extension</button><div data-choir-toolbar></div></nav><main></main><footer></footer></body>',{url:'https://lumiverse.test'});
  const original={document:globalThis.document,Audio:globalThis.Audio,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB};
  globalThis.document=dom.window.document;globalThis.indexedDB=new IDBFactory();
  const root=document.querySelector('main'),footer=document.querySelector('footer'),toolbar=document.querySelector('[data-choir-toolbar]');
  const state={active:'chat-a',blockAudio:false,failVoice:null,delay:0,held:false,aborted:0,previewFetches:[],previewAborted:0},store=new Map(),requests=[],synthesis=[],audios=[],audioBlobs=[],events=new Map(),subscriptions=new Map(),heldPlans=[],toolbarActions=new Map();
  const createObjectURL=URL.createObjectURL;URL.createObjectURL=blob=>{audioBlobs.push(blob);return createObjectURL(blob);};
  if(mixerPreferences)store.set('ui:mixer',mixerPreferences);
  const message={id:'message-a',content:'At dawn. "Hello." "Wait." The gate closed.',name:'Mira',is_user:false};
  store.set('chat:chat-a',{mode:'native',connection:'a',styleParam:'instructions',chunk:500,concurrency:1,prefetch:0,
    fixed:[{speaker:'Narrator',voice:'n',style:'Calm'},{speaker:'You',voice:'y',style:''},{speaker:'Mira',voice:'m',route:'native:b',style:'',aliases:['Captain'],pronunciation:'Mira: mee-rah',accent:'Irish'}],
    casts:{'native:a':[{speaker:'Guard',voice:'g',style:''}]}});
  class FakeAudio{
    constructor(){this.paused=true;this.currentTime=0;this.duration=20;audios.push(this);}
    play(){this.paused=false;this.onloadedmetadata?.();if(!state.blockAudio)setTimeout(()=>{this.currentTime=20;this.onended?.();},2);return Promise.resolve();}
    pause(){this.paused=true;}
  }
  globalThis.Audio=FakeAudio;
  const connections=[{id:'a',name:'Narration provider',provider:'openai_tts',model:'model-a'},{id:'b',name:'Character provider',provider:'accent_tts',model:'model-b'}];
  globalThis.fetch=async(url,options={})=>{
    if(url==='https://freesound.test/preview.mp3'){
      state.previewFetches.push(url);
      if(state.holdPreview)await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{state.previewAborted++;reject(new DOMException('Stopped','AbortError'));},{once:true}));
      return new Response('FREESOUND_PREVIEW',{status:state.previewStatus || 200,headers:{'Content-Type':state.previewType || 'audio/mpeg'}});
    }
    if(url.endsWith('/tts/synthesize')){
      const input=JSON.parse(options.body);synthesis.push(input);const requestNumber=synthesis.length;
      if(state.delay)await new Promise((resolve,reject)=>{
        const timeout=setTimeout(resolve,state.delay);
        options.signal.addEventListener('abort',()=>{clearTimeout(timeout);state.aborted++;reject(new DOMException('Stopped','AbortError'));},{once:true});
      });
      if(input.voice===state.failVoice || requestNumber===state.failSynthesisAt)return new Response('Provider quota exhausted',{status:429});
      return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}});
    }
    let value;
    if(url.includes('/providers'))value={providers:[{id:'openai_tts',capabilities:{parameters:{instructions:{type:'string'}}}},{id:'accent_tts',capabilities:{parameters:{instructions:{type:'string'},accent:{enum:['Irish','French']}}}}]};
    else if(url.endsWith('/voices')){if(state.failCatalogue)throw Error('Voice catalogue unavailable');value={voices:['n','y','m','g','new'].map(id=>({id,name:id,description:id==='m'?'A mature, husky Irish voice.':'A light, youthful voice.'}))};}
    else if(url.includes('/personas/'))value=state.persona;
    else if(url.includes('/decision-connections?'))value={data:[{id:'decision-a',name:'Decision A',provider:'typesafe',model:'jev'},{id:'decision-b',name:'Decision B',provider:'typesafe',model:'jev'}]};
    else if(url.includes('/connections?'))value={data:[{id:'planner',name:'Planner',model:'text-model'}]};
    else value={data:connections};
    return Response.json(value);
  };
  let backend,decorationCleanup;
  const ctx={settings:{get:async key=>structuredClone(store.get(key) ?? null),set:async(key,value)=>{const snapshot=structuredClone(value);if(state.failPlanSave && /^(plan:|activeplan:)/.test(key) || state.failConfigSave && /^(chat:|settings:)/.test(key))throw Error('Settings storage failed');if(state.configDelay && /^(chat:|settings:)/.test(key))await new Promise(resolve=>setTimeout(resolve,state.configDelay));store.set(key,snapshot);}},
    messages:{getRecent:()=>state.active==='chat-a'?[message]:[],getContent:id=>id===message.id && state.active==='chat-a'?message.content:null},
    state:{get:key=>key==='persona.activeId'?state.persona?.id:undefined,subscribe:(key,fn)=>{subscriptions.set(key,fn);return()=>subscriptions.delete(key);}},events:{on:(key,fn)=>{events.set(key,fn);return()=>events.delete(key);}},
    characters:{get:async()=>{if(state.failProfile)throw Error('Character unavailable');return state.character || {name:'Mira'};}},getActiveChat:()=>({chatId:state.active,characterId:'mira'}),dom:{addStyle:()=>()=>{}},
    ui:{mount:point=>point==='chat_actions'?toolbar:undefined,registerDrawerTab:()=>({root,activate(){},destroy(){root.replaceChildren();}}),registerInputBarAction:options=>{const action={...options,onClick(handler){this.click=handler;},destroy(){if(toolbarActions.get(options.id)===action)toolbarActions.delete(options.id);}};toolbarActions.set(options.id,action);return action;},
      registerDomDecorator:options=>{decorationCleanup=options.render(footer,{messageId:message.id});return decorationCleanup;}},
    onBackendMessage:fn=>{backend=fn;return()=>backend=null;},sendToBackend:request=>{
      requests.push(structuredClone(request));if(request.action==='cancel')return;
      setTimeout(()=>{
        if(!backend)return;
        if(request.action==='plan' && state.held || request.action==='designVoice' && state.holdDesignVoice || request.action==='freesound' && state.holdFoley){heldPlans.push(request);return;}
        if(request.action==='plan' && state.failPlanAt===requests.filter(r=>r.action==='plan').length){backend({namespace:'choir',id:request.id,error:'Planner quota exhausted'});return;}
        let result;
        if(request.action==='ping')result={ready:true};
        else if(request.action==='freesound'){
          if(state.foleyError){backend({namespace:'choir',id:request.id,error:state.foleyError});return;}
          result={results:state.noFoleyResults?[]:[{id:123,name:'Page turn',previewUrl:'https://freesound.test/preview.mp3'}]};
        }
        else if(request.action==='gemini')result={base64:'AAABAA==',mimeType:'audio/L16;rate=24000'};
        else if(request.action==='testPlanner')result={provider:'Planner',model:'text-model',response:'READY'};
        else if(request.action==='planJev'){backend({namespace:'choir',id:request.id,...(state.jevInvalid?{result:{}}:{error:'Jev classification failed: The object cannot be cloned'})});return;}
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
    releaseHeld(){for(const request of heldPlans.splice(0))backend?.({namespace:'choir',id:request.id,result:{segments:[{speaker:'Narrator',voice:'n',text:request.input.transcript,style:''}]}});},
    async close(){cleanup();await tick();URL.createObjectURL=createObjectURL;Object.assign(globalThis,original);dom.window.close();}};
}

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

test('Choir chat plays Freesound preview audio at the cue, preserves speech, caches it across reload and honors the SFX toggle',async()=>{
 const h=await harness();try{
  assert.equal(h.$('enableSfx').closest('label').hidden,false);await configureFoley(h);h.message.content='She listened. The page snapped under her thumb.';
  await h.plan();await h.play();assert.equal(await playedFoley(h),1);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);assert.equal(h.state.previewFetches.length,1);
  assert.equal(h.synthesis.map(request=>request.text).join(' '),h.message.content);assert.ok(h.synthesis.every(request=>!request.text.includes('[SFX:')));
  const sfxIndex=(await Promise.all(h.audioBlobs.map(blob=>blob.text()))).indexOf('FREESOUND_PREVIEW');
  assert.ok(Math.abs(h.audios[sfxIndex].volume/h.audios[0].volume-0.45)<0.001);assert.equal(h.$('sfxStatus').hidden,true);
  await h.reload();await h.play();assert.equal(await playedFoley(h),2);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);assert.equal(h.state.previewFetches.length,1);
  h.$('enableSfx').checked=false;h.$('enableSfx').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await until(()=>h.$('saveState').textContent==='Saved automatically');
  const replay=[...h.$('messages').querySelectorAll('button')].find(button=>button.textContent==='Replay');replay.click();await until(()=>h.$('status').textContent==='Replay finished.');assert.equal(await playedFoley(h),2);
  await h.play();assert.equal(await playedFoley(h),2);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);await h.reload();assert.equal(h.$('enableSfx').checked,false);
 }finally{await h.close();}
});

test('Freesound failures stay visible, continue speech, and retry without regenerating cached narration',async()=>{
 for(const failure of ['key','auth','empty','preview','type']){
  const h=await harness();try{
   await configureFoley(h,failure==='key'?'':'test-freesound-key');h.message.content='The page snapped under her thumb.';
   if(failure==='auth')h.state.foleyError='Freesound HTTP 401';if(failure==='empty')h.state.noFoleyResults=true;if(failure==='preview')h.state.previewStatus=503;if(failure==='type')h.state.previewType='text/html';
   await h.plan();await h.play();assert.equal(await playedFoley(h),0);assert.equal(h.synthesis.map(request=>request.text).join(' '),h.message.content);
   assert.match(h.$('status').textContent,/SFX skipped/);assert.equal(h.$('sfxStatus').hidden,false);assert.match(h.$('sfxStatus').textContent,/Speech continues/);
   const generated=h.synthesis.length;h.state.foleyError=null;h.state.noFoleyResults=false;h.state.previewStatus=200;h.state.previewType='audio/mpeg';if(failure==='key')await configureFoley(h);
   await h.play();assert.equal(await playedFoley(h),1);assert.equal(h.synthesis.length,generated);assert.equal(h.$('sfxStatus').hidden,true);
  }finally{await h.close();}
 }
});

test('SFX mixer channel changes live effects independently, applies to Cue and cached replay, and persists after reload',async()=>{
 const h=await harness();try{
  const level=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000001,`Expected volume ${expected}, got ${actual}`);
  h.$('showMixer').click();const mixer=document.querySelector('[data-choir-mixer]'),sfxRow=()=>mixer.querySelector('[data-speaker="SFX"]');
  assert.equal(mixer.querySelector('.cm-channel'),sfxRow());assert.equal(sfxRow().querySelector('[aria-label="SFX no voice"]'),null);
  await configureFoley(h);h.message.content='The page snapped under her thumb.';await h.plan();h.state.blockAudio=true;h.$('play').click();
  await until(()=>h.audios.length===1 && !h.audios[0].paused);const narrator=h.audios[0];assert.equal(narrator.volume,1);narrator.onended();
  await until(()=>sfxRow().getAttribute('aria-current')==='true' && h.audios.length===2 && !h.audios[1].paused);const effect=h.audios[1];assert.equal(effect.volume,0.45);
  const volume=sfxRow().querySelector('[aria-label="SFX volume"]');volume.value='0.4';volume.dispatchEvent(new h.dom.window.Event('input'));volume.dispatchEvent(new h.dom.window.Event('change'));level(effect.volume,0.18);assert.equal(sfxRow().querySelector('.cm-percent').textContent,'40%');
  const master=mixer.querySelector('[aria-label="Master volume"]');master.value='0.5';master.dispatchEvent(new h.dom.window.Event('input'));master.dispatchEvent(new h.dom.window.Event('change'));level(effect.volume,0.09);
  sfxRow().querySelector('[aria-label="SFX silent"]').click();assert.equal(effect.volume,0);sfxRow().querySelector('[aria-label="SFX silent"]').click();level(effect.volume,0.09);
  assert.equal(mixer.querySelector('[aria-label="Narrator volume"]').value,'1');h.state.blockAudio=false;effect.onended();await until(()=>h.$('status').textContent.includes('Playback finished'));assert.equal(h.audios.at(-1).volume,0.5);
  const cueStart=h.audios.length;await globalThis.__CHOIR_API__.playParagraph({text:h.message.content});level(h.audios[cueStart+1].volume,0.09);assert.equal(h.audios[cueStart].volume,0.5);
  sfxRow().querySelector('[aria-label="SFX silent"]').click();await until(()=>h.store.get('ui:mixer')?.channels.SFX.mute===true);await h.reload();
  assert.equal(document.querySelector('[aria-label="SFX volume"]').value,'0.4');assert.equal(document.querySelector('[aria-label="SFX silent"]').getAttribute('aria-pressed'),'true');
  const replayStart=h.audios.length,generated=h.synthesis.length;await h.play();assert.equal(h.audios[replayStart+1].volume,0);assert.equal(h.audios[replayStart].volume,0.5);assert.equal(h.synthesis.length,generated);assert.equal(h.requests.filter(request=>request.action==='freesound').length,1);
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
  h.$('muteNarrator').checked=true;h.$('muteNarrator').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));h.$('auto').checked=true;h.$('auto').dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));
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

test('429 retains completed audio across reload and retry bills only missing passages',async()=>{
  const h=await harness();try{
    await h.plan();h.state.failVoice='g';await h.click('play',text=>text.includes('Completed passages were retained'));
    assert.equal(h.synthesis.length,3);await until(()=>h.$('preview').textContent.includes('Cached'));
    await h.reload();h.state.failVoice=null;await h.play();
    assert.equal(h.synthesis.length,5);assert.deepEqual(h.synthesis.slice(3).map(r=>r.voice),['g','n']);
    assert.equal(h.requests.filter(r=>r.action==='plan').length,1);
  }finally{await h.close();}
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
    assert.ok(h.$('play').disabled);
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
    h.state.active='chat-b';h.subscriptions.get('chat.active')();await until(()=>h.$('status').textContent.includes('Ready.'));assert.equal(document.querySelector('[aria-label="Narrator no voice"]').getAttribute('aria-pressed'),'false');
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
