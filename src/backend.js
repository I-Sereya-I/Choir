import { validateCastConfig, validatePlan, parsePlanJson, resolvePlanReferences, plannerPrompt, geminiRequest, extractGeminiAudio } from './core.js';

// Spindle supplies this global before importing the backend bundle.
const running = new Map();
const identity = (user,session,id) => JSON.stringify([user,session || '',id]);

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
  const timer = setTimeout(() => { send({error:message.action==='plan' || message.action==='testPlanner'
    ? `Planner timed out while ${lastProgress.stage}. ${lastProgress.provider || ''} ${lastProgress.model || ''}. Check this LLM connection in Lumiverse. Speech chunk size does not affect planning.`
    : 'Speech generation timed out. Try a shorter speech request or check the TTS provider.'}); controller.abort(); },message.action==='testPlanner'?60000:message.action==='plan'?Math.min(600000,Math.max(1000,Number(message.input?.timeoutMs)||600000)):180000);
  (async () => {
    const input = message.input || {};
    if (message.action === 'ping') {
      send({result:{version:'1.0.18',ready:true}});return;
    }
    if(message.action==='testPlanner') {
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
    if (message.action === 'plan') {
      if (typeof input.transcript !== 'string' || !input.transcript.trim()) throw new Error('Choose a message with text to plan.');
      validateCastConfig(input.config);
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
          connection_id:connection.id,messages,parameters:{max_tokens:maxTokens,
            ...(connection.provider==='google'?{responseMimeType:'application/json'}:
              connection.provider==='openai'?{response_format:{type:'json_object'}}:{})},
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
          send({result:plan}); return;
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
    if (message.action === 'gemini') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('Enter a Gemini API key for this session.');
      const segment = input.segment;
      if (!segment || typeof segment.text !== 'string' || segment.text.length > 2000 || !segment.text.trim()) throw new Error('Invalid speech chunk.');
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
      if ((response.status === 404 || response.status === 400) && hasCustomVoice) {
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
  })().catch(error => send({error: error?.message || 'Choir request failed.'}))
    .finally(() => {clearTimeout(timer);running.delete(key);});
});
