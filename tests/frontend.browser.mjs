import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {validatePlan} from '../src/core.js';
import {setup} from '../dist/frontend.js';
const require=process.env.CHOIR_TEST_MODULES?createRequire(path.join(process.env.CHOIR_TEST_MODULES,'package.json')):createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setTimeout(r,15));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw new Error('UI did not reach the expected state.');};

test('frontend plans, persists NPCs, plays sequentially, stops, switches chat and disposes',async()=>{
  const dom=new JSDOM('<body><main></main></body>',{url:'https://lumiverse.test'});
  const old={document:globalThis.document,Audio:globalThis.Audio,fetch:globalThis.fetch};
  globalThis.document=dom.window.document;
  let onBackend,active='chat-a';const listeners=new Map(),events=new Map(),store=new Map(),requests=[],audios=[];
  const message={id:'message-a',chat_id:'chat-a',name:'Mira',is_user:false,content:'The hall fell silent. Hello, stranger. Welcome.',extra:{}};
  const nativeRequests=[];
  let blockAudio=false;
  class FakeAudio {
    constructor(url){this.url=url;this.paused=true;audios.push(this);}
    play(){this.paused=false;if(!blockAudio)setTimeout(()=>this.onended?.(),2);return Promise.resolve();}
    pause(){this.paused=true;}
  }
  globalThis.Audio=FakeAudio;
  globalThis.fetch=async(url,options={})=>{
    if(url.endsWith('/tts/synthesize')){nativeRequests.push(JSON.parse(options.body));return new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'audio/mpeg'}});}
    let value;
    if(url.includes('/providers'))value={providers:[{id:'openai_tts',capabilities:{parameters:{instructions:{type:'string'}}}}]};
    else if(url.endsWith('/voices'))value={voices:['alloy','coral','onyx','echo'].map(id=>({id,name:id}))};
    else value={data:[{id:'native-a',name:'OpenAI',provider:'openai_tts',model:'gpt-4o-mini-tts'}]};
    return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  };
  const root=dom.window.document.querySelector('main');
  const settingsRoot=dom.window.document.createElement('section');
  const settingsMount=dom.window.document.createElement('section');
  const placementListeners=new Map();
  const ctx={
    settings:{get:async key=>store.get(key),set:async(key,value)=>store.set(key,structuredClone(value))},
    messages:{getRecent:()=>active==='chat-a'?[message]:[],getContent:id=>id===message.id?message.content:null},
    state:{subscribe:(key,fn)=>{listeners.set(key,fn);return()=>listeners.delete(key);}},
    connections:{list:()=>[]},characters:{get:async()=>({name:'Mira'})},getActiveChat:()=>({chatId:active,characterId:'character-a'}),
    dom:{addStyle:()=>()=>{}},
    ui:{
      registerDrawerTab:()=>({root,activate(){placementListeners.get('drawer')?.();},destroy(){root.replaceChildren();},onActivate(fn){placementListeners.set('drawer',fn);return()=>placementListeners.delete('drawer');}}),
      registerSettingsTab:options=>{assert.equal(options.id,'choir');return {root:settingsRoot,activate(){placementListeners.get('settings')?.();},destroy(){settingsRoot.replaceChildren();},onActivate(fn){placementListeners.set('settings',fn);return()=>placementListeners.delete('settings');}};},
      mount:name=>{assert.equal(name,'settings_extensions');return settingsMount;},
      registerInputBarAction:()=>({onClick(){},destroy(){}})
    },
    events:{on:(key,fn)=>{events.set(key,fn);return()=>events.delete(key);}},
    onBackendMessage:fn=>{onBackend=fn;return()=>onBackend=null;},
    sendToBackend:message=>{
      requests.push(message);if(message.action==='cancel')return;
      setTimeout(()=>{
        let result;
        if(message.action==='ping')result={version:'1.0.3',ready:true};
        else if(message.action==='plan')result=validatePlan({segments:[
          {speaker:'Narrator',text:'The hall fell silent.',style:'Calm'},
          {speaker:'Mira',text:'Hello, stranger.',style:'Curious'},
          {speaker:'Guard',voice:message.input.config.voices.at(-1).id,text:'Welcome.',style:'Warm'}]},message.input.transcript,message.input.config);
        else result={base64:'UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=',mimeType:'audio/wav'};
        onBackend?.({namespace:'choir',id:message.id,result});
      },2);
    }
  };
  try {
    const cleanup=await setup(ctx);
    const $=name=>root.querySelector(`[data-et="${name}"]`) || settingsRoot.querySelector(`[data-et="${name}"]`);
    assert.equal($('fixed').querySelectorAll('.et-card').length,3);
    $('key').value='session-key';
    settingsMount.querySelector('button').click();
    assert.ok(settingsRoot.querySelector('[data-et="fixed"]'));
    assert.equal($('key').value,'session-key');
    placementListeners.get('drawer')();
    assert.ok(root.querySelector('[data-et="fixed"]'));
    // Drawer roots can be detached when the user is looking at the story.
    root.remove();
    $('latest').click();await until(()=>$('preview').querySelectorAll('.et-card').length===3);
    assert.equal($('preview').querySelectorAll('.et-card').length,3);
    assert.equal(store.get('chat:chat-a').casts.gemini[0].speaker,'Guard');
    $('key').value='test-key';$('play').click();await until(()=>$('status').textContent.includes('finished'));
    assert.equal(audios.length,3);assert.match($('status').textContent,/finished/);
    assert.ok(!JSON.stringify([...store.values()]).includes('test-key'));
    blockAudio=true;$('play').click();await tick();const previous=requests.filter(v=>v.action==='gemini').length;
    $('stop').click();await tick();assert.equal(requests.filter(v=>v.action==='gemini').length,previous);
    assert.ok(audios.at(-1).paused);
    blockAudio=false;
    $('mode').value='native';$('mode').dispatchEvent(new dom.window.Event('change'));await tick();
    $('connection').value='native-a';$('connection').dispatchEvent(new dom.window.Event('change'));await tick();
    for(const [index,select] of [...$('fixed').querySelectorAll('select')].entries())select.value=['alloy','coral','onyx'][index];
    $('styleParam').value='instructions';$('save').click();await tick();
    $('latest').click();await until(()=>$('preview').querySelectorAll('.et-card').length===3);
    $('play').click();await until(()=>$('status').textContent.includes('finished'));
    assert.equal(nativeRequests.length,3);
    assert.equal(nativeRequests[0].voice,'alloy');assert.equal(nativeRequests[0].connectionId,'native-a');
    assert.equal(nativeRequests[0].parameters.instructions,'Clear, measured narration. Calm');
    assert.equal(nativeRequests[2].voice,'echo');
    message.content='Edited reply.';events.get('MESSAGE_EDITED')({messageId:'message-a'});
    assert.ok($('play').disabled);
    active='chat-b';listeners.get('chat.active')();await tick();await tick();
    assert.match($('npcs').textContent,/No NPCs/);
    cleanup();assert.equal(root.children.length,0);assert.equal(listeners.size,0);assert.equal(events.size,0);
    assert.equal(settingsRoot.children.length,0);assert.equal(settingsMount.children.length,0);assert.equal(placementListeners.size,0);
  } finally {Object.assign(globalThis,old);dom.window.close();}
});

test('older hosts show a visible settings diagnostic rather than disappearing',async()=>{
  const dom=new JSDOM('<body><main></main><section></section></body>');
  const previous=globalThis.document;globalThis.document=dom.window.document;
  const root=dom.window.document.querySelector('main');const mount=dom.window.document.querySelector('section');
  try {
    const cleanup=await setup({messages:{},ui:{registerDrawerTab:()=>({root,activate(){},destroy(){root.replaceChildren();}}),mount:()=>mount}});
    assert.match(root.textContent,/newer Lumiverse staging/);
    assert.equal(mount.querySelector('button').textContent,'Open Choir settings');
    cleanup();assert.equal(root.children.length,0);assert.equal(mount.children.length,0);
  } finally {globalThis.document=previous;dom.window.close();}
});
