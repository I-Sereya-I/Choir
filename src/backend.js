import { MAX_SPEECH_CHARS, validateCastConfig, validatePlan, parsePlanJson, resolvePlanReferences, plannerPrompt, geminiRequest, extractGeminiAudio, speechSourceUnits, normalizeName, fastClassifyPlan, resolvePlannerMode, soundCuePrompt, parseSoundCues } from './core.js';

async function jevPost(url, headers, payload, signal) {
  signal?.throwIfAborted();
  if (typeof spindle !== 'undefined' && typeof spindle?.cors === 'function') {
    const res = await spindle.cors(url, {
      method: 'POST',
      headers,
      // Spindle forwards options through worker postMessage. AbortSignal is not
      // structured-cloneable there. Cancel locally and discard late results.
      body: JSON.stringify(payload)
    });
    signal?.throwIfAborted();
    if (!res) throw new Error('Jev request returned no response.');
    let data;
    try {
      data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    } catch {
      data = res.body;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = data?.error?.message || data?.message || (typeof res.body === 'string' ? res.body : '') || `HTTP ${res.status}`;
      throw new Error(`Jev classification HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return data;
  }
  if (typeof fetch === 'function') {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal
    });
    if (!res.ok) {
      let msg = '';
      try {
        const errObj = await res.json();
        msg = errObj?.error?.message || errObj?.message || '';
      } catch {
        msg = await res.text().catch(() => '');
      }
      throw new Error(`Jev classification HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return await res.json();
  }
  throw new Error('No HTTP transport available (spindle.cors or fetch).');
}

function extractChoices(data) {
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data?.choices)) arr = data.choices;
  else if (Array.isArray(data?.classifications)) arr = data.classifications;
  else if (Array.isArray(data?.results)) arr = data.results;
  else if (Array.isArray(data?.predictions)) arr = data.predictions;
  else if (Array.isArray(data?.data)) arr = data.data;
  else if (data && typeof data === 'object' && data.choice) arr = [data.choice];
  return arr.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      return item.choice || item.label || item.candidate || item.text || item.result || '';
    }
    return String(item ?? '');
  });
}

export async function classifyWithJev({ items = [], candidates = [], apiKey, endpoint, signal } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Enter a Jev API key for classification.');
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Provide at least one candidate choice for Jev classification.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const url = (typeof endpoint === 'string' && endpoint.trim())
    ? endpoint.trim()
    : 'https://api.typesafe.ai/v1/classify';

  const cleanKey = apiKey.trim();
  const authHeader = cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': authHeader
  };
  const payload = {
    inputs: items.map(it => ({
      text: typeof it?.text === 'string' ? it.text : String(it?.text || ''),
      context: typeof it?.context === 'string' ? it.context : String(it?.context || '')
    })),
    choices: candidates.map(c => typeof c === 'string' ? c : String(c.name || c.speaker || c))
  };

  let data;
  try {
    data = await jevPost(url, headers, payload, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Jev classification failed: ${err.message}`, {cause:err});
  }
  const choices = extractChoices(data);
  if (choices.length !== items.length || choices.some(choice => !payload.choices.includes(choice))) {
    throw new Error('Jev returned incomplete or unknown classification choices.');
  }
  return choices;
}

export async function planWithJev({ transcript, config, apiKey, endpoint, context = '', decisionConnection, signal, userId } = {}) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new Error('Choose a message with text to plan.');
  }
  if (!config) throw new Error('Configuration required for planning.');
  validateCastConfig(config);

  const hasSpindleDecisions = typeof spindle !== 'undefined' && typeof spindle?.decisions?.evaluate === 'function';
  const key = apiKey || config.jevApiKey;
  if (!hasSpindleDecisions && (!key || typeof key !== 'string' || !key.trim())) {
    throw new Error('Enter a Jev API key for this session.');
  }
  const ep = endpoint || config.jevEndpoint;

  const units = speechSourceUnits(transcript);
  if (!units || !units.length) throw new Error('No speech units found in transcript.');

  const allCast = [...(config.fixed || []), ...(config.npcs || [])];
  const listenerNorm = typeof config.listener === 'string' && config.listener.trim()
    ? normalizeName(config.listener)
    : (config.listener === false ? null : 'persona');

  const candidates = [];
  for (const actor of allCast) {
    const name = (actor.speaker || actor.name || '').trim();
    if (!name) continue;
    const norm = normalizeName(name);
    if (norm === 'narrator') continue;
    if (listenerNorm && norm === listenerNorm) continue;
    if (!candidates.includes(name)) candidates.push(name);
  }
  if (candidates.length === 0) {
    const narrator = config.fixed?.find(a => normalizeName(a.speaker) === 'narrator');
    if (narrator?.speaker) candidates.push(narrator.speaker);
    else if (allCast[0]?.speaker) candidates.push(allCast[0].speaker);
    else candidates.push('Narrator');
  }

  const dialogueUnits = units.filter(u => u.kind === 'dialogue');
  let speakerChoices = [];
  let emotionChoices = [];

  if (dialogueUnits.length > 0) {
    if (hasSpindleDecisions) {
      const questions = {};
      // Each question carries its line in place: a bare quote such as "Robots?" cannot be attributed on its own.
      const passage = u => `${transcript.slice(Math.max(0, u.start - 300), u.start)}[[${u.text}]]${transcript.slice(u.end, u.end + 300)}`;
      dialogueUnits.forEach((u, i) => {
        if (candidates.length >= 2) {
          const criteria = {};
          for (const c of candidates) criteria[c] = c;
          questions[`speaker_${i}`] = {
            type: 'choice',
            instructions: `Which character speaks the line marked [[ ]] in this passage: "${passage(u)}"?`,
            criteria
          };
        }
        if (config.useStyle !== false) {
          questions[`emotion_${i}`] = {
            type: 'choice',
            instructions: `What is the emotional delivery style of the line marked [[ ]] in this passage: "${passage(u)}"?`,
            criteria: {
              neutral: 'Normal speaking tone',
              cheerful: 'Cheerful or happy',
              whispering: 'Whispering or soft',
              angry: 'Angry or irritated',
              sad: 'Sad or sorrowful',
              sigh: 'Sighing or weary'
            }
          };
        }
      });
      if (Object.keys(questions).length > 0) {
        const evalResult = await spindle.decisions.evaluate({
          userId: userId || undefined,
          connection_id: decisionConnection || config.decisionConnection || undefined,
          state: {
            transcript,
            characters: candidates
          },
          questions
        }, { signal });
        for (let i = 0; i < dialogueUnits.length; i++) {
          if (candidates.length >= 2) {
            speakerChoices[i] = evalResult.answers?.[`speaker_${i}`]?.choice || candidates[0];
          } else {
            speakerChoices[i] = candidates[0];
          }
          if (config.useStyle !== false) {
            emotionChoices[i] = evalResult.answers?.[`emotion_${i}`]?.choice || 'neutral';
          }
        }
      } else {
        speakerChoices = dialogueUnits.map(() => candidates[0]);
      }
    } else {
      const items = dialogueUnits.map(u => {
        const contextStart = Math.max(0, u.start - 300);
        const contextEnd = Math.min(transcript.length, u.end + 300);
        const localContext = transcript.slice(contextStart, contextEnd);
        const castAliases=allCast.filter(actor=>actor.aliases?.length).map(actor=>`${actor.speaker}: ${(actor.aliases || []).join(', ')}`).join('; ');
        const fullContext = [castAliases?`Character aliases: ${castAliases}`:'',context.slice(-1000),localContext].filter(Boolean).join('\n');
        return { text: u.text, context: fullContext };
      });

      speakerChoices = await classifyWithJev({
        items,
        candidates,
        apiKey: key,
        endpoint: ep,
        signal
      });

      if (config.useStyle !== false) {
        const emotions = ["neutral", "cheerful", "whispering", "angry", "sad", "sigh"];
        try {
          emotionChoices = await classifyWithJev({
            items,
            candidates: emotions,
            apiKey: key,
            endpoint: ep,
            signal
          });
        } catch (error) {
          if(signal?.aborted)throw error;
          emotionChoices = [];
        }
      }
    }
  }

  const dialogueSpeakerMap = new Map();
  const dialogueEmotionMap = new Map();
  for (let i = 0; i < dialogueUnits.length; i++) {
    const u = dialogueUnits[i];
    dialogueSpeakerMap.set(u.id, speakerChoices[i] || candidates[0]);
    const emotion = emotionChoices[i];
    if (emotion && emotion.toLowerCase() !== 'neutral') {
      dialogueEmotionMap.set(u.id, emotion);
    }
  }

  const narrator = config.fixed?.find(a => normalizeName(a.speaker) === 'narrator');
  const rawSegments = [];
  for (const u of units) {
    if (u.kind === 'narration') {
      rawSegments.push({
        unit_ids: [u.id],
        speaker: narrator?.speaker || 'Narrator',
        voice: narrator?.voice || '',
        style: '',
        route: narrator?.route || config.defaultRoute || '',
        gender: narrator?.gender || 'auto'
      });
    } else {
      const chosenName = dialogueSpeakerMap.get(u.id) || candidates[0] || 'Narrator';
      const actor = allCast.find(a => normalizeName(a.speaker) === normalizeName(chosenName))
        || { speaker: chosenName, voice: '', style: '', gender: 'auto' };
      const style = dialogueEmotionMap.get(u.id) || '';
      let voice = actor.voice || '';
      if (!voice && config.voices?.length) {
        const route = actor.route || config.defaultRoute || '';
        const match = config.voices.find(v => (v.route || '') === route) || config.voices[0];
        voice = match?.id || '';
      }
      rawSegments.push({
        unit_ids: [u.id],
        speaker: actor.speaker || chosenName,
        voice,
        style,
        route: actor.route || config.defaultRoute || '',
        gender: actor.gender || 'auto'
      });
    }
  }

  const rawPlan = { segments: rawSegments };
  const resolved = resolvePlanReferences(rawPlan, transcript, config);
  const plan = validatePlan(resolved, transcript, config);
  return plan;
}

if (typeof globalThis !== 'undefined') {
  globalThis.classifyWithJev = classifyWithJev;
  globalThis.planWithJev = planWithJev;
}

const jsonResponseParameters = connection =>
  ['google','aistudio','vertex','google-ai-studio','vertex-ai','google_tts','google_vertex_tts'].includes(String(connection.provider || '').toLowerCase())
    ? {responseMimeType:'application/json'}
    : connection.provider==='openai' ? {response_format:{type:'json_object'}} : {};

// Spindle supplies this global before importing the backend bundle.
const running = new Map();
const identity = (user,session,id) => JSON.stringify([user,session || '',id]);

if (typeof spindle !== 'undefined' && spindle?.onFrontendMessage) {
spindle.onFrontendMessage((message, userId, frontendSessionId) => {
  if (!message || message.namespace !== 'choir' || typeof message.id !== 'string') return;
  const key = identity(userId,frontendSessionId,message.id);
  if (message.action === 'cancel') { running.get(key)?.abort(); return; }
  if (running.has(key)) return;
  const controller = new AbortController();
  running.set(key,controller);
  const send = payload => {
    if (!controller.signal.aborted) spindle.sendToFrontend({namespace:'choir',id:message.id,...payload},userId,{frontendSessionId});
  };
  let lastProgress={stage:'Starting request'};
  const progress=update=>{lastProgress=update;send({progress:update});};
  const timer = setTimeout(() => { send({error:message.action==='plan' || message.action==='testPlanner' || message.action==='planJev' || message.action==='planWithJev'
    ? `Planner timed out while ${lastProgress.stage}. ${lastProgress.provider || ''} ${lastProgress.model || ''}. Check this LLM connection in Lumiverse. Speech chunk size does not affect planning.`
    : 'Speech generation timed out. Try a shorter speech request or check the TTS provider.'}); controller.abort(); },message.action==='testPlanner'?60000:(message.action==='plan' || message.action==='planJev' || message.action==='planWithJev')?Math.min(600000,Math.max(1000,Number(message.input?.timeoutMs)||600000)):180000);
  let jevFailure;
  (async () => {
    const input = message.input || {};
    if (message.action === 'ping') {
      send({result:{version:'1.1.5-staging.11',ready:true}});return;
    }
    if(message.action==='testPlanner') {
      const mode=resolvePlannerMode(input);
      if(mode==='heuristic'){
        const config=input.config || {fixed:[{speaker:'Narrator',voice:'local',style:''}],npcs:[],voices:[{id:'local'}],useStyle:false};
        if(!fastClassifyPlan('The room fell quiet.',config))throw new Error('Assign a narrator voice to test the local heuristic. No LLM request was made.');
        send({result:{provider:'Local',model:'Heuristic',response:'READY · No LLM request was made.'}});return;
      }
      if (mode === 'jev') {
        progress({stage:'Testing Decision model classification'});
        if (typeof spindle !== 'undefined' && typeof spindle?.decisions?.evaluate === 'function') {
          const start = Date.now();
          const evalRes = await spindle.decisions.evaluate({
            userId: userId || input.userId || undefined,
            connection_id: input.decisionConnection || input.config?.decisionConnection || undefined,
            state: { context: 'Alice smiled at Bob.' },
            questions: {
              speaker: {
                type: 'choice',
                instructions: 'Which character speaks: "Hello there, how are you today?"?',
                criteria: { Alice: 'Alice', Bob: 'Bob' }
              }
            }
          }, { signal: controller.signal });
          const duration = Date.now() - start;
          send({result:{provider:evalRes.provider || 'TypeSafe AI',model:evalRes.model || 'Jev System 1',response:`READY · Classified in ${duration}ms (choice: ${evalRes.answers?.speaker?.choice || 'Alice'})`}});
          return;
        }
        const apiKey = input.apiKey || input.jevApiKey;
        const endpoint = input.endpoint || input.jevEndpoint;
        const start = Date.now();
        const res = await classifyWithJev({
          items: [{ text: 'Hello there, how are you today?', context: 'Alice smiled at Bob.' }],
          candidates: ['Alice', 'Bob'],
          apiKey,
          endpoint,
          signal: controller.signal
        });
        const duration = Date.now() - start;
        send({result:{provider:'TypeSafe AI',model:'Jev System 1',response:`READY · Classified in ${duration}ms (choice: ${res[0] || 'Alice'})`}});
        return;
      }
      progress({stage:'Resolving saved LLM connection'});
      const connection=input.connectionId?await spindle.connections.get(input.connectionId,userId):(await spindle.connections.list(userId)).find(profile=>profile.is_default);
      if(controller.signal.aborted)return;
      if(!connection?.model)throw new Error('Select a Planner LLM connection with a configured text-generation model.');
      progress({stage:'Waiting for a short LLM test response',provider:connection.provider,model:connection.model});
      const result=await spindle.generate.raw({type:'raw',userId,model:connection.model,connection_id:connection.id,
        messages:[{role:'user',content:'Reply with the single word READY.'}],parameters:{max_tokens:64},reasoning:{source:'off'},signal:controller.signal});
      if(controller.signal.aborted)return;
      if(!String(result.content || '').trim())throw new Error(`Planner test returned no text: ${connection.provider} · ${connection.model}. Check model access and response settings.`);
      send({result:{provider:connection.provider || 'Saved connection',model:connection.model,response:String(result.content).trim().slice(0,200)}});return;
    }
    if (message.action === 'planJev' || message.action === 'planWithJev') {
      if (typeof input.transcript !== 'string' || !input.transcript.trim()) throw new Error('Choose a message with text to plan.');
      validateCastConfig(input.config);
      progress({stage:'Classifying with Jev System 1'});
      const apiKey = input.apiKey || input.config?.jevApiKey;
      const endpoint = input.endpoint || input.config?.jevEndpoint;
      const plan = await planWithJev({
        transcript: input.transcript,
        config: input.config,
        apiKey,
        endpoint,
        decisionConnection: input.decisionConnection || input.config?.decisionConnection,
        context: input.context,
        signal: controller.signal,
        userId: userId || input.userId
      });
      if (controller.signal.aborted) return;
      send({result:plan});return;
    }
    if (message.action === 'classifyJev' || message.action === 'classifyWithJev') {
      const apiKey = input.apiKey || input.config?.jevApiKey;
      const endpoint = input.endpoint || input.config?.jevEndpoint;
      const result = await classifyWithJev({
        items: input.items,
        candidates: input.candidates,
        apiKey,
        endpoint,
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      send({result});return;
    }
    if (message.action === 'plan') {
      if (typeof input.transcript !== 'string' || !input.transcript.trim()) throw new Error('Choose a message with text to plan.');
      validateCastConfig(input.config);
      const mode=resolvePlannerMode(input.config);
      if(mode==='heuristic'){
        const plan=fastClassifyPlan(input.transcript,input.config);
        if(!plan)throw new Error('Heuristic could not safely attribute this dialogue or choose an unassigned voice. Choose Jev or LLM. No LLM request was made.');
        send({result:plan});return;
      }
      if (mode === 'jev') {
        try {
          progress({stage:'Classifying with Jev System 1'});
          const plan = await planWithJev({
            transcript: input.transcript,
            config: input.config,
            apiKey: input.apiKey || input.config.jevApiKey,
            endpoint: input.endpoint || input.config.jevEndpoint,
            decisionConnection: input.decisionConnection || input.config?.decisionConnection,
            context: input.context,
            signal: controller.signal,
            userId: userId || input.userId
          });
          if (controller.signal.aborted) return;
          send({result:plan});return;
        } catch (jevError) {
          if (controller.signal.aborted) return;
          if (input.config.allowLlmFallback !== true) throw jevError;
          jevFailure = jevError;
          progress({stage:`Jev failed: ${jevError.message}. Using explicitly enabled LLM fallback.`});
        }
      }
      progress({stage:'Resolving saved LLM connection'});
      const context = typeof input.context === 'string' ? input.context.slice(-4000) : '';
      const messages = plannerPrompt(input.transcript,input.config,context);
      const connection=input.connectionId
        ? await spindle.connections.get(input.connectionId,userId)
        : (await spindle.connections.list(userId)).find(profile=>profile.is_default);
      if(controller.signal.aborted)return;
      if(!connection?.model)throw new Error('Select a Planner LLM connection with a configured text-generation model.');
      let maxTokens=input.maxTokens ?? 8192;
      if(!Number.isInteger(maxTokens) || maxTokens<1024 || maxTokens>32768)throw new Error('Planner output budget must be 1024–32768 tokens.');
      let failure;
      for (let attempt=0;attempt<2;attempt++) {
        progress({stage:`Waiting for planner response (attempt ${attempt+1}/2)`,provider:connection.provider,model:connection.model});
        // Raw calls use the saved connection credentials without inheriting a chat preset's
        // short output limit, stop strings, response format or reasoning budget.
        const request = {type:'raw',userId,model:connection.model,
          connection_id:connection.id,messages,parameters:{max_tokens:maxTokens,...jsonResponseParameters(connection)},
          reasoning:{source:'off'},signal:controller.signal};
        let result;
        if(typeof spindle.generate.rawStream==='function') {
          let content='',lastUpdate=0,received=0,completed=false;
          for await(const chunk of spindle.generate.rawStream(request)) {
            if(controller.signal.aborted)return;
            if(chunk.type==='done') {result={content:chunk.content,finish_reason:chunk.finish_reason};completed=true;break;}
            if(chunk.type==='token')content+=chunk.token || '';
            if(chunk.type==='token' || chunk.type==='reasoning') {
              received++;
              if(received===1 || Date.now()-lastUpdate>=1000) {
                lastUpdate=Date.now();
                progress({stage:content.length?`Receiving planner output (${content.length} characters; attempt ${attempt+1}/2)`:`Planner is processing (attempt ${attempt+1}/2)`,provider:connection.provider,model:connection.model});
              }
            }
          }
          if(!completed)throw new Error('Planner stream ended before completion. Check the LLM connection or retry.');
        } else result=await spindle.generate.raw(request);
        if (controller.signal.aborted) return;
        progress({stage:'Validating planner response',provider:connection.provider,model:connection.model});
        try {
          const plan = validatePlan(resolvePlanReferences(parsePlanJson(result.content),input.transcript,input.config),input.transcript,input.config);
          send({result:{...plan,...(jevFailure?{warning:jevFailure.message}:{})}}); return;
        } catch (error) {
          const truncated=/length|max_tokens|max_output_tokens/i.test(result.finish_reason || '');
          failure = truncated ? new Error('The planner response was cut off by its output limit. Increase the planner output budget or plan a shorter reply.') : error;
          maxTokens=Math.min(32768,maxTokens*2);
          messages.push({role:'assistant',content:String(result.content || '').slice(0,50000)},
            {role:'user',content:`Your plan failed validation: ${failure.message}. Return a corrected complete JSON plan using unit_ids. Include every source unit ID exactly once in order. Do not copy or rewrite transcript text.`});
        }
      }
      throw new Error(`Planner failed twice: ${failure.message}`);
    }
    if (message.action === 'sfx') {
      const segments=Array.isArray(input.segments)?input.segments.filter(segment=>typeof segment?.text==='string' && segment.text.trim()):[];
      if(!segments.length){send({result:{cues:[],ambience:[]}});return;}
      progress({stage:'Resolving saved LLM connection'});
      const connection=input.connectionId?await spindle.connections.get(input.connectionId,userId):(await spindle.connections.list(userId)).find(profile=>profile.is_default);
      if(controller.signal.aborted)return;
      if(!connection?.model)throw new Error('Select a Planner LLM connection with a text-generation model to choose sound effects.');
      progress({stage:'Waiting for sound effect choices',provider:connection.provider,model:connection.model});
      const result=await spindle.generate.raw({type:'raw',userId,model:connection.model,connection_id:connection.id,messages:soundCuePrompt(segments),
        parameters:{max_tokens:2048,...jsonResponseParameters(connection)},reasoning:{source:'off'},signal:controller.signal});
      if(controller.signal.aborted)return;
      send({result:parseSoundCues(result.content,segments)});return;
    }
    if (message.action === 'designVoice') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('Enter a Gemini API key for this session.');
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Describe the voice to design.');
      const response = await spindle.cors('https://generativelanguage.googleapis.com/v1beta/voices', {
        method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':input.apiKey.trim()},
        body:JSON.stringify({type:'prompted',prompt:input.prompt.trim(),store:true})
      });
      if (controller.signal.aborted) return;
      if (response.status < 200 || response.status >= 300) {
        let detail = '';
        try { detail = JSON.parse(response.body)?.error?.message || ''; } catch {}
        throw new Error(`Gemini Voice Design HTTP ${response.status}${detail ? `: ${detail}` : ''}. Check API key and quota.`);
      }
      const data = JSON.parse(response.body);
      const voiceId = (data?.name || data?.id || data?.voice?.id || data?.voice?.name || '').replace(/^voices\//, '');
      if (!voiceId) throw new Error('Gemini Voice Design did not return a voice ID.');
      send({result:{id:voiceId,name:voiceId,description:input.prompt.trim()}});return;
    }
    if (message.action === 'fishaudio') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('Enter a Fish Audio API key for this session.');
      const segment = input.segment;
      if (!segment || typeof segment.text !== 'string' || !segment.text.trim()) throw new Error('Invalid speech chunk.');
      const text = segment.style && !segment.text.startsWith('[') ? `[${segment.style}] ${segment.text}` : segment.text;
      const model = input.model || 's2.1-pro';
      const response = await spindle.cors('https://api.fish.audio/v1/tts', {
        method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${input.apiKey.trim()}`,'model':model},
        body:JSON.stringify({text,reference_id:segment.voice || undefined,format:'mp3'})
      });
      if (controller.signal.aborted) return;
      if (response.status < 200 || response.status >= 300) {
        let detail = '';
        try { detail = JSON.parse(response.body)?.message || JSON.parse(response.body)?.error || ''; } catch {}
        throw new Error(`Fish Audio HTTP ${response.status}${detail ? `: ${detail}` : ''}. Check API key and quota.`);
      }
      send({result:{base64:response.body,mimeType:'audio/mpeg'}}); return;
    }
    if (message.action === 'freesound') {
      const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : '';
      if (!apiKey) throw new Error('Freesound API key is required. Configure it in Choir Advanced Settings.');
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) throw new Error('Search query is required.');
      const filter = typeof input.filter === 'string' && input.filter.trim() ? input.filter.trim() : 'duration:[0.1 TO 2.5]';
      const url = `https://freesound.org/apiv2/search/?query=${encodeURIComponent(query)}&filter=${encodeURIComponent(filter)}&fields=id,name,duration,previews,tags&sort=score&page_size=5`;
      const headers={'Accept':'application/json','Authorization':`Token ${apiKey}`};
      let resData;
      if (typeof spindle !== 'undefined' && typeof spindle?.cors === 'function') {
        controller.signal.throwIfAborted();
        const resp = await spindle.cors(url, { method: 'GET', headers });
        controller.signal.throwIfAborted();
        if (resp.status < 200 || resp.status >= 300) {
          throw new Error(`Freesound HTTP ${resp.status}`);
        }
        resData = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
      } else if (typeof fetch === 'function') {
        const resp = await fetch(url, { headers, signal: controller.signal });
        if (!resp.ok) throw new Error(`Freesound HTTP ${resp.status}`);
        resData = await resp.json();
      } else {
        throw new Error('No HTTP transport available.');
      }
      const results = (Array.isArray(resData?.results) ? resData.results : []).map(r => ({
        id: r.id,
        name: r.name,
        duration: r.duration,
        previewUrl: r.previews?.['preview-hq-mp3'] || r.previews?.['preview-lq-mp3'] || Object.values(r.previews || {})[0] || null,
        tags: Array.isArray(r.tags) ? r.tags.slice(0, 5) : []
      })).filter(r => r.previewUrl);
      send({ result: { query, results } }); return;
    }
    if (message.action === 'searchVoices') {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) throw new Error('Enter a character or voice name to search.');
      const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
      const response = await spindle.cors(`https://api.fish.audio/model?title=${encodeURIComponent(query)}&page_size=${limit}`, {
        method: 'GET', headers: { 'Accept': 'application/json' }
      });
      if (controller.signal.aborted) return;
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Voice search HTTP ${response.status}. Check network connection.`);
      }
      const data = JSON.parse(response.body);
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      const results = items.map(item => ({
        id: item._id || item.id,
        name: item.title || item.name || item._id,
        description: (item.description || '').slice(0, 300),
        coverImage: item.cover_image ? `https://public-platform.r2.fish.audio/${item.cover_image}` : (item.author?.avatar ? `https://public-platform.r2.fish.audio/${item.author.avatar}` : null),
        sampleAudio: item.samples?.[0]?.audio || null,
        sampleText: item.samples?.[0]?.text || item.default_text || '',
        author: item.author?.nickname || '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
        languages: Array.isArray(item.languages) ? item.languages : []
      })).filter(item => item.id);
      send({ result: { query, results } }); return;
    }
    if (message.action === 'gemini') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('Enter a Gemini API key for this session.');
      const segment = input.segment;
      if (!segment || typeof segment.text !== 'string' || segment.text.length > MAX_SPEECH_CHARS || !segment.text.trim()) throw new Error('Invalid speech chunk.');
      if (typeof segment.voice !== 'string' || segment.voice.length > 200 || typeof segment.style !== 'string' || segment.style.length > 1300) throw new Error('Invalid voice or style.');
      if(segment.turns && (!Array.isArray(segment.turns) || segment.turns.some(turn=>typeof turn.text!=='string' || typeof turn.speaker!=='string' || turn.speaker.length>200 || typeof turn.voice!=='string' || turn.voice.length>200 || typeof turn.style!=='string' || turn.style.length>1300)))throw new Error('Invalid batch turns.');
      const body = geminiRequest(segment,input.model);
      let response = await spindle.cors(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,{
        method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':input.apiKey.trim()},body:JSON.stringify(body)
      });
      if (controller.signal.aborted) return;
      const isCustomVoice = v => typeof v === 'string' && (v.startsWith('voice_') || v.includes('_'));
      const fallbackVoice = gender => gender === 'female' ? 'Kore' : 'Charon';
      const hasCustomVoice = isCustomVoice(segment.voice) || (Array.isArray(segment.turns) && segment.turns.some(turn => isCustomVoice(turn.voice)));
      if (input.allowVoiceFallback === true && (response.status === 404 || response.status === 400) && hasCustomVoice) {
        let detail = '';
        try { detail = JSON.parse(response.body)?.error?.message || response.body || ''; } catch { detail = String(response.body || ''); }
        if (response.status === 404 || !detail || /voice|not found|invalid/i.test(detail)) {
          const fallbackSegment = {
            ...segment,
            voice: isCustomVoice(segment.voice) ? fallbackVoice(segment.gender) : segment.voice,
            ...(segment.turns ? {
              turns: segment.turns.map(turn => ({
                ...turn,
                voice: isCustomVoice(turn.voice) ? fallbackVoice(turn.gender) : turn.voice
              }))
            } : {})
          };
          const retryBody = geminiRequest(fallbackSegment, input.model);
          response = await spindle.cors(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, {
            method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':input.apiKey.trim()},body:JSON.stringify(retryBody)
          });
          if (controller.signal.aborted) return;
        }
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Gemini TTS HTTP ${response.status}. Check key, quota and model access.`);
      send({result:extractGeminiAudio(JSON.parse(response.body))}); return;
    }
    throw new Error('Unknown Choir action.');
  })().catch(error => send({error: [jevFailure?.message, error?.message || 'Choir request failed.'].filter(Boolean).join('\nLLM fallback failed: ')}))
    .finally(() => {clearTimeout(timer);running.delete(key);});
});
}
