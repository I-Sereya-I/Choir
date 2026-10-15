import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pocketVoiceNotes, pocketVoiceReading } from '../src/pocket-voice.js';
import { transcriptFromMessage } from '../src/core.js';

const anchor=id=>`<div class="pocket-inline-anchor" data-pocket-inline-anchor="${id}"></div>`;
const scope={chatId:'chat-a',characterId:'mira',messageId:'message-a'};
const activity=(id,presentation)=>({id,scope:{chatId:'chat-a',characterId:'mira'},source:{messageId:'message-a'},presentation});

test('Pocket reading preserves transcript characters and anchor order without speaking UI labels or ordinary texts',()=>{
  const notes={act_a:[{speaker:'Mira',text:'Meet at [eight]. <Keep this exact> *please*.'}],act_b:[],act_c:[{speaker:'Guard',text:'The gate is open.'}]};
  const reading=pocketVoiceReading(`Before. ${anchor('act_a')} Between. ${anchor('act_b')} ${anchor('act_c')} After.`,id=>notes[id],transcriptFromMessage);
  assert.deepEqual(reading.parts.map(part=>[part.speaker || 'prose',part.text]),[
    ['prose','Before.'],['Mira',notes.act_a[0].text],['prose','Between.'],['Guard','The gate is open.'],['prose','After.']]);
  assert.equal(reading.notes.length,2);assert.deepEqual(reading.unresolved,[]);
  assert.ok(!reading.transcript.includes('CHOIRPOCKETVOICE'));
});

test('Pocket notes follow ignored tags, comments and code blocks, and duplicate anchors do not duplicate speech',()=>{
  const voice=[{speaker:'Mira',text:'An audible note.'}],resolve=()=>voice;
  const content=`Before. <private-note>${anchor('act_a')}</private-note> <!-- ${anchor('act_b')} -->\n\`\`\`html\n${anchor('act_c')}\n\`\`\`\n${anchor('act_d')} ${anchor('act_d')} After.`;
  const reading=pocketVoiceReading(content,resolve,text=>transcriptFromMessage(text,'private-note'));
  assert.deepEqual(reading.notes.map(note=>note.activityId),['act_d']);
  assert.equal(reading.transcript.split('An audible note.').length,2);
  assert.equal(pocketVoiceReading(anchor('act_a'),resolve,text=>transcriptFromMessage(text,'.pocket-inline-anchor')).transcript,'');
});

test('Pocket reports unresolved or incomplete notes and signatures change with sender or transcript',()=>{
  const content=anchor('act_a');
  for(const value of [null,[{speaker:'Mira'}],[{speaker:'',text:'Hello.'}]])assert.deepEqual(pocketVoiceReading(content,()=>value,transcriptFromMessage).unresolved,['act_a']);
  const read=(speaker,text)=>pocketVoiceReading(content,()=>[{speaker,text}],transcriptFromMessage);
  assert.notEqual(read('Mira','Hello.').signature,read('Guard','Hello.').signature);
  assert.notEqual(read('Mira','Hello.').signature,read('Mira','Goodbye.').signature);
});

test('an excluded copy of an anchor cannot hide its visible note and similar class names are not Pocket anchors',()=>{
  const voice=[{speaker:'Mira',text:'Meet at eight.'}];
  const reading=pocketVoiceReading(`<!-- ${anchor('act_a')} --> <private-note>${anchor('act_a')}</private-note> ${anchor('act_a')}`,()=>voice,text=>transcriptFromMessage(text,'private-note'));
  assert.equal(reading.notes.length,1);assert.equal(reading.transcript,'Meet at eight.');
  const fake=anchor('act_b').replace('class="pocket-inline-anchor"','class="fake-pocket-inline-anchor-extra"');
  assert.equal(pocketVoiceReading(fake,()=>assert.fail('This is not a Pocket anchor'),transcriptFromMessage).notes.length,0);
});

test('Pocket sequence snapshots resolve collapsed followers and mixed group voices in the active chat and swipe',()=>{
  const {window}=new JSDOM('<body><div data-pocket-sequence></div></body>');
  try {
    const host=window.document.querySelector('div');
    host.dataset.pocketSequence=JSON.stringify([
      [activity('act_a',{format:'voice',senderName:'Mira',voiceTranscript:'First note.'}),{}],
      [activity('act_b',{batchMessages:[{senderName:'Guard',format:'voice',text:'Second note.'},{senderName:'Mira',text:'Ordinary text.'}]}),{}]
    ]);
    assert.deepEqual(pocketVoiceNotes(window.document,'act_a',scope),[{speaker:'Mira',text:'First note.'}]);
    assert.deepEqual(pocketVoiceNotes(window.document,'act_b',scope),[{speaker:'Guard',text:'Second note.'}]);
    assert.equal(pocketVoiceNotes(window.document,'act_a',{...scope,chatId:'other'}),null);
    assert.equal(pocketVoiceNotes(window.document,'act_a',{...scope,messageId:'other-swipe-message'}),null);
    host.dataset.pocketInlineAnchor='act_a';host.dataset.pocketMounted='true';
    host.innerHTML='<div class="lp-voice-message"><button class="lp-voice-play" data-voice-sender="Mira"></button><details class="lp-voice-transcript"><p>Stale text.</p></details></div>';
    assert.equal(pocketVoiceNotes(window.document,'act_a',{...scope,chatId:'other'}),null);
  } finally { window.close(); }
});

test('older rendered Pocket voice cards resolve through shadow roots without clicking a button',()=>{
  const {window}=new JSDOM(`<body><div data-pocket-inline-anchor="act_a" data-pocket-mounted="true"><pocket-inline-ui></pocket-inline-ui></div></body>`);
  try {
    const root=window.document.querySelector('pocket-inline-ui').attachShadow({mode:'open'});
    root.innerHTML='<div class="lp-voice-message"><button class="lp-voice-play" data-voice-sender="Mira">Play</button><details class="lp-voice-transcript"><summary>Transcript</summary><p>Meet at eight.</p></details></div>';
    root.querySelector('button').onclick=()=>assert.fail('Reading must not start Pocket playback');
    assert.deepEqual(pocketVoiceNotes(window.document,'act_a',scope),[{speaker:'Mira',text:'Meet at eight.'}]);
    root.querySelector('button').disabled=true;
    assert.deepEqual(pocketVoiceNotes(window.document,'act_a',scope),[]);
  } finally { window.close(); }
});
