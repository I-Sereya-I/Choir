// Run with Bun from the patched Lumiverse directory (or set LUMIVERSE_ROOT).
import {test,expect} from 'bun:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.LUMIVERSE_ROOT || process.cwd();
const {buildFishAudioBody}=await import(pathToFileURL(path.join(root,'src/tts/providers/fish-audio.ts')).href);
const {buildGeminiTtsBody}=await import(pathToFileURL(path.join(root,'src/tts/providers/google-tts-shared.ts')).href);
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
