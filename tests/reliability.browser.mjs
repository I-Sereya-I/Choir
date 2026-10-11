import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {setup} from '../dist/frontend.js';
import {validatePlan,speechSourceUnits,planningSections} from '../src/core.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async(predicate)=>{for(let i=0;i<250;i++){if(predicate())return;await tick();}throw Error('Timed out waiting for regression state');};

async function harness(mixerPreferences){
  const dom=new JSDOM('<body><main></main><footer></footer></body>',{url:'https://lumiverse.test'});
  const original={document:globalThis.document,Audio:globalThis.Audio,fetch:globalThis.fetch,indexedDB:globalThis.indexedDB};
  globalThis.document=dom.window.document;globalThis.indexedDB=new IDBFactory();
  const root=document.querySelector('main'),footer=document.querySelector('footer');
  const state={active:'chat-a',blockAudio:false,failVoice:null,delay:0,held:false,aborted:0},store=new Map(),requests=[],synthesis=[],audios=[],events=new Map(),subscriptions=new Map(),heldPlans=[];
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
    if(url.endsWith('/tts/synthesize')){
      const input=JSON.parse(options.body);synthesis.push(input);
      if(state.delay)await new Promise((resolve,reject)=>{
        const timeout=setTimeout(resolve,state.delay);
        options.signal.addEventListener('abort',()=>{clearTimeout(timeout);state.aborted++;reject(new DOMException('Stopped','AbortError'));},{once:true});
      });
      if(input.voice===state.failVoice)return new Response('Provider quota exhausted',{status:429});
      return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}});
    }
    let value;
    if(url.includes('/providers'))value={providers:[{id:'openai_tts',capabilities:{parameters:{instructions:{type:'string'}}}},{id:'accent_tts',capabilities:{parameters:{instructions:{type:'string'},accent:{enum:['Irish','French']}}}}]};
    else if(url.endsWith('/voices'))value={voices:['n','y','m','g','new'].map(id=>({id,name:id}))};
    else if(url.includes('/connections?'))value={data:[{id:'planner',name:'Planner',model:'text-model'}]};
    else value={data:connections};
    return Response.json(value);
  };
  let backend,decorationCleanup;
  const ctx={settings:{get:async key=>structuredClone(store.get(key) ?? null),set:async(key,value)=>{if(state.failPlanSave && /^(plan:|activeplan:)/.test(key))throw Error('Settings storage failed');store.set(key,structuredClone(value));}},
    messages:{getRecent:()=>state.active==='chat-a'?[message]:[],getContent:id=>id===message.id && state.active==='chat-a'?message.content:null},
    state:{subscribe:(key,fn)=>{subscriptions.set(key,fn);return()=>subscriptions.delete(key);}},events:{on:(key,fn)=>{events.set(key,fn);return()=>events.delete(key);}},
    characters:{get:async()=>({name:'Mira'})},getActiveChat:()=>({chatId:state.active,characterId:'mira'}),dom:{addStyle:()=>()=>{}},
    ui:{registerDrawerTab:()=>({root,activate(){},destroy(){root.replaceChildren();}}),registerInputBarAction:()=>({onClick(){},destroy(){}}),
      registerDomDecorator:options=>{decorationCleanup=options.render(footer,{messageId:message.id});return decorationCleanup;}},
    onBackendMessage:fn=>{backend=fn;return()=>backend=null;},sendToBackend:request=>{
      requests.push(request);if(request.action==='cancel')return;
      setTimeout(()=>{
        if(!backend)return;
        if(request.action==='plan' && state.held){heldPlans.push(request);return;}
        if(request.action==='plan' && state.failPlanAt===requests.filter(r=>r.action==='plan').length){backend({namespace:'choir',id:request.id,error:'Planner quota exhausted'});return;}
        let result;
        if(request.action==='ping')result={ready:true};
        else if(request.action==='testPlanner')result={provider:'Planner',model:'text-model',response:'READY'};
        else if(request.action==='planJev'){backend({namespace:'choir',id:request.id,error:'Jev classification failed: The object cannot be cloned'});return;}
        else if(request.action==='plan')result=validatePlan({segments:speechSourceUnits(request.input.transcript).map(unit=>({
          text:unit.text,speaker:unit.kind==='narration'?'Narrator':unit.text.includes('Wait')?'Guard':'Mira',voice:unit.kind==='narration'?'n':unit.text.includes('Wait')?'g':'m',style:unit.kind==='dialogue'?'Warm':''
        }))},request.input.transcript,request.input.config);
        backend({namespace:'choir',id:request.id,result});
      },2);
    }};
  let cleanup=await setup(ctx);
  const $=name=>root.querySelector(`[data-et="${name}"]`);
  const click=async(name,done)=>{$(name).click();await until(()=>done($('status').textContent));};
  const plan=()=>click('latest',text=>text.startsWith('Ready:') || text.includes('Saved attribution'));
  const play=()=>click('play',text=>text.includes('Playback finished'));
  const reload=async()=>{cleanup();cleanup=await setup(ctx);};
  return {dom,state,store,requests,synthesis,audios,message,events,subscriptions,root,footer,$,click,plan,play,reload,async remount(){cleanup=await setup(ctx);},
    releaseHeld(){for(const request of heldPlans.splice(0))backend?.({namespace:'choir',id:request.id,result:{segments:[{speaker:'Narrator',voice:'n',text:request.input.transcript,style:''}]}});},
    async close(){cleanup();await tick();Object.assign(globalThis,original);dom.window.close();}};
}

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

test('selection and exclusion retain all text, resume seeks, mixer controls and position survive reload',async()=>{
  const h=await harness();try{
    h.$('showMixer').click();
    await h.plan();const select=h.$('preview').querySelector('[aria-label="Select passage 2"]');select.checked=true;select.dispatchEvent(new h.dom.window.Event('change'));
    await h.click('playSelected',text=>text.includes('Playback finished'));assert.equal(h.synthesis.length,1);
    assert.equal(h.synthesis[0].voice,'m');assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    const excluded=h.$('preview').querySelector('[aria-label="Exclude passage 3"]');excluded.checked=true;excluded.dispatchEvent(new h.dom.window.Event('change'));await tick();
    h.state.blockAudio=true;h.$('play').click();await until(()=>h.audios.at(-1)?.paused===false);
    const audio=h.audios.at(-1);audio.currentTime=7;audio.ontimeupdate?.();
    const mixer=document.querySelector('[data-choir-mixer]');assert.match(mixer.textContent,/Speaking: Narrator/);
    const master=mixer.querySelector('[aria-label="Master volume"]');master.value='0.5';master.dispatchEvent(new h.dom.window.Event('input'));master.dispatchEvent(new h.dom.window.Event('change'));assert.equal(audio.volume,0.5);
    mixer.querySelector('[aria-label="Narrator mute"]').click();assert.equal(audio.volume,0);
    mixer.querySelector('[aria-label="Narrator mute"]').click();mixer.querySelector('[aria-label="Mira solo"]').click();assert.equal(audio.volume,0);
    mixer.querySelector('[aria-label="Mira solo"]').click();assert.equal(audio.volume,0.5);
    const header=mixer.firstChild;header.dispatchEvent(new h.dom.window.MouseEvent('pointerdown',{bubbles:true,clientX:20,clientY:80}));header.dispatchEvent(new h.dom.window.MouseEvent('pointermove',{bubbles:true,clientX:90,clientY:160}));header.dispatchEvent(new h.dom.window.MouseEvent('pointerup',{bubbles:true}));
    h.$('stop').click();await tick();assert.equal(h.store.get('position:chat-a').seconds,7);
    await h.reload();assert.equal(document.querySelector('[data-choir-mixer]').style.left,'90px');assert.equal(h.$('preview').querySelector('[aria-label="Exclude passage 3"]').checked,true);
    const before=h.synthesis.length;h.$('resumePosition').click();await until(()=>h.audios.at(-1)?.paused===false);assert.equal(h.audios.at(-1).currentTime,7);
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
    const mira=h.$('fixed').querySelectorAll('.et-card')[2].querySelector('input[type="checkbox"]'),guard=h.$('npcs').querySelector('input[type="checkbox"]');
    mira.checked=true;guard.checked=true;await h.click('save',text=>text.includes('retention saved'));await h.play();
    assert.deepEqual(h.synthesis.map(input=>input.voice),['n','n']);assert.equal(h.$('preview').querySelectorAll('.et-card').length,4);
    h.$('fixed').querySelectorAll('.et-card')[2].querySelector('input[type="checkbox"]').checked=false;
    h.$('npcs').querySelector('input[type="checkbox"]').checked=false;await h.click('save',text=>text.includes('retention saved'));await h.play();
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

test('guided tests are independent; Jev fallback is off by default and keys never enter saved settings or cast export',async()=>{
  const h=await harness();try{
    await h.click('guidePlanner',text=>text.includes('Planner test passed'));assert.equal(h.synthesis.length,0);
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
