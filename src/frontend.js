import { GEMINI_VOICES, normalizeName, normalizeVoiceCatalogue, transcriptFromMessage, planningSections, validateCastConfig, validatePlan, parsePlanJson, speechBatches, audioBytes } from './core.js';

export async function setup(ctx) {
  const tab = ctx.ui.registerDrawerTab({id:'ensemble',title:'Choir',shortName:'Voices',
    description:'Cast and play your story with multiple voices',keywords:['tts','audio','voices','narrator']});
  const root=document.createElement('div');
  tab.root.append(root);
  const settingsTab=ctx.ui.registerSettingsTab?.({id:'choir',title:'Choir',shortName:'Voices',
    description:'Configure Choir speech providers, narrator, persona and character voices',
    keywords:['tts','speech','voices','narrator','persona','characters'],position:'bottom'});
  const placementUnsubs=[];
  if(settingsTab) {
    placementUnsubs.push(settingsTab.onActivate(()=>settingsTab.root.replaceChildren(root)));
    if(tab.onActivate)placementUnsubs.push(tab.onActivate(()=>tab.root.replaceChildren(root)));
  }
  // Lumiverse's extension Settings button specifically requires this mount point.
  const settingsMount=ctx.ui.mount?.('settings_extensions');
  if(settingsMount) {
    const card=document.createElement('div');card.style.padding='12px';
    const title=document.createElement('h3');title.textContent='Choir';
    const text=document.createElement('p');text.textContent='Configure speech providers and the voices of your narrator, persona, main characters and NPCs.';
    const open=document.createElement('button');open.type='button';open.textContent='Open Choir settings';
    open.onclick=()=>{(settingsTab || tab).activate();};
    card.append(title,text,open);settingsMount.replaceChildren(card);
  }
  const cleanupPlacements=()=>{
    placementUnsubs.splice(0).forEach(fn=>fn());settingsMount?.replaceChildren();
    root.remove();settingsTab?.destroy();tab.destroy();
  };
  if (!ctx.settings || !ctx.messages?.getRecent || !ctx.messages?.getContent || !ctx.state) {
    const message=document.createElement('p');message.setAttribute('role','alert');
    message.textContent='Choir needs a newer Lumiverse staging build for its message and settings APIs. Update Lumiverse staging, then reload the page. Its settings entry is available, but playback cannot start on this build.';
    message.style.padding='18px';root.append(message);
    return cleanupPlacements;
  }
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
  root.innerHTML = `<div class="ensemble-tts">
    <h2>Choir</h2><p>Your cast, one story. Fixed voices for your leads; LLM casting for everyone else.</p>
    <div class="et-status" role="status" aria-live="polite" data-et="status">Open a chat to begin.</div>
    <h3>Speech provider</h3><div class="et-grid">
      <label>Default TTS for this chat<select data-et="mode"><option value="gemini">Gemini 3.8 · style metadata</option><option value="native">Lumiverse TTS connection</option></select></label>
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
      <label>Max characters per speech request<input data-et="chunk" type="number" min="80" max="2000" value="1800"></label>
      <label><input data-et="batchGemini" type="checkbox" checked> Batch Gemini turns (up to two speakers)</label>
      <label>Concurrent TTS requests<select data-et="concurrency"><option value="1">1 — sequential</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
      <label>Planner output budget (tokens)<input data-et="plannerTokens" type="number" min="1024" max="32768" step="1024" value="8192"></label>
    </div><label style="margin-top:10px">Additional Gemini voices · one ID | description per line<textarea data-et="extraVoices" placeholder="voice_... | warm storyteller"></textarea></label>
    <p>Other providers reuse your existing Lumiverse connections and credentials. Style support depends on their API. Gemini uses structured style metadata and a separate session key.</p></details>
    <div class="et-row"><button data-et="load">Reload connections and voices</button><button data-et="testPlanner">Test planner</button></div>
    <h3>Fixed cast for this chat</h3><p>Name your persona and characters exactly as they appear in the story. Each speaker can use its own TTS connection and voice. Use chat default inherits the default above. Narrator is reserved.</p>
    <div data-et="fixed"></div><button data-et="add">Add main character</button>
    <h3>NPC cast</h3><p>The planner selects new NPC voices and reuses their assignments throughout this chat. Gender preferences guide automatic voice selection. To recast an assigned voice with a new preference, select Let LLM choose, save, then plan again. Manual voices take priority.</p>
    <div data-et="npcs"></div><button data-et="reset">Reset NPC cast for this provider</button>
    <div class="et-row"><label class="et-check"><input data-et="useStyle" type="checkbox" checked>Use delivery styles</label>
      <label class="et-check"><input data-et="auto" type="checkbox">Auto-play completed replies</label></div>
    <label>Keep audio for this chat<select data-et="retention"><option value="session">This session only</option><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="forever">Until I delete it</option></select></label>
    <p>Save to apply retention to existing recordings too, measured from when they were recorded. Expired audio is removed when Choir opens or accesses recordings. Session audio disappears when Choir restarts or the page reloads.</p>
    <div class="et-row"><button data-et="save">Save cast and settings</button><button data-et="latest">Plan latest reply</button>
      <button data-et="stop">Stop</button><button data-et="pause" disabled>Pause</button></div>
    <div class="et-status" data-et="statusActions">Open a chat to begin.</div>
    <h3>Speech plan</h3><div data-et="preview"><p>Plan a reply to review its speakers and styles before playback.</p></div>
    <button data-et="play" disabled>Play plan</button>
    <details><summary>Edit plan JSON</summary><p>Keep each segment’s text as an exact consecutive substring. Fixed and existing NPC voices take priority.</p>
      <textarea data-et="planJson" rows="8" spellcheck="false"></textarea><button data-et="apply">Apply edited plan</button></details>
    <h3>Recent messages</h3><p>Replay saved audio without another provider request. Recordings are stored on this device. Gender preferences guide automatic casting; manually selected voices take priority.</p><button data-et="deleteChatAudio">Delete all Choir audio for this chat</button><div data-et="messages"></div>
    <p>Speech requests are grouped where supported. Playback stays in order with concurrent generation. Around 1,800 characters targets roughly two minutes; delivery speed varies. Disable native TTS auto-play to avoid overlapping audio.</p>
  </div>`;
  const $ = name => root.querySelector(`[data-et="${name}"]`);
  for(const button of root.querySelectorAll('button'))button.type='button';
  const pending = new Map();
  let audioNamespace,audioNamespaceError;
  try {
    audioNamespace=await ctx.settings.get('audio:namespace');
    if(!audioNamespace){audioNamespace=crypto.randomUUID();await ctx.settings.set('audio:namespace',audioNamespace);}
  } catch(error){audioNamespaceError=error;}
  let audioDatabase;
  const sessionAudio=new Map();
  async function recordingStore(operation,key,value) {
    if(operation==='policy' && value.retention!=='session') {
      for(const [sessionKey,record] of [...sessionAudio]) {
        if(JSON.parse(sessionKey)[1]===JSON.parse(key)[1])await recordingStore('put',sessionKey,{...record,retention:value.retention});
      }
    }
    if(operation==='delete')sessionAudio.delete(key);
    if(operation==='deleteChat')for(const sessionKey of [...sessionAudio.keys()]) {
      if(JSON.parse(sessionKey)[1]===JSON.parse(key)[1])sessionAudio.delete(sessionKey);
    }
    if(operation==='get' && sessionAudio.has(key))return sessionAudio.get(key);
    if(operation==='put') {
      const createdAt=value.createdAt ?? Date.now(),retention=value.retention || 'forever';
      value={...value,createdAt,expiresAt:retention==='forever' || retention==='session'?null:createdAt+Number(retention)*86400000};
      if(retention==='session'){sessionAudio.set(key,value);return;}
      sessionAudio.delete(key);
    }
    if(audioNamespaceError)throw new Error(`Audio storage settings could not be loaded: ${audioNamespaceError.message}`);
    if(!globalThis.indexedDB)throw new Error('Device audio storage is unavailable in this browser.');
    if(!audioDatabase)audioDatabase=new Promise((resolve,reject)=>{
      const request=indexedDB.open('choir-recordings',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('recordings');
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Close other Lumiverse tabs to enable recording storage.'));
    });
    const db=await audioDatabase;
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('recordings','readwrite');
      const store=transaction.objectStore('recordings');
      let result;
      const cursorRequest=store.openCursor();
      cursorRequest.onsuccess=()=>{
        const cursor=cursorRequest.result;
        if(cursor) {
          let identity;try{identity=JSON.parse(cursor.key);}catch{}
          if(identity?.[0]===audioNamespace) {
            const record=cursor.value;
            if(operation==='deleteChat' && identity[1]===JSON.parse(key)[1])cursor.delete();
            else if(operation==='policy' && identity[1]===JSON.parse(key)[1]) {
              record.createdAt ??= Date.now();
              record.expiresAt=value.retention==='forever'?null:record.createdAt+Number(value.retention)*86400000;
              if(value.retention==='session' || (record.expiresAt!==null && record.expiresAt<=Date.now()))cursor.delete();
              else cursor.update(record);
            } else if(record.expiresAt!=null && record.expiresAt<=Date.now())cursor.delete();
          }
          cursor.continue();return;
        }
        if(operation==='policy' || operation==='prune' || operation==='deleteChat')return;
        const request=operation==='put'?store.put(value,key):operation==='delete'?store.delete(key):store.get(key);
        request.onsuccess=()=>{result=request.result;};
      };
      transaction.oncomplete=()=>resolve(result);
      transaction.onerror=()=>reject(transaction.error);
      transaction.onabort=()=>reject(transaction.error || new Error('Recording storage failed.'));
    });
  }
  const recordingKey=(chat,message)=>JSON.stringify([audioNamespace,chat,message]);
  const unsubs = [];
  const messageStatuses=new Map();let messagePlaybackId=null;
  let disposed=false, loadVersion=0, revision=0, config, chatId=null, plan=null, planSource=null, busy=false;
  let voices=[...GEMINI_VOICES], nativeConnections=[], nativeProviders=[], castRows=[], npcRows=[];
  const voiceCatalogues=new Map();
  let controller=null, currentAudio=null, finishAudio=null, objectUrl=null;
  const defaults = () => ({mode:'gemini',model:'gemini-3.8-flash-tts',planner:'',connection:'',styleParam:'',apiBase:'/api/v1',chunk:1800,batchGemini:true,concurrency:1,plannerTokens:8192,
    extraVoices:'',useStyle:true,auto:false,retention:'forever',casts:{},fixed:[
      {speaker:'Narrator',voice:'Charon',style:'Clear, measured narration'},
      {speaker:'Persona',voice:'',style:''},
      {speaker:'Character',voice:'',style:''} ]});
  function status(text,error=false) {
    if(disposed)return;
    for(const name of ['status','statusActions']) {$(name).textContent=text;$(name).classList.toggle('et-error',error);}
    for(const node of messageStatuses.get(messagePlaybackId) || [])node.textContent=text;
  }
  const abortError = () => new DOMException('Stopped','AbortError');
  const scope = c => c.mode === 'gemini' ? 'gemini' : `native:${c.connection}`;
  async function ensureCatalogue(route) {
    if(voiceCatalogues.has(route))return voiceCatalogues.get(route);
    if(route==='gemini')return GEMINI_VOICES;
    const connectionId=route.startsWith('native:')?route.slice(7):'';
    if(!nativeConnections.some(c=>c.id===connectionId))throw new Error('Select an available TTS connection for this speaker.');
    const data=await api(`/tts-connections/${encodeURIComponent(connectionId)}/voices`).then(response=>response.json());
    if(data.error && !data.voices?.length)throw new Error(data.error);
    const catalogue=normalizeVoiceCatalogue(data.voices || []);
    if(!catalogue.length)throw new Error('This TTS connection returned no voices. Configure its voice catalogue in Lumiverse.');
    voiceCatalogues.set(route,catalogue);return catalogue;
  }
  const settingsKey = id => `chat:${id}`;

  function rpc(action,input,signal,timeoutMs=185000,onProgress) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve,reject) => {
      const id=crypto.randomUUID();
      let lastProgress;
      const cancel=()=>{try{ctx.sendToBackend({namespace:'choir',id,action:'cancel'});}catch{}done(abortError());};
      const timer=setTimeout(()=>{
        try{ctx.sendToBackend({namespace:'choir',id,action:'cancel'});}catch{}
        done(new Error(action==='ping'
          ? 'Choir backend did not respond. Update and restart Choir in Extensions, then reload the page. Both backend and frontend must be running.'
          : `${action==='plan' || action==='testPlanner'?'Planner':'TTS'} request timed out waiting for the backend. ${lastProgress?`Last reported stage: ${lastProgress.stage}. ${lastProgress.provider || ''} ${lastProgress.model || ''}.`:'The backend did not acknowledge this request; restart Choir and reload the page.'}`));
      },timeoutMs);
      const done=(error,result)=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);pending.delete(id);error?reject(error):resolve(result);};
      done.progress=progress=>{lastProgress=progress;onProgress?.(progress);};
      pending.set(id,done); signal?.addEventListener('abort',cancel,{once:true});
      try {ctx.sendToBackend({namespace:'choir',id,action,input});} catch(error){done(error);}
    });
  }
  unsubs.push(ctx.onBackendMessage(message=>{
    if(message?.namespace !== 'choir')return;
    if(message.progress){pending.get(message.id)?.progress(message.progress);return;}
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
    const route=document.createElement('select');route.dataset.choirRoute='';
    option(route,'','Use chat default');option(route,'gemini','Gemini style metadata');
    for(const connection of nativeConnections)option(route,`native:${connection.id}`,`${connection.name} · ${connection.provider}`);
    if(actor.route && ![...route.options].some(option=>option.value===actor.route))option(route,actor.route,`${actor.route} · unavailable`);
    route.value=actor.route || '';
    let rowVoices=voiceCatalogues.get(route.value || scope(config)) || [];
    voice.dataset.choirVoice='';
    option(voice,'','Let LLM choose');
    for(const item of rowVoices) option(voice,item.id,`${item.name || item.id} · ${item.gender==='female'?'Female':item.gender==='male'?'Male':item.gender==='neutral'?'Neutral':'Gender unknown'}${item.description ? ` · ${item.description}`:''}`);
    if(actor.voice && !rowVoices.some(v=>v.id===actor.voice))option(voice,actor.voice,`${actor.voice} · unavailable`);
    voice.value=actor.voice;
    const gender=document.createElement('select');
    gender.dataset.choirGender='';
    for(const [value,label] of [['auto','All voices / let LLM infer'],['female','Female voices'],['male','Male voices'],['neutral','Neutral voices']])option(gender,value,label);
    gender.value=actor.gender || 'auto';
    const filterVoices=()=>{
      const selected=voice.value;voice.replaceChildren();option(voice,'','Let LLM choose');
      for(const item of rowVoices) {
        if(gender.value!=='auto' && item.gender!==gender.value && item.id!==selected)continue;
        const mismatch=gender.value!=='auto' && item.gender!==gender.value;
        option(voice,item.id,`${item.name || item.id} · ${item.gender==='female'?'Female':item.gender==='male'?'Male':item.gender==='neutral'?'Neutral':'Gender unknown'}${item.description ? ` · ${item.description}`:''}${mismatch?' · selected voice differs from filter':''}`);
      }
      if(selected && !rowVoices.some(v=>v.id===selected))option(voice,selected,`${selected} · unavailable`);
      voice.value=selected;
    };
    gender.onchange=filterVoices;filterVoices();
    route.onchange=()=>run(async()=>{
      const selected=route.value;voice.value='';voice.disabled=true;
      try {
        const catalogue=await ensureCatalogue(selected || scope(config));
        if(route.value!==selected || disposed)return;
        rowVoices=catalogue;filterVoices();clearPlan();status('Speaker TTS connection selected. Choose a voice or Let LLM choose, then save.');
        $('gemini').hidden=config.mode!=='gemini' && ![...castRows,...npcRows].some(row=>row.read().route==='gemini');
      } finally {if(!disposed && route.value===selected)voice.disabled=busy;}
    });
    const style=document.createElement('input');style.value=actor.style || '';style.maxLength=600;
    for (const [label,node] of [['Speaker name',name],['TTS connection',route],['Voice gender filter',gender],['Voice',voice],['Base delivery style',style]]) {
      const wrap=document.createElement('label');wrap.textContent=label;wrap.append(node);row.append(wrap);
    }
    if(!reserved){const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.onclick=()=>{row.remove();};row.append(remove);}
    container.append(row);
    return {row,read:()=>({speaker:name.value.trim(),voice:voice.value,route:route.value,gender:gender.value,style:style.value.trim()})};
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
      plannerTokens:Number($('plannerTokens').value),retention:$('retention').value,batchGemini:$('batchGemini').checked,concurrency:Number($('concurrency').value),
      extraVoices:$('extraVoices').value,useStyle:$('useStyle').checked,auto:$('auto').checked};
  }
  function casting(c=config) {
    const actors=[...c.fixed,...(c.casts[scope(c)] || [])];
    const routes=new Set([scope(c),...actors.map(actor=>actor.route || scope(c))]);
    return {fixed:c.fixed,npcs:c.casts[scope(c)] || [],defaultRoute:scope(c),
      voices:[...routes].flatMap(route=>(voiceCatalogues.get(route) || []).map(voice=>({...voice,route}))),useStyle:c.useStyle};
  }
  function validateSettings(c) {
    if(!['session','1','7','30','forever'].includes(c.retention))throw new Error('Choose a valid audio retention period.');
    validateCastConfig(casting(c));
    if(!Number.isInteger(c.chunk) || c.chunk<80 || c.chunk>2000)throw new Error('Chunk size must be 80–2000.');
    if(!Number.isInteger(c.concurrency) || c.concurrency<1 || c.concurrency>4)throw new Error('Choose 1–4 concurrent TTS requests.');
    if(!Number.isInteger(c.plannerTokens) || c.plannerTokens<1024 || c.plannerTokens>32768)throw new Error('Planner output budget must be 1024–32768 tokens.');
    if(c.mode==='native' && !nativeConnections.some(v=>v.id===c.connection))throw new Error('Select an existing Lumiverse TTS connection.');
  }
  function setFields() {
    for(const name of ['mode','model','planner','connection','styleParam','apiBase','chunk','plannerTokens','extraVoices','retention'])$(name).value=config[name];
    $('useStyle').checked=config.useStyle;$('auto').checked=config.auto;$('batchGemini').checked=config.batchGemini;$('concurrency').value=config.concurrency;
    $('gemini').hidden=config.mode!=='gemini' && ![...config.fixed,...(config.casts[scope(config)] || [])].some(actor=>actor.route==='gemini');$('native').hidden=config.mode!=='native';
  }
  function setBusy(value) {
    busy=value;
    for (const name of ['save','latest','load','testPlanner','add','reset','mode','connection','apply','auto'])$(name).disabled=value;
    for (const name of ['model','planner','styleParam','apiBase','chunk','plannerTokens','extraVoices','useStyle','key','planJson','retention'])$(name).disabled=value;
    $('play').disabled=value || !plan;
    $('batchGemini').disabled=value;$('concurrency').disabled=value;
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
    let retentionError;
    try{await recordingStore('policy',recordingKey(chatId,''),{retention:config.retention});}catch(error){retentionError=error.message;}
    clearPlan();status(retentionError?`Settings saved. Audio retention could not be applied: ${retentionError}`:'Cast and audio retention saved. Click Plan latest reply, then Play plan. Auto-play applies to future completed replies.');
  }
  async function loadProviders() {
    const version=loadVersion;
    const results=await Promise.allSettled([
      api('/tts-connections?limit=200').then(r=>r.json()),api('/tts-connections/providers').then(r=>r.json()),api('/connections?limit=200').then(r=>r.json())
    ]);
    if(disposed || version!==loadVersion)return;
    nativeConnections=results[0].status==='fulfilled' ? results[0].value.data || [] : [];
    nativeProviders=results[1].status==='fulfilled' ? results[1].value.providers || [] : [];
    $('connection').replaceChildren();option($('connection'),'','Choose connection');
    nativeConnections.forEach(c=>option($('connection'),c.id,`${c.name} · ${c.provider}`));
    $('connection').value=config.connection;
    $('planner').replaceChildren();option($('planner'),'','Default LLM connection');
    const plannerConnections=results[2].status==='fulfilled'?results[2].value.data || []:[];
    for(const c of plannerConnections)option($('planner'),c.id,`${c.name} · ${c.provider || ''} · ${c.model || 'No model configured'}`);
    if(config.planner && !plannerConnections.some(c=>c.id===config.planner))option($('planner'),config.planner,'Saved planner connection · unavailable');
    $('planner').value=config.planner;
    await loadVoices(version);
    if(config.mode==='native' && results[0].status==='rejected')throw results[0].reason;
  }
  async function loadVoices(version=loadVersion) {
    voiceCatalogues.clear();
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
    voices=normalizeVoiceCatalogue(voices);
    voiceCatalogues.set(scope(config),voices);
    if(!voiceCatalogues.has('gemini'))voiceCatalogues.set('gemini',normalizeVoiceCatalogue(GEMINI_VOICES));
    const selectedRoutes=new Set([...config.fixed,...(config.casts[scope(config)] || [])].map(actor=>actor.route).filter(Boolean));
    const catalogues=await Promise.allSettled([...selectedRoutes].map(route=>ensureCatalogue(route)));
    for(const result of catalogues)if(result.status==='rejected')status(result.reason.message,true);
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
    await recordingStore('prune').catch(()=>{});
    if(disposed || version!==loadVersion)return;
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
      const label=document.createElement('strong');
      const connectionLabel=segment.route==='gemini'?'Gemini':nativeConnections.find(c=>`native:${c.id}`===segment.route)?.name;
      label.textContent=`${index+1}. ${segment.speaker} · ${segment.voice}${connectionLabel?` · ${connectionLabel}`:''}`;
      const delivery=document.createElement('p');delivery.textContent=segment.style || 'Default delivery';
      const text=document.createElement('div');text.className='et-transcript';text.textContent=segment.text;
      card.append(label,delivery,text);$('preview').append(card);
    }
    // Editing uses delivery-only styles, so re-validation does not double the base style.
    $('planJson').value=JSON.stringify({segments:plan.segments.map(s=>{
      const actor=[...config.fixed,...(config.casts[scope(config)] || [])].find(v=>normalizeName(v.speaker)===normalizeName(s.speaker));
      const prefix=actor?.style ? `${actor.style}. ` : '';
      const style=s.style || ''; return {...s,style:prefix && style.startsWith(prefix)?style.slice(prefix.length):style===actor?.style?'':style};
    })},null,2);
    $('play').disabled=busy;
  }
  const replacePersonaMacro=(text,name)=>text.replace(/\{\{\s*user\s*\}\}/gi,()=>name);
  async function personaName() {
    const personaId=ctx.state.get?.('persona.activeId');
    if(personaId) {
      const persona=await api(`/personas/${encodeURIComponent(personaId)}`).then(response=>response.json()).catch(()=>null);
      if(persona?.name?.trim())return persona.name.trim();
    }
    const name=config.fixed[1]?.speaker?.trim();
    if(name && name!=='Persona')return name;
    throw new Error('Set your persona name in Choir’s fixed cast to resolve {{user}}.');
  }
  async function recordingMatchesTranscript(recording,content) {
    let transcript=transcriptFromMessage(content);
    if(/\{\{\s*user\s*\}\}/i.test(transcript))transcript=replacePersonaMacro(transcript,await personaName());
    const saved=recording.transcript ?? recording.segments?.map(segment=>segment.text).join(' ');
    const canonical=text=>String(text || '').replace(/\s+/g,' ').trim();
    return canonical(saved)===canonical(transcript);
  }
  async function prepare(messageId,autoPlay=false,contentOverride) {
    if(!chatId)throw new Error('Open a chat first.');
    stop(false);clearPlan();config=capture();validateSettings(config);
    const token=revision, targetChat=chatId;
    const content=contentOverride ?? ctx.messages.getContent(messageId);
    if(content==null)throw new Error('Message is no longer available.');
    let transcript=transcriptFromMessage(content);
    if(!transcript)throw new Error('This message contains no speakable text.');
    const snapshot=structuredClone(casting(config));
    let context=ctx.messages.getRecent(12).filter(v=>v.id!==messageId && !v.extra?.is_system)
      .map(v=>`${v.name || (v.is_user ? 'Persona':'Character')}: ${transcriptFromMessage(v.content).slice(0,1000)}`).join('\n').slice(-4000);
    const ctrl=new AbortController();controller=ctrl;setBusy(true);status('Checking Choir backend…');
    let streaming=false;
    try {
      if(/\{\{\s*user\s*\}\}/i.test(transcript+context)) {
        const name=await personaName();
        if(ctrl.signal.aborted || token!==revision)return;
        transcript=replacePersonaMacro(transcript,name);context=replacePersonaMacro(context,name);
      }
      await rpc('ping',{},ctrl.signal,8000);
      if(token!==revision || ctrl.signal.aborted)return;
      const stripBase=segments=>segments.map(s=>{
        const actor=[...snapshot.fixed,...snapshot.npcs].find(v=>normalizeName(v.speaker)===normalizeName(s.speaker));
        const prefix=actor?.style?`${actor.style}. `:'';
        const style=s.style || ''; return {...s,style:prefix && style.startsWith(prefix)?style.slice(prefix.length):style===actor?.style?'':style};
      });
      const sections=planningSections(transcript),combined=[];let previous='';
      streaming=autoPlay && sections.length>1;
      let player=null;
      if(streaming) {
        const apiKey=$('key').value.trim();
        player=createStreamingPlayer(config,{chatId:targetChat,messageId,content,transcript},null,apiKey,ctrl,token);
      }
      for(let index=0;index<sections.length;index++) {
        const section=sections[index];
        status(`Planning section ${index+1}/${sections.length}: speakers and voices…`);
        let result;
        try {result=await rpc('plan',{transcript:section,config:snapshot,timeoutMs:90000,
          context:[context,previous?`Previous section of this same reply:\n${previous.slice(-2000)}`:''].filter(Boolean).join('\n').slice(-4000),
          connectionId:config.planner,maxTokens:config.plannerTokens},ctrl.signal,95000,
          progress=>status(`Planning section ${index+1}/${sections.length}: ${progress.stage}${progress.model?` · ${progress.model}`:''}`));
        } catch(error) {
          if(ctrl.signal.aborted || token!==revision)throw error;
          if(/timed out|timeout/i.test(error.message)) {
            const smaller=planningSections(section,Math.max(1,Math.floor(section.length/2)),1);
            if(smaller.length>1) {
              sections.splice(index,1,...smaller);index--;
              status(`Splitting the slow section into ${smaller.length} smaller parts…`);continue;
            }
            throw new Error(`A single speech turn timed out while identifying its speaker. Earlier sections completed, but no audio was generated. Try a faster Planner LLM connection. ${error.message}`);
          }
          throw error;
        }
        if(token!==revision || targetChat!==chatId || disposed)return;
        const checked=validatePlan({segments:stripBase(result.segments)},section,snapshot);
        snapshot.npcs=checked.npcs;
        for(const actor of snapshot.fixed)if(!actor.voice)actor.voice=checked.segments.find(s=>normalizeName(s.speaker)===normalizeName(actor.speaker))?.voice || '';
        combined.push(...stripBase(checked.segments));previous=section;
        if(streaming) {
          const sectionBatches=speechBatches(stripBase(checked.segments),snapshot.chunk,scope(snapshot),snapshot.batchGemini);
          player.push(sectionBatches);
        }
      }
      if(streaming)player.finish();
      // Validate the complete original reply before audio or cast persistence.
      const validated=validatePlan({segments:combined},transcript,snapshot);
      plan=validated;planSource={messageId,content,transcript,chatId:targetChat};
      config.casts[scope(config)]=validated.npcs;
      for(const actor of config.fixed) {
        if(!actor.voice)actor.voice=validated.segments.find(s=>normalizeName(s.speaker)===normalizeName(actor.speaker))?.voice || '';
      }
      await ctx.settings.set(settingsKey(targetChat),config);
      if(token!==revision || disposed)return;
      renderCast();renderPreview();
      if(!streaming)status(`Ready: ${plan.segments.length} turns, ${new Set(plan.segments.map(s=>s.speaker)).size} speakers.`);
      if(streaming) {
        const {blobs,segments:playedBatches}=await player.playbackPromise;
        const key=recordingKey(targetChat,messageId);
        const signature=JSON.stringify([snapshot.mode,snapshot.model,snapshot.connection,snapshot.styleParam,playedBatches,
          playedBatches.map(segment=>nativeConnections.find(c=>`native:${c.id}`===(segment.route || scope(snapshot)))?.model)]);
        let storageError='';
        try{await recordingStore('put',key,{content,transcript,signature,segments:playedBatches,blobs,retention:snapshot.retention});}
        catch(error){storageError=error.message;}
        if(token===revision){renderMessages();status(storageError?`Playback finished. Audio could not be saved: ${storageError}`:snapshot.retention==='session'?'Playback finished. Audio kept for this session; Replay is available beside the message.':'Playback finished. Audio saved on this device; Replay is available beside the message.');}
      }
    } finally {if(token===revision){controller=null;setBusy(false);}}
    if(autoPlay && !streaming && token===revision)await play();
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
  function createStreamingPlayer(snapshot,source,cached,apiKey,ctrl,token) {
    const segments=[];
    const ready=new Map();
    const resolvers=new Map();
    let nextToSynthesize=0;
    let activeWorkers=0;
    let isDoneAdding=false;
    let wakePlayback=null;
    const blobs=[];
    let totalExpected=0;

    ctrl.signal.addEventListener('abort',()=>wakePlayback?.(),{once:true});

    function ensureSlot(index) {
      if(!ready.has(index)) {
        let res;
        const p=new Promise(r=>res=r);
        ready.set(index,p);
        resolvers.set(index,res);
      }
    }

    function pump() {
      const concurrency=Math.max(1,Number(snapshot.concurrency)||1);
      while(!ctrl.signal.aborted && activeWorkers<concurrency && nextToSynthesize<segments.length) {
        const idx=nextToSynthesize++;
        ensureSlot(idx);
        activeWorkers++;
        (async()=>{
          try {
            const seg=segments[idx];
            if(ctrl.signal.aborted)throw abortError();
            status(`Synthesizing ${idx+1}/${totalExpected || segments.length}: ${seg.speaker} · ${seg.voice}`);
            let blob=cached?.blobs?.[idx];
            if(blob) {
              status(`Replaying ${idx+1}/${totalExpected || segments.length}: ${seg.speaker}`);
            } else if((seg.route || scope(snapshot))==='gemini') {
              if(!apiKey)throw new Error('Enter your Gemini API key for speakers using the Gemini adapter. It is held only in this page session.');
              const result=await rpc('gemini',{segment:seg,model:snapshot.model,apiKey},ctrl.signal);
              const audio=audioBytes(result.base64,result.mimeType);
              blob=new Blob([audio.data],{type:audio.mimeType});
            } else {
              const route=seg.route || scope(snapshot);
              const connection=nativeConnections.find(c=>`native:${c.id}`===route);
              if(!connection)throw new Error(`TTS connection for ${seg.speaker} is no longer available. Choose another connection and plan again.`);
              const parameters={};
              const supported=nativeProviders.find(provider=>provider.id===connection.provider)?.capabilities?.parameters || {};
              const styleParam=route===scope(snapshot)
                ? (snapshot.styleParam && supported[snapshot.styleParam]?snapshot.styleParam:undefined)
                : (snapshot.styleParam && supported[snapshot.styleParam]?snapshot.styleParam:['instructions','instruct','prompt'].find(p=>supported[p]));
              if(snapshot.useStyle && styleParam && seg.style)parameters[styleParam]=seg.style;
              const response=await api('/tts/synthesize',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({connectionId:connection.id,model:connection.model,voice:seg.voice,text:seg.text,parameters}),
                signal:ctrl.signal
              });
              blob=await response.blob();
            }
            if(token!==revision || ctrl.signal.aborted)throw abortError();
            resolvers.get(idx)({blob});
          } catch(error) {
            resolvers.get(idx)({error});
          } finally {
            activeWorkers--;
            pump();
          }
        })();
      }
    }

    function push(newSegments,total) {
      if(total)totalExpected=total;
      for(const s of newSegments)segments.push(s);
      pump();
      wakePlayback?.();
    }

    function finish() {
      isDoneAdding=true;
      wakePlayback?.();
    }

    const playbackPromise=(async()=>{
      let playIdx=0;
      while(!ctrl.signal.aborted) {
        if(playIdx>=segments.length) {
          if(isDoneAdding)break;
          await new Promise(resolve=>{wakePlayback=resolve;});
          wakePlayback=null;
          continue;
        }
        ensureSlot(playIdx);
        const outcome=await ready.get(playIdx);
        if(outcome.error)throw outcome.error;
        if(token!==revision || ctrl.signal.aborted)throw abortError();
        const blob=outcome.blob;
        blobs.push(blob);
        const seg=segments[playIdx];
        status(`Playing ${playIdx+1}/${totalExpected || segments.length}: ${seg.speaker}`);
        await playBlob(blob,ctrl.signal);
        playIdx++;
      }
      return {blobs,segments};
    })();

    return {push,finish,playbackPromise};
  }
  async function play() {
    if(!plan || !planSource)throw new Error('Plan a message first.');
    if(chatId!==planSource.chatId || ctx.messages.getContent(planSource.messageId)!==planSource.content) {
      clearPlan();throw new Error('Message or swipe changed. Generate a fresh plan.');
    }
    stop(false);const token=revision;const ctrl=new AbortController();controller=ctrl;
    const snapshot=structuredClone(capture()), segments=speechBatches(plan.segments,snapshot.chunk,scope(snapshot),snapshot.batchGemini);
    validateSettings(snapshot);
    const source={...planSource}, key=recordingKey(source.chatId,source.messageId);
    const signature=JSON.stringify([snapshot.mode,snapshot.model,snapshot.connection,snapshot.styleParam,segments,
      segments.map(segment=>nativeConnections.find(c=>`native:${c.id}`===(segment.route || scope(snapshot)))?.model)]);
    let cached,storageError='';
    status('Checking saved audio…');
    try{cached=await recordingStore('get',key);}catch(error){storageError=error.message;}
    if(token!==revision || ctrl.signal.aborted)throw abortError();
    if(cached?.content!==source.content || cached?.signature!==signature)cached=null;
    const apiKey=$('key').value.trim();
    if(!cached && segments.some(segment=>(segment.route || scope(snapshot))==='gemini') && !apiKey){controller=null;throw new Error('Enter your Gemini API key for speakers using the Gemini adapter. It is held only in this page session.');}
    setBusy(true);
    try {
      const player=createStreamingPlayer(snapshot,source,cached,apiKey,ctrl,token);
      player.push(segments,segments.length);
      player.finish();
      const {blobs}=await player.playbackPromise;
      if(!cached) {
        if(token!==revision || ctrl.signal.aborted)throw abortError();
        try{await recordingStore('put',key,{content:source.content,transcript:source.transcript,signature,segments,blobs,retention:snapshot.retention});storageError='';}
        catch(error){storageError=error.message;}
      }
      if(token===revision){renderMessages();status(storageError?`Playback finished. Audio could not be saved: ${storageError}`:snapshot.retention==='session'?'Playback finished. Audio kept for this session; Replay is available beside the message.':'Playback finished. Audio saved on this device; Replay is available beside the message.');}
    } finally {ctrl.abort();if(token===revision){controller=null;setBusy(false);}}
  }
  async function replayRecording(messageId) {
    stop(false);const token=revision,targetChat=chatId;
    const ctrl=new AbortController();controller=ctrl;setBusy(true);
    status('Loading saved audio…');
    try {
      const recording=await recordingStore('get',recordingKey(targetChat,messageId));
      if(token!==revision || ctrl.signal.aborted)throw abortError();
      if(!recording)throw new Error('No saved audio for this message on this device. Plan and play it first.');
      if(ctx.messages.getContent(messageId)!==recording.content)throw new Error('The message changed since recording. Plan and play the current reply.');
      if(!await recordingMatchesTranscript(recording,recording.content))throw new Error('This recording uses older speech text. Plan and play the message again to remove trackers or update the persona name.');
      for(const [index,blob] of recording.blobs.entries()) {
        if(token!==revision || ctrl.signal.aborted)throw abortError();
        status(`Replaying ${index+1}/${recording.blobs.length}: ${recording.segments[index].speaker}`);
        await playBlob(blob,ctrl.signal);
      }
      if(token===revision)status('Replay finished.');
    } finally {if(token===revision){controller=null;setBusy(false);}}
  }
  async function playMessage(messageId) {
    if(controller && messagePlaybackId===messageId){stop();return;}
    messagePlaybackId=messageId;
    status('Checking saved audio…');
    const content=ctx.messages.getContent(messageId);
    let recording;try{recording=await recordingStore('get',recordingKey(chatId,messageId));}catch{}
    if(recording?.content===content && await recordingMatchesTranscript(recording,content)){await replayRecording(messageId);return;}
    await prepare(messageId,true);
  }
  const decorateMessage=(target,context={})=>{
    const messageId=ctx.dom.getMessageId?.(context.node || target) || context.scope?.split(':')[1];
    if(!messageId)return;
    const controls=document.createElement('div');controls.style.cssText='display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px';
    const button=document.createElement('button');button.type='button';button.textContent='▶ Play Choir';button.title='Play or stop Choir audio';button.setAttribute('aria-label','Play or stop Choir audio for this message');
    button.style.cssText='cursor:pointer;border:1px solid currentColor;border-radius:6px;padding:4px 8px;background:transparent;color:inherit;font:inherit';
    const progress=document.createElement('span');progress.setAttribute('role','status');progress.style.fontSize='0.8em';
    let statuses=messageStatuses.get(messageId);if(!statuses){statuses=new Set();messageStatuses.set(messageId,statuses);}statuses.add(progress);
    button.onclick=()=>run(()=>playMessage(messageId));controls.append(button,progress);target.append(controls);
    return ()=>{controls.remove();statuses.delete(progress);if(!statuses.size)messageStatuses.delete(messageId);};
  };
  if(ctx.registerDomDecorator) {
    const handle=ctx.registerDomDecorator({mount:'message_footer',render:decorateMessage,target:'message_footer',decorate:decorateMessage});
    unsubs.push(typeof handle==='function'?handle:()=>handle?.destroy());
  } else if(ctx.registerMessageAction) {
    const handle=ctx.registerMessageAction({id:'choir-play',label:'Play Choir',onClick:id=>run(()=>playMessage(id))});
    unsubs.push(()=>handle.destroy());
  }
  function renderMessages() {
    $('messages').replaceChildren();
    const recent=ctx.messages.getRecent(20).filter(v=>!v.extra?.is_system);
    for(const message of recent) {
      const row=document.createElement('div');row.className='et-card et-message';
      const name=document.createElement('span');name.textContent=`${message.name || (message.is_user?'You':'Character')} · ${transcriptFromMessage(message.content).slice(0,70)}`;
      const button=document.createElement('button');button.textContent='Plan';button.onclick=()=>run(()=>prepare(message.id));row.append(name,button);$('messages').append(row);
      const replay=document.createElement('button');replay.textContent='Replay';replay.onclick=()=>run(()=>replayRecording(message.id));row.append(replay);
      const removeAudio=document.createElement('button');removeAudio.textContent='Delete audio';removeAudio.onclick=()=>run(async()=>{
        const targetChat=chatId,key=recordingKey(targetChat,message.id);
        stop(false);status('Deleting saved audio…');
        await recordingStore('delete',key);
        if(await recordingStore('get',key))throw new Error('Audio deletion did not complete. Stop playback and try again.');
        if(chatId===targetChat){replay.disabled=true;removeAudio.textContent='Audio deleted';status('Saved audio deleted for this message. Play plan will generate new audio.');}
      });row.append(removeAudio);
      for(const button of row.querySelectorAll('button'))button.type='button';
    }
  }
  $('deleteChatAudio').onclick=()=>run(async()=>{
    if(!chatId)throw new Error('Open a chat first.');
    const targetChat=chatId;stop(false);status('Deleting saved audio for this chat…');
    await recordingStore('deleteChat',recordingKey(targetChat,''));
    if(chatId===targetChat){renderMessages();status('All Choir audio deleted for this chat on this device.');}
  });
  async function run(action) {
    try{await action();}catch(error){if(error.name!=='AbortError')status(error.message,true);}
  }
  $('save').onclick=()=>run(save);
  $('testPlanner').onclick=()=>run(async()=>{
    stop(false);const token=revision,ctrl=new AbortController();controller=ctrl;setBusy(true);status('Testing planner…');
    try {
      await rpc('ping',{},ctrl.signal,8000);
      const result=await rpc('testPlanner',{connectionId:$('planner').value},ctrl.signal,65000,
        progress=>status(`Planner test: ${progress.stage}${progress.model?` · ${progress.model}`:''}`));
      if(token===revision)status(`Planner test passed: ${result.provider} · ${result.model}. Response: ${result.response}`);
    } finally {if(token===revision){controller=null;setBusy(false);}}
  });
  $('latest').onclick=()=>run(async()=>{
    const latest=ctx.messages.getRecent(200).filter(v=>!v.is_user && !v.extra?.is_system).at(-1);
    if(!latest)throw new Error('No assistant reply in the active chat.');await prepare(latest.id);
  });
  $('stop').onclick=()=>stop();$('play').onclick=()=>run(play);
  $('pause').onclick=()=>{if(!currentAudio)return;if(currentAudio.paused){currentAudio.play().catch(e=>status(e.message,true));$('pause').textContent='Pause';}else{currentAudio.pause();$('pause').textContent='Resume';}};
  $('add').onclick=()=>{castRows.push(makeRow({speaker:`Character ${castRows.length}`,voice:'',style:''},$('fixed')));};
  $('reset').onclick=()=>{config=capture();config.casts[scope(config)]=[];renderCast();clearPlan();status('NPC cast cleared. Save to keep this change.');};
  $('load').onclick=()=>run(async()=>{config=capture();loadVersion++;await loadProviders();clearPlan();status('Connections and voices reloaded.');});
  for(const name of ['mode','connection'])$(name).onchange=()=>run(async()=>{
    stop(false);clearPlan();config=capture();loadVersion++;setFields();await loadVoices();
    const unavailable=config.fixed.some(v=>v.voice && !voices.some(x=>x.id===v.voice));
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
  const action=ctx.ui.registerInputBarAction({id:'ensemble',label:'Choir',subtitle:'Cast and play voices',enabled:true});
  action.onClick(()=>tab.activate());
  unsubs.push(()=>action.destroy());
  const cleanup=()=>{
    if(disposed)return;stop(false);$('key').value='';disposed=true;loadVersion++;
    for(const done of [...pending.values()])done(abortError());
    unsubs.splice(0).forEach(fn=>fn());removeStyle();cleanupPlacements();
    audioDatabase?.then(db=>db.close()).catch(()=>{});
    sessionAudio.clear();
  };
  await run(switchChat);
  return cleanup;
}
