// Run with Bun from the patched Lumiverse directory (or set LUMIVERSE_ROOT).
import {test,expect} from 'bun:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.LUMIVERSE_ROOT || process.cwd();
const {buildFishAudioBody}=await import(pathToFileURL(path.join(root,'src/tts/providers/fish-audio.ts')).href);
const {buildGeminiTtsBody}=await import(pathToFileURL(path.join(root,'src/tts/providers/google-tts-shared.ts')).href);
const {OpenRouterTtsProvider}=await import(pathToFileURL(path.join(root,'src/tts/providers/openrouter-tts.ts')).href);
const turns=[{speaker:'Narrator',voice:'Charon',text:'The gate opened.',style:'Calm'},{speaker:'Alice',voice:'Kore',text:'Hello.',style:'Warm'},{speaker:'Narrator',voice:'Charon',text:'She smiled.'}];
const request=(model:string,entries=turns)=>({text:entries.map(turn=>turn.text).join('\n'),voice:entries[0].voice,model,parameters:{turns:entries}});
test('Fish sends repeated speakers to the same reference in one call',()=>{
  const body=buildFishAudioBody(request('s2.1-pro'));
  expect(body.reference_id).toEqual(['Charon','Kore']);
  expect(body.text).toBe('<|speaker:0|>[Calm] The gate opened.\n<|speaker:1|>[Warm] Hello.\n<|speaker:0|>She smiled.');
});
test('Google sends structured dialogue with two prebuilt voices',()=>{
  const body=buildGeminiTtsBody(request('gemini-3.8-flash-tts'));
  expect(body.contents[0].parts.map((part:any)=>part.speech_metadata.speaker)).toEqual(['Speaker0','Speaker1','Speaker0']);
  expect(body.generationConfig.speech_config.multi_speaker_voice_config.speaker_voice_configs.map((s:any)=>s.voice_config.prebuilt_voice_config.voice_name)).toEqual(['Charon','Kore']);
});
test('relay rejects unsupported models, custom Gemini voices, conflicts and excessive size',()=>{
  expect(()=>buildFishAudioBody(request('s1'))).toThrow();
  expect(()=>buildGeminiTtsBody(request('gemini-3.1-flash-tts-preview'))).toThrow();
  expect(()=>buildGeminiTtsBody(request('gemini-3.8-flash-tts',[turns[0],{...turns[1],voice:'voice_custom'}]))).toThrow();
  expect(()=>buildFishAudioBody(request('s2-pro',[turns[0],{...turns[0],voice:'other'}]))).toThrow();
  expect(()=>buildGeminiTtsBody(request('gemini-3.8-flash-tts',[{...turns[0],text:'你'.repeat(2100)}]))).toThrow();
});

test('OpenRouter Fish sends ordered text and voice turns as one request without embedding directions in spoken text',async()=>{
  const originalFetch=globalThis.fetch,provider=new OpenRouterTtsProvider();let calls=0,body:any;
  try {
    globalThis.fetch=async(_url:any,init:any)=>{calls++;body=JSON.parse(init.body);return new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'audio/mpeg'}});};
    const entries=turns.map((turn,index)=>({...turn,voice:(index===1?'2':'1').repeat(32)}));
    await provider.synthesize('test-key','',request('fish-audio/s2.1-pro-free:free',entries));
    expect(calls).toBe(1);expect(body.input).toEqual(entries.map(turn=>({text:turn.text,voice:turn.voice,...(turn.style?{instructions:turn.style}:{})})));
    expect(body.response_format).toBe('mp3');expect(body.instructions).toBeUndefined();
    expect(provider.capabilities.multiSpeaker.maxSpeakersByModel['fish-audio/s2.1-pro-free:free']).toBe(5);
  }finally{globalThis.fetch=originalFetch;}
});

test('OpenRouter Gemini sends ordered dialogue in one call and wraps the shared PCM recording once',async()=>{
  const originalFetch=globalThis.fetch,provider=new OpenRouterTtsProvider();let calls=0,body:any;
  try {
    globalThis.fetch=async(_url:any,init:any)=>{calls++;body=JSON.parse(init.body);return new Response(new Uint8Array([0,0,1,0]),{headers:{'Content-Type':'audio/pcm'}});};
    const audio=await provider.synthesize('test-key','',request('google/gemini-3.8-flash-lite-tts'));
    expect(calls).toBe(1);expect(body.input.map((turn:any)=>[turn.voice,turn.text])).toEqual(turns.map(turn=>[turn.voice,turn.text]));
    expect(body.input[0].instructions).toBe('Calm');expect(body.input[1].instructions).toBe('Warm');
    expect(body.response_format).toBe('pcm');expect(audio.contentType).toBe('audio/wav');expect(Buffer.from(audio.audioData.slice(0,4)).toString()).toBe('RIFF');
    expect(provider.capabilities.multiSpeaker.maxSpeakersByModel['google/gemini-3.8-flash-lite-tts']).toBe(2);
  }finally{globalThis.fetch=originalFetch;}
});

test('OpenRouter rejects foreign Fish voices, unsupported dialogue and excessive turns or speakers before calling an API',async()=>{
  const originalFetch=globalThis.fetch,provider=new OpenRouterTtsProvider();let calls=0;
  try {
    globalThis.fetch=async()=>{calls++;return new Response(new Uint8Array([0,0]));};
    const fishTurns=turns.map((turn,index)=>({...turn,voice:(index===1?'2':'1').repeat(32)}));
    await expect(provider.synthesize('test-key','',{text:'Hello',voice:'Puck',model:'fish-audio/s2.1-pro-free:free',parameters:{}})).rejects.toThrow('Fish voice ID');
    await expect(provider.synthesize('test-key','',request('fish-audio/s1',fishTurns))).rejects.toThrow('not configured');
    await expect(provider.synthesize('test-key','',request('openai/gpt-4o-mini-tts'))).rejects.toThrow('not configured');
    await expect(provider.synthesize('test-key','',request('google/gemini-3.8-flash-tts',[...turns,{speaker:'Third',voice:'Puck',text:'Hello'}]))).rejects.toThrow('at most 2');
    await expect(provider.synthesize('test-key','',request('fish-audio/s2.1-pro-free:free',Array.from({length:6},(_,i)=>({speaker:`Person ${i}`,voice:String(i+1).repeat(32),text:'Hello'}))))).rejects.toThrow('at most 5');
    await expect(provider.synthesize('test-key','',request('fish-audio/s2-pro',Array.from({length:201},()=>fishTurns[0])))).rejects.toThrow('1–200');
    await expect(provider.synthesize('test-key','',request('google/gemini-3.8-flash-tts',[{...turns[0],text:'你'.repeat(2100)}]))).rejects.toThrow('size limit');
    expect(calls).toBe(0);
  }finally{globalThis.fetch=originalFetch;}
});
