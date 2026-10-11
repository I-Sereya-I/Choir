// Optional real-browser check: install playwright, then npm run test:chromium.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CHOIR_BROWSER_MODULES?path.join(process.env.CHOIR_BROWSER_MODULES,'package.json'):import.meta.url);
const {chromium}=require('playwright');
const errors=[];
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Choir integration fixture</title></head><body style="margin:0;background:#141923;color:#e5e9f0;font:16px system-ui;color-scheme:dark"><div style="display:grid;grid-template-columns:1fr 680px;gap:24px;padding:32px"><article><h1>Lumiverse · Choir</h1><p>The hall fell silent.</p><p>“Welcome.”</p><p>A new story begins.</p><footer></footer></article><main style="border:1px solid #ffffff30;border-radius:16px"></main></div><script type="module">
import {setup} from '/dist/frontend.js';import {validatePlan,speechSourceUnits} from '/src/core.js';
const store=new Map(),root=document.querySelector('main'),footer=document.querySelector('footer');let backend;window.calls=[];window.gains=[];window.audios=[];const RealAudio=window.Audio;window.Audio=function(url){const audio=new RealAudio(url);window.audios.push(audio);return audio;};
const createGain=AudioContext.prototype.createGain;AudioContext.prototype.createGain=function(){const gain=createGain.call(this);window.gains.push(gain);return gain;};
store.set('chat:fixture',{mode:'native',connection:'a',styleParam:'instructions',prefetch:1,concurrency:1,chunk:500,normalizeLoudness:true,fixed:[{speaker:'Narrator',voice:'n',style:'Measured narration'},{speaker:'You',voice:'y',style:''},{speaker:'Mira',voice:'m',style:'Warm',route:'native:b'}],casts:{'native:a':[]}});
const message={id:'reply',name:'Mira',content:'The hall fell silent. "Welcome." A new story begins.'};
function wav(amplitude){const count=24000,buffer=new ArrayBuffer(44+count*2),view=new DataView(buffer);function text(offset,value){for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));}text(0,'RIFF');view.setUint32(4,36+count*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,count*2,true);for(let i=0;i<count;i++)view.setInt16(44+i*2,Math.sin(i*2*Math.PI*220/24000)*32767*amplitude,true);return buffer;}
const realFetch=window.fetch;window.fetch=async(url,options={})=>{
 if(!String(url).startsWith('/api/v1'))return realFetch(url,options);
 if(url.endsWith('/tts/synthesize')){const input=JSON.parse(options.body);window.calls.push(input);return new Response(wav(input.voice==='m'?0.4:0.06),{headers:{'Content-Type':'audio/wav'}});}
 if(url.includes('/providers'))return Response.json({providers:[{id:'openai_tts',capabilities:{parameters:{instructions:{type:'string'}}}}]});
 if(url.endsWith('/voices'))return Response.json({voices:['n','y','m'].map(id=>({id,name:id}))});
 if(url.includes('/connections?'))return Response.json({data:[{id:'planner',name:'Planner',provider:'test',model:'text-model'}]});
 return Response.json({data:[{id:'a',name:'Narration',provider:'openai_tts',model:'model-a'},{id:'b',name:'Characters',provider:'openai_tts',model:'model-b'}]});
};
const ctx={settings:{get:async key=>structuredClone(store.get(key)??null),set:async(key,value)=>store.set(key,structuredClone(value))},messages:{getRecent:()=>[message],getContent:()=>message.content},state:{subscribe:()=>()=>{}},events:{on:()=>()=>{}},getActiveChat:()=>({chatId:'fixture'}),characters:{get:async()=>({name:'Mira'})},dom:{addStyle:css=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);return()=>style.remove();}},ui:{registerDrawerTab:()=>({root,activate(){},destroy(){root.replaceChildren();}}),registerInputBarAction:()=>({onClick(){},destroy(){}}),registerDomDecorator:options=>options.render(footer,{messageId:'reply'})},onBackendMessage:fn=>{backend=fn;return()=>backend=null;},sendToBackend:request=>{if(request.action==='cancel')return;setTimeout(()=>{let result;if(request.action==='ping')result={ready:true};else if(request.action==='plan')result=validatePlan({segments:speechSourceUnits(request.input.transcript).map(unit=>({speaker:unit.kind==='dialogue'?'Mira':'Narrator',text:unit.text,voice:unit.kind==='dialogue'?'m':'n',style:''}))},request.input.transcript,request.input.config);backend({namespace:'choir',id:request.id,result});},10);}};
window.cleanup=await setup(ctx);window.ready=true;
</script></body></html>`;
const server=createServer(async(request,response)=>{
  if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end(html);return;}
  if(!/^\/(src|dist)\/[a-z]+\.js$/.test(request.url)){response.writeHead(404);response.end();return;}
  try{response.setHeader('Content-Type','text/javascript');response.end(await readFile(new URL(`..${request.url}`,import.meta.url)));}catch{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,channel:process.env.CHOIR_BROWSER_CHANNEL || 'chrome',args:['--disable-crash-reporter']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
  assert.equal(await page.getByText('Guided setup',{exact:true}).count(),0);
  const cast=page.locator('[data-et="fixed"]');assert.equal(await cast.locator('[data-choir-cast-editor]').first().isVisible(),false);
  const narratorBounds=await cast.locator('.et-card').first().boundingBox();assert.ok(narratorBounds.height<55);
  await cast.getByRole('button',{name:'Edit Narrator',exact:true}).click();assert.equal(await cast.getByLabel('Speaker name',{exact:true}).first().isVisible(),true);
  await cast.getByRole('button',{name:'Close Narrator editor',exact:true}).click();assert.equal(await cast.locator('[data-choir-cast-editor]').first().isVisible(),false);
  const launcher=page.getByRole('button',{name:'Open Choir voice mixer',exact:true});
  const iconBounds=await launcher.boundingBox();assert.equal(Math.round(iconBounds.width),44);assert.equal(Math.round(iconBounds.height),44);
  assert.equal(await page.getByRole('slider',{name:'Master volume',exact:true}).isVisible(),false);
  await page.mouse.move(iconBounds.x+22,iconBounds.y+22);await page.mouse.down();await page.mouse.move(iconBounds.x+92,iconBounds.y+82);await page.mouse.up();
  const movedBounds=await launcher.boundingBox();assert.equal(Math.round(movedBounds.x-iconBounds.x),70);assert.equal(Math.round(movedBounds.y-iconBounds.y),60);
  assert.equal(await launcher.getAttribute('aria-expanded'),'false');
  if(process.env.CHOIR_ICON_SCREENSHOT)await page.screenshot({path:process.env.CHOIR_ICON_SCREENSHOT,clip:{x:Math.max(0,movedBounds.x-16),y:Math.max(0,movedBounds.y-16),width:76,height:76}});
  await launcher.press('Enter');assert.equal(await page.getByRole('slider',{name:'Master volume',exact:true}).isVisible(),true);
  await page.locator('[data-et="latest"]').click();await page.waitForFunction(()=>document.querySelector('[data-et="status"]').textContent.startsWith('Ready:'));
  await page.locator('[data-et="play"]').click();await page.waitForFunction(()=>document.querySelector('[data-choir-mixer]').textContent.includes('Speaking: Narrator'));
  await page.waitForFunction(()=>window.gains.length===1 && window.audios[0].paused===false && !document.querySelector('[data-et="pause"]').disabled);
  await page.locator('[data-et="pause"]').click();
  await page.waitForFunction(()=>window.audios[0].paused);
  const active=await page.locator('[data-choir-mixer] [aria-current="true"]').getAttribute('data-speaker');assert.equal(active,'Narrator');
  const gain=await page.evaluate(()=>window.gains[0].gain.value);assert.ok(gain>2 && gain<3);
  await page.locator('[aria-label="Narrator mute"]').click();assert.equal(await page.evaluate(()=>window.gains[0].gain.value),0);
  await page.locator('[aria-label="Narrator mute"]').click();
  const header=page.locator('[data-choir-mixer]').locator('div').first();const bounds=await header.boundingBox();
  await page.mouse.move(bounds.x+30,bounds.y+10);await page.mouse.down();await page.mouse.move(470,130);await page.mouse.up();
  if(process.env.CHOIR_SCREENSHOT)await page.screenshot({path:process.env.CHOIR_SCREENSHOT,fullPage:true});
  await page.locator('[data-et="pause"]').click();await page.waitForFunction(()=>document.querySelector('[data-et="status"]').textContent.includes('Playback finished'));
  const measured=await page.evaluate(()=>window.gains.map(g=>g.gain.value));assert.ok(measured[1]>0.4 && measured[1]<0.5);assert.ok(measured[2]>2 && measured[2]<3);
  const before=await page.evaluate(()=>window.calls.length);await page.locator('[data-et="play"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-et="status"]').textContent.includes('Playback finished'));
  assert.equal(await page.evaluate(()=>window.calls.length),before);
  await page.locator('[data-et="play"]').click();await page.waitForFunction(()=>!document.querySelector('[data-et="pause"]').disabled);
  await page.locator('[data-et="pause"]').click();
  const mixer=page.locator('[data-choir-mixer]'),seek=mixer.getByRole('slider',{name:'Seek in current spoken block',exact:true});
  await seek.press('Home');for(let step=0;step<4;step++)await seek.press('ArrowRight');assert.ok(Math.abs(await page.evaluate(()=>window.audios.at(-1).currentTime)-0.4)<0.02);
  const oldAudioCount=await page.evaluate(()=>window.audios.length);await mixer.getByRole('button',{name:'Next spoken block',exact:true}).click();
  await page.waitForFunction(count=>window.audios.length===count+1 && document.querySelector('[data-et="pause"]').textContent==='Resume',oldAudioCount);
  assert.equal(await page.evaluate(()=>window.audios.at(-1).paused),true);assert.equal(await mixer.locator('[aria-current="true"]').getAttribute('data-speaker'),'Mira');
  await mixer.getByRole('button',{name:'Previous spoken block',exact:true}).click();
  await page.waitForFunction(count=>window.audios.length===count+2 && document.querySelector('[data-et="pause"]').textContent==='Resume',oldAudioCount);
  assert.equal(await mixer.locator('[aria-current="true"]').getAttribute('data-speaker'),'Narrator');assert.equal(await page.evaluate(()=>window.calls.length),before);
  if(process.env.CHOIR_SCREENSHOT)await page.screenshot({path:process.env.CHOIR_SCREENSHOT,fullPage:true});
  await page.evaluate(()=>window.cleanup());assert.equal(await page.locator('[data-choir-mixer]').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS: Chrome Web Audio loudness, compact cast editors, circular previous/next, paused navigation, seeking, mixer, drag, cached replay, teardown.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
