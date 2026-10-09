import { GEMINI_VOICES, normalizeName, transcriptFromMessage, validateCastConfig, validatePlan, parsePlanJson, splitSegment, audioBytes } from './core.js';

export async function setup(ctx) {
  if (!ctx.settings || !ctx.messages.getRecent || !ctx.messages.getContent || !ctx.state) {
    throw new Error('Lumivoice requires current Lumiverse staging (message readers, state selectors and settings API).');
  }
  const tab = ctx.ui.registerDrawerTab({id:'ensemble',title:'Lumivoice',shortName:'Voices',
    description:'Cast and play your story with multiple voices',keywords:['tts','audio','voices','narrator']});
  const removeStyle = ctx.dom.addStyle(`
    .ensemble-tts{padding:18px;max-width:850px;margin:auto;font:inherit;line-height:1.5;color:inherit}
    .ensemble-tts h2{font-size:1.3em;margin:0 0 8px}.ensemble-tts h3{font-size:1em;margin:22px 0 8px}
    .ensemble-tts p{opacity:.8;margin:8px 0}.ensemble-tts label{display:grid;gap:5px;font-size:.9em}
    .ensemble-tts input,.ensemble-tts select,.ensemble-tts textarea{width:100%;box-sizing:border-box;background:rgba(128,128,128,.08);color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:9px;font:inherit}
    .ensemble-tts select option{background:Canvas;color:CanvasText}.ensemble-tts textarea{resize:vertical;min-height:90px}
    .ensemble-tts button{background:rgba(128,128,128,.14);color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit}
    .ensemble-tts button:disabled{opacity:.45;cursor:wait}.ensemble-tts .et-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
    .ensemble-tts .et-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
    .ensemble-tts .et-check{display:flex;gap:8px;align-items:center}.ensemble-tts .et-check input{width:auto}
    .ensemble-tts .et-card{padding:12px;border:1px solid rgba(128,128,128,.3);border-radius:10px;margin:10px 0}
    .ensemble-tts .et-status{white-space:pre-wrap;padding:12px;border-radius:8px;background:rgba(128,128,128,.08)}
    .ensemble-tts [hidden]{display:none!important}.ensemble-tts .et-error{color:#ef7878}
    .ensemble-tts .et-transcript{font:inherit;white-space:pre-wrap;max-height:180px;overflow:auto}
    .ensemble-tts details{margin:10px 0}.ensemble-tts .et-message{display:flex;gap:10px;align-items:center;justify-content:space-between}
  `);
  const root = tab.root;
  root.innerHTML = `<div class="ensemble-tts">
    <h2>Lumivoice</h2><p>Your cast, one story. Fixed voices for your leads; LLM casting for everyone else.</p>
    <div class="et-status" role="status" aria-live="polite" data-et="status">Open a chat to begin.</div>
    <h3>Speech provider</h3><div class="et-grid">
      <label>Playback adapter<select data-et="mode"><option value="gemini">Gemini 3.8 · style metadata</option><option value="native">Lumiverse TTS connection</option></select></label>
      <label>Planner LLM connection<select data-et="planner"><option value="">Default LLM connection</option></select></label>
    </div>
    <div data-et="gemini" class="et-grid" style="margin-top:12px">
      <label>Gemini TTS model<select data-et="model"><option>gemini-3.8-flash-tts</option><option>gemini-3.8-flash-lite-tts</option></select></label>
      <label>Gemini API key · this session only<input data-et="key" type="password" autocomplete="off" placeholder="Never saved to settings"></label>
    </div>
    <div data-et="native" hidden class="et-grid" style="margin-top:12px">
      <label>Lumiverse TTS connection<select data-et="connection"></select></label>
      <label>Style handling<select data-et="styleParam"><option value="">Ignore style (voice only)</option><option value="instructions">instructions (OpenAI mini TTS)</option><option value="instruct">instruct (if supported)</option><option value="prompt">prompt (if supported)</option></select></label>
    </div>
    <details><summary>Advanced provider options</summary><div class="et-grid">
      <label>Lumiverse API base<input data-et="apiBase" value="/api/v1"></label>
      <label>Max characters per speech request<input data-et="chunk" type="number" min="80" max="2000" value="350"></label>
    </div><label style="margin-top:10px">Additional Gemini voices · one ID | description per line<textarea data-et="extraVoices" placeholder="voice_... | warm storyteller"></textarea></label>
    <p>Other providers reuse your existing Lumiverse connections and credentials. Style support depends on their API. Gemini uses structured style metadata and a separate session key.</p></details>
    <div class="et-row"><button data-et="load">Reload connections and voices</button></div>
    <h3>Fixed cast for this chat</h3><p>Name your persona and characters exactly as they appear in the story. Narrator is reserved. You can add multiple main characters.</p>
    <div data-et="fixed"></div><button data-et="add">Add main character</button>
    <h3>NPC cast</h3><p>The planner selects new NPC voices and reuses their assignments throughout this chat. You can correct assignments below.</p>
    <div data-et="npcs"></div><button data-et="reset">Reset NPC cast for this provider</button>
    <div class="et-row"><label class="et-check"><input data-et="useStyle" type="checkbox" checked>Use delivery styles</label>
      <label class="et-check"><input data-et="auto" type="checkbox">Auto-play completed replies</label></div>
    <div class="et-row"><button data-et="save">Save cast and settings</button><button data-et="latest">Plan latest reply</button>
      <button data-et="stop">Stop</button><button data-et="pause" disabled>Pause</button></div>
    <h3>Speech plan</h3><div data-et="preview"><p>Plan a reply to review its speakers and styles before playback.</p></div>
    <button data-et="play" disabled>Play plan</button>
    <details><summary>Edit plan JSON</summary><p>Keep each segment’s text as an exact consecutive substring. Fixed and existing NPC voices take priority.</p>
      <textarea data-et="planJson" rows="8" spellcheck="false"></textarea><button data-et="apply">Apply edited plan</button></details>
    <h3>Recent messages</h3><div data-et="messages"></div>
    <p>Disable Lumiverse’s native TTS auto-play to avoid overlapping audio. Speech planning makes a separate LLM request; playback makes one TTS request per chunk.</p>
  </div>`;
  const $ = name => root.querySelector(`[data-et="${name}"]`);
  const pending = new Map();
  const unsubs = [];
  let disposed=false, loadVersion=0, revision=0, config, chatId=null, plan=null, planSource=null, busy=false;
  let voices=[...GEMINI_VOICES], nativeConnections=[], nativeProviders=[], castRows=[], npcRows=[];
  let controller=null, currentAudio=null, finishAudio=null, objectUrl=null;
  const defaults = () => ({mode:'gemini',model:'gemini-3.8-flash-tts',planner:'',connection:'',styleParam:'',apiBase:'/api/v1',chunk:350,
    extraVoices:'',useStyle:true,auto:false,casts:{},fixed:[
      {speaker:'Narrator',voice:'Charon',style:'Clear, measured narration'},
      {speaker:'Persona',voice:'Kore',style:''},
      {speaker:'Character',voice:'Puck',style:''} ]});
  function status(text,error=false) { if(disposed)return; $('status').textContent=text; $('status').classList.toggle('et-error',error); }
  const abortError = () => new DOMException('Stopped','AbortError');
  const scope = c => c.mode === 'gemini' ? 'gemini' : `native:${c.connection}`;
  const settingsKey = id => `chat:${id}`;

  function rpc(action,input,signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve,reject) => {
      const id=crypto.randomUUID();
      const cancel=()=>{ctx.sendToBackend({namespace:'lumivoice',id,action:'cancel'});done(abortError());};
      const timer=setTimeout(()=>{cancel();},185000);
      const done=(error,result)=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);pending.delete(id);error?reject(error):resolve(result);};
      pending.set(id,done); signal?.addEventListener('abort',cancel,{once:true});
      try {ctx.sendToBackend({namespace:'lumivoice',id,action,input});} catch(error){done(error);}
    });
  }
  unsubs.push(ctx.onBackendMessage(message=>{
    if(message?.namespace !== 'lumivoice')return;
    pending.get(message.id)?.(message.error?new Error(message.error):null,message.result);
  }));

  async function api(path,options={}) {
    const base=$('apiBase').value.trim().replace(/\/$/,'');
    if (!base || (!base.startsWith('/') && !/^https?:\/\//i.test(base))) throw new Error('Enter a valid Lumiverse API base.');
    const response=await fetch(`${base}${path}`,{credentials:'include',...options});
    if(!response.ok) {
      const body=await response.json().catch(()=>({}));
      throw new Error(body.error || `Lumiverse API HTTP ${response.status}`);
    }
    return response;
  }
  function option(select,value,label) {const node=document.createElement('option');node.value=value;node.textContent=label;select.append(node);}
  function makeRow(actor,container,reserved=false) {
    const row=document.createElement('div');row.className='et-card et-grid';
    const name=document.createElement('input');name.value=actor.speaker;name.disabled=reserved;
    const voice=document.createElement('select');
    for(const item of voices) option(voice,item.id,`${item.name || item.id}${item.description ? ` · ${item.description}`:''}`);
    if(!voices.some(v=>v.id===actor.voice))option(voice,actor.voice,`${actor.voice || 'Choose a voice'} · unavailable`);
    voice.value=actor.voice;
    const style=document.createElement('input');style.value=actor.style || '';style.maxLength=600;
    for (const [label,node] of [['Speaker name',name],['Voice',voice],['Base delivery style',style]]) {
      const wrap=document.createElement('label');wrap.textContent=label;wrap.append(node);row.append(wrap);
    }
    if(!reserved){const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=()=>{row.remove();};row.append(remove);}
    container.append(row);
    return {row,read:()=>({speaker:name.value.trim(),voice:voice.value,style:style.value.trim()})};
  }
  function renderCast() {
    $('fixed').replaceChildren();$('npcs').replaceChildren();
    castRows=config.fixed.map(actor=>makeRow(actor,$('fixed'),normalizeName(actor.speaker)==='narrator'));
    const npcs=config.casts[scope(config)] || [];
    npcRows=npcs.map(actor=>makeRow(actor,$('npcs')));
    if(!npcs.length){const p=document.createElement('p');p.textContent='No NPCs cast yet.';$('npcs').append(p);}
  }
  function capture() {
    return {...config,fixed:castRows.filter(v=>v.row.parentElement===$('fixed')).map(v=>v.read()),
      casts:{...config.casts,[scope(config)]:npcRows.filter(v=>v.row.parentElement===$('npcs')).map(v=>v.read())},
      mode:$('mode').value,model:$('model').value,planner:$('planner').value,connection:$('connection').value,
      styleParam:$('styleParam').value,apiBase:$('apiBase').value.trim(),chunk:Number($('chunk').value),
      extraVoices:$('extraVoices').value,useStyle:$('useStyle').checked,auto:$('auto').checked};
  }
  function casting(c=config) {return {fixed:c.fixed,npcs:c.casts[scope(c)] || [],voices,useStyle:c.useStyle};}
  function validateSettings(c) {
    validateCastConfig(casting(c));
    if(!Number.isInteger(c.chunk) || c.chunk<80 || c.chunk>2000)throw new Error('Chunk size must be 80–2000.');
    if(c.mode==='native' && !nativeConnections.some(v=>v.id===c.connection))throw new Error('Select an existing Lumiverse TTS connection.');
  }
  function setFields() {
    for(const name of ['mode','model','planner','connection','styleParam','apiBase','chunk','extraVoices'])$(name).value=config[name];
    $('useStyle').checked=config.useStyle;$('auto').checked=config.auto;
    $('gemini').hidden=config.mode!=='gemini';$('native').hidden=config.mode!=='native';
  }
  function setBusy(value) {
    busy=value;
    for (const name of ['save','latest','load','add','reset','mode','connection','apply','auto'])$(name).disabled=value;
    for (const name of ['model','planner','styleParam','apiBase','chunk','extraVoices','useStyle','key','planJson'])$(name).disabled=value;
    $('play').disabled=value || !plan;
    for(const node of [...$('fixed').querySelectorAll('input,select,button'),...$('npcs').querySelectorAll('input,select,button')])node.disabled=value;
    const narrator=castRows[0]?.row.querySelector('input');if(narrator && config.fixed[0]?.speaker==='Narrator')narrator.disabled=true;
  }
  function clearPlan() {plan=null;planSource=null;$('preview').replaceChildren();$('planJson').value='';$('play').disabled=true;}
  function stop(show=true) {
    revision++;controller?.abort();controller=null;
    currentAudio?.pause();finishAudio?.();currentAudio=null;finishAudio=null;
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
    $('pause').disabled=true;$('pause').textContent='Pause';
    setBusy(false);if(show)status('Stopped.');
  }
  async function save() {
    if(!chatId)throw new Error('Open a chat first.');
    const updated=capture();validateSettings(updated);config=updated;
    await ctx.settings.set(settingsKey(chatId),config);
    clearPlan();status('Cast and settings saved for this chat.');
  }
  async function loadProviders() {
    const version=loadVersion;
    const results=await Promise.allSettled([
      api('/tts-connections?limit=200').then(r=>r.json()),api('/tts-connections/providers').then(r=>r.json())
    ]);
    if(disposed || version!==loadVersion)return;
    nativeConnections=results[0].status==='fulfilled' ? results[0].value.data || [] : [];
    nativeProviders=results[1].status==='fulfilled' ? results[1].value.providers || [] : [];
    $('connection').replaceChildren();option($('connection'),'','Choose connection');
    nativeConnections.forEach(c=>option($('connection'),c.id,`${c.name} · ${c.provider}`));
    $('connection').value=config.connection;
    $('planner').replaceChildren();option($('planner'),'','Default LLM connection');
    for(const c of ctx.connections?.list?.() || [])option($('planner'),c.id,`${c.name} · ${c.model || ''}`);
    $('planner').value=config.planner;
    await loadVoices(version);
    if(config.mode==='native' && results[0].status==='rejected')throw results[0].reason;
  }
  async function loadVoices(version=loadVersion) {
    if(config.mode==='gemini') {
      const extra=String(config.extraVoices || '').split('\n').filter(s=>s.trim()).map(line=>{
        const [id,...description]=line.split('|');return {id:id.trim(),name:id.trim(),description:description.join('|').trim()};
      });
      voices=[...new Map([...GEMINI_VOICES,...extra].map(v=>[v.id,v])).values()];
    } else if(config.connection) {
      const response=await api(`/tts-connections/${encodeURIComponent(config.connection)}/voices`);
      const data=await response.json();if(disposed || version!==loadVersion)return;
      voices=data.voices || [];
      if(!voices.length)throw new Error('This connection returned no voices. Configure its voice catalogue in Lumiverse.');
    } else {voices=[];}
    if(version!==loadVersion || disposed)return;
    const connection=nativeConnections.find(v=>v.id===config.connection);
    const parameters=nativeProviders.find(v=>v.id===connection?.provider)?.capabilities?.parameters || {};
    for(const node of $('styleParam').options)node.disabled=Boolean(node.value && !parameters[node.value]);
    if(config.styleParam && !parameters[config.styleParam]){config.styleParam='';$('styleParam').value='';}
    renderCast();
  }
  async function switchChat() {
    const id=ctx.getActiveChat().chatId;
    if(id===chatId && config)return;
    stop(false);clearPlan();chatId=id;
    const version=++loadVersion;
    castRows=[];npcRows=[];$('fixed').replaceChildren();$('npcs').replaceChildren();
    let saved=id?await ctx.settings.get(settingsKey(id)):null;
    if(disposed || version!==loadVersion)return;
    config={...defaults(),...(saved || {})};
    if(!saved) {
      const personaId=ctx.state.get?.('persona.activeId');
      if(personaId) {
        const persona=await api(`/personas/${encodeURIComponent(personaId)}`).then(r=>r.json()).catch(()=>null);
        if(disposed || version!==loadVersion)return;
        config.fixed[1].speaker=persona?.name || 'Persona';
      }
      const characterId=ctx.getActiveChat().characterId;
      if(characterId) {
        const character=await ctx.characters.get(characterId).catch(()=>null);
        if(disposed || version!==loadVersion)return;
        config.fixed[2].speaker=character?.name || 'Character';
      }
    }
    setFields();await loadProviders();
    if(version!==loadVersion || disposed)return;
    renderMessages();status(id?'Ready. Set your persona name, choose voices, then save.':'Open a chat to begin.');
  }
  function renderPreview() {
    $('preview').replaceChildren();
    for(const [index,segment] of plan.segments.entries()) {
      const card=document.createElement('div');card.className='et-card';
      const label=document.createElement('strong');label.textContent=`${index+1}. ${segment.speaker} · ${segment.voice}`;
      const delivery=document.createElement('p');delivery.textContent=segment.style || 'Default delivery';
      const text=document.createElement('div');text.className='et-transcript';text.textContent=segment.text;
      card.append(label,delivery,text);$('preview').append(card);
    }
    // Editing uses delivery-only styles, so re-validation does not double the base style.
    $('planJson').value=JSON.stringify({segments:plan.segments.map(s=>{
      const actor=[...config.fixed,...(config.casts[scope(config)] || [])].find(v=>normalizeName(v.speaker)===normalizeName(s.speaker));
      const prefix=actor?.style ? `${actor.style}. ` : '';
      return {...s,style:prefix && s.style.startsWith(prefix)?s.style.slice(prefix.length):s.style===actor?.style?'':s.style};
    })},null,2);
    $('play').disabled=busy;
  }
  async function prepare(messageId,autoPlay=false,contentOverride) {
    if(!chatId)throw new Error('Open a chat first.');
    stop(false);clearPlan();config=capture();validateSettings(config);
    const token=revision, targetChat=chatId;
    const content=contentOverride ?? ctx.messages.getContent(messageId);
    if(content==null)throw new Error('Message is no longer available.');
    const transcript=transcriptFromMessage(content);
    if(!transcript)throw new Error('This message contains no speakable text.');
    const snapshot=structuredClone(casting(config));
    const context=ctx.messages.getRecent(12).filter(v=>v.id!==messageId && !v.extra?.is_system)
      .map(v=>`${v.name || (v.is_user ? 'Persona':'Character')}: ${transcriptFromMessage(v.content).slice(0,3000)}`).join('\n').slice(-16000);
    const ctrl=new AbortController();controller=ctrl;setBusy(true);status('Planning speakers, NPC voices and delivery…');
    try {
      const result=await rpc('plan',{transcript,config:snapshot,context,connectionId:config.planner},ctrl.signal);
      if(token!==revision || targetChat!==chatId || disposed)return;
      // Validate independently in the frontend before any audio or cast persistence.
      const validated=validatePlan({segments:result.segments.map(s=>{
        const actor=[...snapshot.fixed,...snapshot.npcs].find(v=>normalizeName(v.speaker)===normalizeName(s.speaker));
        const prefix=actor?.style?`${actor.style}. `:'';
        return {...s,style:prefix && s.style.startsWith(prefix)?s.style.slice(prefix.length):s.style===actor?.style?'':s.style};
      })},transcript,snapshot);
      plan=validated;planSource={messageId,content,transcript,chatId:targetChat};
      config.casts[scope(config)]=validated.npcs;
      await ctx.settings.set(settingsKey(targetChat),config);
      if(token!==revision || disposed)return;
      renderCast();renderPreview();status(`Ready: ${plan.segments.length} turns, ${new Set(plan.segments.map(s=>s.speaker)).size} speakers.`);
    } finally {if(token===revision){controller=null;setBusy(false);}}
    if(autoPlay && token===revision)await play();
  }
  async function playBlob(blob,signal) {
    if(signal.aborted)throw abortError();
    const url=URL.createObjectURL(blob);objectUrl=url;currentAudio=new Audio(url);
    const audio=currentAudio;$('pause').disabled=false;
    try {
      await new Promise((resolve,reject)=>{
        let settled=false;
        const done=error=>{if(settled)return;settled=true;signal.removeEventListener('abort',cancel);audio.onended=null;audio.onerror=null;finishAudio=null;error?reject(error):resolve();};
        const cancel=()=>{audio.pause();done(abortError());};finishAudio=cancel;
        audio.onended=()=>done();audio.onerror=()=>done(new Error('Browser could not decode this provider’s audio. Use WAV or MP3.'));
        signal.addEventListener('abort',cancel,{once:true});
        audio.play().catch(error=>done(new Error(error.name==='NotAllowedError'?'Browser blocked audio. Click Play plan to enable playback.':error.message)));
      });
    } finally {
      audio.pause();if(currentAudio===audio)currentAudio=null;
      URL.revokeObjectURL(url);if(objectUrl===url)objectUrl=null;
      $('pause').disabled=true;$('pause').textContent='Pause';
    }
  }
  async function play() {
    if(!plan || !planSource)throw new Error('Plan a message first.');
    if(chatId!==planSource.chatId || ctx.messages.getContent(planSource.messageId)!==planSource.content) {
      clearPlan();throw new Error('Message or swipe changed. Generate a fresh plan.');
    }
    stop(false);const token=revision;const ctrl=new AbortController();controller=ctrl;
    const snapshot=structuredClone(config), segments=plan.segments.flatMap(s=>splitSegment(s,snapshot.chunk));
    const apiKey=$('key').value.trim();
    if(snapshot.mode==='gemini' && !apiKey){controller=null;throw new Error('Enter your Gemini API key. It is held only in this page session.');}
    setBusy(true);
    try {
      for(const [index,segment] of segments.entries()) {
        if(ctrl.signal.aborted)throw abortError();
        status(`Synthesizing ${index+1}/${segments.length}: ${segment.speaker} · ${segment.voice}`);
        let blob;
        if(snapshot.mode==='gemini') {
          const result=await rpc('gemini',{segment,model:snapshot.model,apiKey},ctrl.signal);
          const audio=audioBytes(result.base64,result.mimeType);blob=new Blob([audio.data],{type:audio.mimeType});
        } else {
          const connection=nativeConnections.find(c=>c.id===snapshot.connection);
          const parameters={};
          if(snapshot.useStyle && snapshot.styleParam && segment.style)parameters[snapshot.styleParam]=segment.style;
          const response=await api('/tts/synthesize',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({connectionId:snapshot.connection,model:connection.model,voice:segment.voice,text:segment.text,parameters}),signal:ctrl.signal});
          blob=await response.blob();
        }
        if(token!==revision || ctrl.signal.aborted)throw abortError();
        status(`Playing ${index+1}/${segments.length}: ${segment.speaker}`);
        await playBlob(blob,ctrl.signal);
      }
      if(token===revision)status('Playback finished.');
    } finally {if(token===revision){controller=null;setBusy(false);}}
  }
  function renderMessages() {
    $('messages').replaceChildren();
    const recent=ctx.messages.getRecent(20).filter(v=>!v.extra?.is_system);
    for(const message of recent) {
      const row=document.createElement('div');row.className='et-card et-message';
      const name=document.createElement('span');name.textContent=`${message.name || (message.is_user?'You':'Character')} · ${transcriptFromMessage(message.content).slice(0,70)}`;
      const button=document.createElement('button');button.textContent='Plan';button.onclick=()=>run(()=>prepare(message.id));row.append(name,button);$('messages').append(row);
    }
  }
  async function run(action) {
    try{await action();}catch(error){if(error.name!=='AbortError')status(error.message,true);}
  }
  $('save').onclick=()=>run(save);
  $('latest').onclick=()=>run(async()=>{
    const latest=ctx.messages.getRecent(200).filter(v=>!v.is_user && !v.extra?.is_system).at(-1);
    if(!latest)throw new Error('No assistant reply in the active chat.');await prepare(latest.id);
  });
  $('stop').onclick=()=>stop();$('play').onclick=()=>run(play);
  $('pause').onclick=()=>{if(!currentAudio)return;if(currentAudio.paused){currentAudio.play().catch(e=>status(e.message,true));$('pause').textContent='Pause';}else{currentAudio.pause();$('pause').textContent='Resume';}};
  $('add').onclick=()=>{castRows.push(makeRow({speaker:`Character ${castRows.length}`,voice:voices[0]?.id || '',style:''},$('fixed')));};
  $('reset').onclick=()=>{config=capture();config.casts[scope(config)]=[];renderCast();clearPlan();status('NPC cast cleared. Save to keep this change.');};
  $('load').onclick=()=>run(async()=>{config=capture();loadVersion++;await loadProviders();clearPlan();status('Connections and voices reloaded.');});
  for(const name of ['mode','connection'])$(name).onchange=()=>run(async()=>{
    stop(false);clearPlan();config=capture();loadVersion++;setFields();await loadVoices();
    const unavailable=config.fixed.some(v=>!voices.some(x=>x.id===v.voice));
    status(unavailable?'Choose valid voices for this provider, then save.':'Provider selected. Save your cast.');
  });
  $('apply').onclick=()=>run(async()=>{
    if(!planSource)throw new Error('Plan a message first.');
    const edited=validatePlan(parsePlanJson($('planJson').value),planSource.transcript,casting(config));
    plan=edited;config.casts[scope(config)]=edited.npcs;await ctx.settings.set(settingsKey(chatId),config);
    renderCast();renderPreview();status('Edited plan validated.');
  });
  unsubs.push(ctx.state.subscribe('chat.active',()=>run(switchChat)));
  unsubs.push(ctx.state.subscribe('chat.messageCount',()=>renderMessages()));
  unsubs.push(ctx.events.on('GENERATION_ENDED',payload=>{
    renderMessages();
    if(payload?.chatId!==chatId || payload.error || !payload.messageId || !config?.auto || busy)return;
    if(payload.generationType==='impersonate')return;
    run(()=>prepare(payload.messageId,true,payload.content));
  }));
  for(const event of ['MESSAGE_EDITED','MESSAGE_SWIPED','SWIPE_EDITED','MESSAGE_DELETED']) {
    unsubs.push(ctx.events.on(event,payload=>{
      const id=payload?.messageId || payload?.message?.id || payload?.id;
      if(planSource && (!id || id===planSource.messageId)){stop(false);clearPlan();status('Message changed. Generate a fresh plan.');}
      renderMessages();
    }));
  }
  const action=ctx.ui.registerInputBarAction({id:'ensemble',label:'Lumivoice',subtitle:'Cast and play voices',enabled:true});
  action.onClick(()=>tab.activate());
  unsubs.push(()=>action.destroy());
  const cleanup=()=>{
    if(disposed)return;stop(false);$('key').value='';disposed=true;loadVersion++;
    for(const done of [...pending.values()])done(abortError());
    unsubs.splice(0).forEach(fn=>fn());removeStyle();tab.destroy();
  };
  await run(switchChat);
  return cleanup;
}
