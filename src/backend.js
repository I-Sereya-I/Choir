import { validateCastConfig, validatePlan, parsePlanJson, plannerPrompt, geminiRequest, extractGeminiAudio } from './core.js';

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
  const timer = setTimeout(() => { send({error:'Request timed out. Try shorter speech chunks or a faster planner.'}); controller.abort(); },180000);
  (async () => {
    const input = message.input || {};
    if (message.action === 'ping') {
      send({result:{version:'1.0.4',ready:true}});return;
    }
    if (message.action === 'plan') {
      if (typeof input.transcript !== 'string' || !input.transcript.trim() || input.transcript.length > 30000) throw new Error('Speech planning supports 1–30,000 characters per message.');
      validateCastConfig(input.config);
      const context = typeof input.context === 'string' ? input.context.slice(-16000) : '';
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
        // Raw calls use the saved connection credentials without inheriting a chat preset's
        // short output limit, stop strings, response format or reasoning budget.
        const result = await spindle.generate.raw({type:'raw',userId,model:connection.model,
          connection_id:connection.id,messages,parameters:{max_tokens:maxTokens,
            ...(connection.provider==='google'?{responseMimeType:'application/json'}:
              connection.provider==='openai'?{response_format:{type:'json_object'}}:{})},
          reasoning:{source:'off'},signal:controller.signal});
        if (controller.signal.aborted) return;
        try {
          const plan = validatePlan(parsePlanJson(result.content),input.transcript,input.config);
          send({result:plan}); return;
        } catch (error) {
          const truncated=/length|max_tokens|max_output_tokens/i.test(result.finish_reason || '');
          failure = truncated ? new Error('The planner response was cut off by its output limit. Increase the planner output budget or plan a shorter reply.') : error;
          maxTokens=Math.min(32768,maxTokens*2);
          messages.push({role:'assistant',content:String(result.content || '').slice(0,50000)},
            {role:'user',content:`Your plan failed validation: ${failure.message}. Return a corrected complete JSON plan. Copy exact consecutive substrings of the original transcript.`});
        }
      }
      throw new Error(`Planner failed twice: ${failure.message}`);
    }
    if (message.action === 'gemini') {
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) throw new Error('Enter a Gemini API key for this session.');
      const segment = input.segment;
      if (!segment || typeof segment.text !== 'string' || segment.text.length > 2000 || !segment.text.trim()) throw new Error('Invalid speech chunk.');
      if (typeof segment.voice !== 'string' || segment.voice.length > 200 || typeof segment.style !== 'string' || segment.style.length > 1300) throw new Error('Invalid voice or style.');
      const body = geminiRequest(segment,input.model);
      const response = await spindle.cors(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,{
        method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':input.apiKey.trim()},body:JSON.stringify(body)
      });
      if (controller.signal.aborted) return;
      if (response.status < 200 || response.status >= 300) throw new Error(`Gemini TTS HTTP ${response.status}. Check key, quota and model access.`);
      send({result:extractGeminiAudio(JSON.parse(response.body))}); return;
    }
    throw new Error('Unknown Choir action.');
  })().catch(error => send({error: error?.message || 'Choir request failed.'}))
    .finally(() => {clearTimeout(timer);running.delete(key);});
});
