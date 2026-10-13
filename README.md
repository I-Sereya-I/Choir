<div align="center">

<img src="assets/logo.svg" alt="Choir icon" width="96" />

# Choir

[![Version](https://img.shields.io/badge/version-1.1.5--staging.29-blue.svg)](https://github.com/patatasbravasch-arch/Choir/tree/staging)
[![Platform](https://img.shields.io/badge/platform-Lumiverse%20Spindle-purple.svg)](https://docs.lumiverse.chat/)
[![Tests](https://img.shields.io/badge/tests-267%20passing-brightgreen.svg)](tests/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

An installable Lumiverse Spindle extension for multi-voice narration, dialogue attribution, sound effects, ambience and background music.

</div>

This is the **staging branch of the original Choir repository**, using the original `choir` identifier and settings. Version **1.1.5-staging.29** groups mixer channels into **Main cast**, **NPCs** and **Scene audio**. Compact **Auto-plan**, **Auto-play**, **SFX**, **Ambience** and **Music** switches use green for on and gray for off. Scene audio keeps all three volume controls available, including when their sound is off. Desktop has larger sliders with editable percentages and a double-click reset to 100%. Phones have full-width percentage and step controls, with responsive sizing and scrolling for short screens. This release retains background music, Fish community casting, Jev speaker profiles, saved chat defaults and the playback and cache fixes described below.


## Overview

Choir separates narration and character dialogue from chat messages, assigns distinct voices to each speaker, and plays the story with synchronized audio. It runs inside Lumiverse staging, caches speech passages in IndexedDB, and exposes a floating voice mixer.

## Key features

- **Multi-voice casting.** Cast distinct voices for the Narrator, player persona, and any number of characters or NPCs. Choose voices manually or let the planner cast them automatically.
- **Dual connection modes.** Use one TTS connection across the whole cast, or assign different providers to individual characters.
- **Choice of attribution engine.** Heuristic mode classifies narration and clear dialogue locally, without LLM requests. Ambiguous dialogue stops with guidance to choose Jev or LLM. Jev uses your Decision connection, or a saved Jev API key through TypeSafe's Decision API (`https://api.typesafe.ai/v1/systemone`, model `jev-latest`); saved endpoints ending in `/v1/classify` use that API too. LLM fallback requires the explicit opt-in. Standard LLM mode uses your selected planner connection.
- **Foley sound effects.** Your planner LLM picks the moments that should be audible and writes an English Freesound search for each, in any story language. Choir plays the matching clips right before those words, with pre-fetching and volume balancing. Quiet looping ambience beds such as rain, a tavern crowd or wind play under the narration of sustained scenes.
- **Narrator controls.** Use the mixer's Narrator **Silent** button to mute audio or **No voice** to skip narration and synthesis. Cue's narrator controls remain supported.
- **Companion extension bridge.** Exposes `window.__CHOIR_API__` so reading interfaces like Cue Living Novel can request speech turn planning and seamless paragraph playback.
- **Floating voice mixer.** A draggable sound icon expands into a transport with master and individual speaker volume controls, mute toggles, seeking, and skip buttons. The drawer’s **Open mixer / Close mixer** button opens and collapses the same panel, staying in sync with its floating control.
- **Passage caching.** Completed audio chunks cache immediately in local IndexedDB. Edits and reloads reuse matching attribution and audio without repurchasing tokens or quota.

### Mixer and saved settings

Click the small draggable speaker icon to open the compact player. The small **Plan latest** icon beside Previous plans the latest assistant reply without starting audio. The central **Play** button plays the latest reply, planning it first when needed, and pauses or resumes active playback. Previous and Next move between spoken blocks; the playback bar seeks within the current audio part. Master stays visible above the compact **Auto-plan**, **Auto-play**, **SFX**, **Ambience** and **Music** switches. Their labels stay fixed; green means on and muted gray means off. Each switch also exposes its state to screen readers and in its tooltip. **Auto-play new replies** starts speech when a new assistant reply finishes; **Plan latest** prepares a plan, then **Play** starts it. Expand **Channel levels** for three tabs: **Main cast** for the current lead voices, **NPCs** for supporting voices, and **Scene audio** for **SFX**, **Ambience** and **Music**. Speakers come from the current plan, saved recording or Cue paragraph. Scene audio keeps all three volume controls available even when their sound is off, so you can set levels before enabling playback. The menu starts collapsed and remembers whether you leave it open. The tabs work on desktop and mobile and remember your selected group through playback and reload. Empty cast groups show a short message. Arrow keys, Home and End also change tabs. On desktop, use the larger volume slider or type an exact percentage beside it. Double-click a volume slider to reset it to **100%**. On phones and touch devices, use full-width **− / +** controls for 5% steps or enter an exact **0–300%** channel value (**0–100%** for Master). Mute and skip sit beside each speaker name. The mixer fits the screen, and long channel groups scroll below their tabs. All volume controls stay synchronized and save automatically. Hidden speakers retain their saved levels, and speakers with **No voice** remain listed so you can turn them back on. The **speaker** icon controls **Silent** (mute playback), and the **microphone** icon controls **No voice** (skip synthesis and playback). Active buttons change icon and highlight; each has an accessible label, a tooltip and a short legend. **No voice** skips that character's playback and new synthesis while retaining text and cached audio.

The compact **SFX** button below Auto-plan stays synchronized with **Sound effects (Foley cues)** in the drawer and saves automatically. Turning it off skips effects in Choir and Cue, including cached playback, while speech continues, and retains its level in Scene audio. When enabled, the SFX level in **Channel levels** ranges from **0–300%**, default **100%**, and saves with the mixer. At 100%, effects retain the existing quiet 45% gain; 300% triples that level. Speaker levels also range from **0–300%**. Speech and SFX amplification works with **Match passage loudness** on or off. Old SFX voice-channel volume and mute preferences no longer override the switch.

The compact **Ambience** button beside SFX stays synchronized with **Ambient sound** in the drawer and saves automatically. On keeps background beds looping across Cue paragraphs until a replacement, a stop cue or Stop. Off stops active and loading beds without interrupting speech, prevents later beds from starting, and retains its level in Scene audio. The **Ambience** level in **Channel levels** ranges from **0–300%**, with **100%** as the default background level. Raise it above 100% when a clip is too quiet; 300% gives three times the previous maximum volume. Changes apply immediately in Choir and Cue, including cached playback, and save with the mixer.

**Background music** in the drawer, beside **Ambient sound**, is off by default. On, the planner LLM also picks the mood of the scene: one to three incompetech feels, one or two genres and a few English keywords such as instruments or the setting. The backend loads Kevin MacLeod's [incompetech](https://incompetech.com/music/royalty-free/) catalog once, ranks its tracks and lets your Decision model choose among the top eight, as it does for Freesound; a slow or failed choice keeps the best-ranked track. The track streams directly from incompetech and loops quietly under the speech on its own layer, crossfading, pausing and stopping like ambience, also in Cue and cached replay. Music needs no Freesound key. Its **Music** level is always available beside SFX and Ambience in **Scene audio** with the same **0–300%** range. While a track plays, the drawer shows its credit: `"Title" Kevin MacLeod (incompetech.com) · CC BY 4.0`. The music is licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Plans made before turning music on have no music; plan the reply again to add it.

Cast and connection changes save automatically with Saving / Saved / Save failed feedback. A **Retry save** button appears only after saving fails; normal edits need no Save button. Each chat retains its cast and settings. Gemini and Jev API keys remain session-only. Saved plans and completed audio survive navigation and provider failures. Connection defaults such as speed and output format are included in the audio cache identity; changing them regenerates only affected speech without asking the planner again. Companion paragraph playback applies the same pronunciation, accent, style and voice fallback settings as the main player. Stop also cancels its pending sound-effect choices.

Click **Set default** below Speech & Planner to open the defaults popup. Its three tabs cover Speech & Planner (including advanced preferences), lead cast defaults for **Narrator**, **`{{user}}`** and **`{{char}}`**, and **NPC cast**. Each lead role has its own TTS connection and voice, including **Let the LLM decide**. NPCs can **Do not generate NPC speech**, **Use one voice for everyone**, **Choose from preferred voices**, or **Let the LLM decide**. The preferred pool limits automatic NPC choices without restricting the lead cast. **Save default** changes the basis for chats without saved settings; every chat saves its own later edits. Existing chats keep their settings unless you click **Apply default to this chat**. Names come from each chat’s active persona and character; names, aliases, pronunciation instructions and individual NPC identities are not copied into the default. Reopen the popup to edit the saved default, or choose **Use current chat settings** to start from the active chat. Cancel discards the draft. NPC casting is also editable per chat under **NPC voice settings**. Gemini and Jev session keys are never captured. Your existing captured default remains compatible.

In **Standard LLM** mode, **Let LLM choose** sends the active character's description and personality, the active persona's description, and available voice descriptions to your selected planner. It chooses a voice that fits each speaker and saves that choice for later replies and reloads. NPCs use character cues from the story. To request a new choice, select **Let LLM choose** again, then plan or play a message where that character speaks. Cached attribution cannot substitute the first catalogue voice for this choice. Existing voice assignments stay fixed until you change them.

Added Fish Audio and Gemini voice IDs are kept on the connection where you added them, including after reloads and provider switches. Existing additional voices are matched to their known provider or saved assignment. Voices without gender metadata remain available under gender filters and are labelled **Gender unknown**; the planner can use their descriptions. GPT TTS uses the host's built-in catalogue, with a local built-in list as a fallback. If an older plan saved a voice from the wrong provider, select **Let LLM choose** again and plan the message to replace that assignment.

The mixer's **Auto-plan** switch opts into planning new assistant replies without starting speech. **Show Auto-plan in chat toolbar** in the drawer adds a synchronized toolbar control. The setting is off by default, saves automatically, and uses your chosen planner engine; Jev and LLM planning may incur costs. The mixer's **Auto-play** button stays synchronized with **Auto-play new replies** in the drawer, saves automatically, and plans and plays replies when enabled. Auto-plan and Auto-play can be toggled independently.

Automatic replies wait for the completed message or regenerated swipe to appear in the chat. Replies received while planning, playing, or using Cue queue until Choir is available. Duplicate completion events do not replay a generation. **Stop**, turning both automation switches off, changing chats, or disabling Choir cancels waiting replies. Edited, swiped, or deleted messages discard their pending automation. The removed **Mute narrator (dialogue only)** drawer setting is represented by Narrator **No voice** in the mixer if previously enabled, so you can turn narration back on there.

The drawer's **Stop** button cancels planning, speech generation, and playback, including paused audio, while keeping completed cached passages. Saved-settings feedback sits above the aligned action buttons. **Test planner** follows the selected engine: heuristic tests run locally; Jev and LLM tests use their selected connections. Heuristic mode still uses your TTS provider when you play speech.

Advanced **Max characters per request** accepts a whole number from **80 to 10000**, default **1800**. Larger chunks reduce request count but can delay initial playback. If the Lumiverse relay returns HTTP 524, try **1800** characters and **1** concurrent TTS request; smaller requests and less parallel work may help them finish before the relay timeout. A persistent 524 needs investigation on the relay or provider side. Invalid edits are shown and are not saved. The limit applies to individual speech requests, so longer replies are split automatically.

Choir also applies limits per voice route: Fish Audio uses up to the 10,000-character application ceiling, including delivery tags; [OpenAI speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) is capped at 4,096 characters. Gemini uses a conservative local budget of 6,000 UTF-8 bytes for text and delivery instructions, reserving space under its [8,192-token input limit](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts); multilingual text may therefore use shorter chunks. Unknown providers retain the previous 2,000-character cap. These policies also apply to companion paragraph playback.

## Installation

### From GitHub

1. In Lumiverse, open **Extensions -> Add -> Install from source**.
2. Enter `https://github.com/patatasbravasch-arch/Choir` and select the `staging` branch.
3. Enable **Choir** in your extension list.

### Local copy

1. Copy the repository into your Lumiverse data directory under `extensions/choir`:

   ```text
   Lumiverse/
     data/
       extensions/
         choir/
           spindle.json
           dist/
             backend.js
             frontend.js
           src/
   ```

2. Open **Extensions -> Add -> Import local** as an admin or owner.
3. Enable **Choir** and grant permissions if prompted.

The extension includes pre-built bundles in `dist/`. No build step is required to run it.

## Configuration

Open **Choir** from the drawer or its input-bar action.

### Gemini 3.8 TTS

1. Select **Gemini 3.8** under default TTS connection.
2. Choose `gemini-3.8-flash-tts` or `gemini-3.8-flash-lite-tts`.
3. Enter your Gemini API key. The key stays in the current page session and is never written to disk or extension settings.
4. Pick an LLM connection for planning.

### Lumiverse native connections

1. Select **Lumiverse TTS** under default TTS connection.
2. Choose any saved connection on your host, including OpenAI, Fish Audio, ElevenLabs, or local servers.
3. Set the style handling parameter supported by your model, such as `instructions`, `instruct`, or `prompt`.

For a Fish Audio speaker, open its cast editor and click **Paste voice ID** beside the voice selector. Paste the ID, optionally describe its timbre, age, accent or delivery, then click **Use this voice**. Choir saves and selects it without generating speech. Use the small preview button to audition it through that speaker's Fish connection. Opening the ID editor also shows the currently selected ID. The Advanced Settings catalogue remains available for bulk entries in `ID | description` format. A valid ID does not resolve provider or gateway failures by itself. Speech failures identify the selected provider, connection, model and voice, and preserve any JSON, plain-text or HTML error details returned by Lumiverse or its gateway. A bare HTTP 502 does not establish whether the voice or the upstream service caused the failure. Completed speech remains cached; retrying playback generates only the missing passages.

When a Fish Audio speaker is left on **Let LLM choose**, **Voices the planner picks from** decides where its voice comes from. **Fish community library** (the default) has the planner describe the voice it wants — gender, age, up to four tone words and the story's language — and Choir searches the public Fish library for it. It skips duplicates, voices already in the chat's cast and voices also tagged with the opposite gender, and lets the Decision model pick from the top 10 results. If that choice fails or takes more than 5 seconds, Choir uses the top result. The chosen voice is saved to that character, so each character is searched only once, and it appears in the voice list as an additional voice; you can still change it by hand. **My Fish voices** keeps the previous behaviour and uses only your own Fish models. **Both** offers your own voices and the community search. Jev planning asks the Decision model for the speaker's gender, age and story language before searching. Celebrity and character voices are not filtered out.

### Foley sound effects

1. Check **Sound effects (Foley cues)** and/or **Ambient sound** in Speech & Planner.
2. In Advanced Settings, add your Freesound API key.
3. After attribution, Choir makes one small request to your Planner LLM connection, in every planner mode. The model picks concrete sounds that happen in the scene, such as doors, footsteps, weather, fire or weapons, and anchors each to the words where it happens. It skips voices, music and imagined sounds. Each search is 1 to 3 English words naming the sound the way Freesound files are named, such as `door slam` or `egg crack`; when a search finds nothing, Choir retries without its last word. Choir then searches Freesound and plays the clips at balanced background levels.

Freesound ranks results by their words, so its top result can be the wrong sound, such as a bottle smashing when a character only picks one up. Choir therefore shows a Decision model the top eight results, with their names, tags and lengths, and the story text around the anchor, and plays the clip it picks. Choir uses your Lumiverse Decision connection, the one selected for Jev or the default, in every planner mode. On hosts without Decision connections, it uses a saved Jev API key. Without either, or when the choice fails or takes longer than 5 seconds, Choir plays Freesound's top result. A chosen clip is cached by its search, so later cues with the same search reuse it.

The same request also picks up to three ambience entries for sustained environments. A bed starts right before its anchor words and loops quietly under the speech until the next bed, an explicit stop, or the end of the message, crossfading over about 1.5 seconds. Beds use Freesound sounds of 10 to 120 seconds, never delay speech while they download, pause with the speech, and follow Next, Previous and resume to the bed in effect at the new position.

No sound request is made while both effects and ambience are off or no Freesound key is set, unless **Background music** is on; with only one enabled, the request still runs and only that kind plays. The choices are saved with the plan, so replays and reloads reuse them. A malformed or empty sound-choice response gets one correction request with a larger output budget; provider errors and cancellation do not trigger that retry. If choices still fail, speech continues and the warning stays in the status area at the top of the drawer beside playback errors. DeepSeek uses its [JSON output mode](https://api-docs.deepseek.com/guides/json_mode/), including custom connections whose model ID starts with `deepseek` or `deepseek/`. Playback uses the saved choices and never starts a new sound-effect LLM request. To add effects to an older plan, or retry failed choices, select **Plan latest** or the message's **Plan** button. Passages that gain an effect are synthesized again.

Effects and beds play in both Choir's chat player and companion paragraph playback. Cue requests a paragraph through Choir's bridge; Choir chooses the sounds once per paragraph, searches Freesound, and plays the preview audio. In Cue, a bed keeps running across consecutive paragraphs of the same chat until another bed, a stop, Stop or cancellation. Turning off **Sound effects (Foley cues)** or **Ambient sound** disables that kind in both players, including saved replays. Muting the narrator keeps effects available.

A valid Freesound API key is required for uncached effects and beds. Missing keys, failed searches, and unavailable or invalid previews show **SFX skipped** in Choir while speech continues. Browser playback or decode errors for a background bed show **Ambience skipped** in the same status area. Failed layers are released, so later playback can retry, while speech continues. Failed sounds are not cached as silence; retry playback after correcting the key or service problem. Freesound searches use its [current search API](https://freesound.org/docs/api/resources_apiv2.html) and token authentication. Completed chat audio, including effects and beds, survives reloads under your selected retention policy.

## Companion bridge

Choir mounts a global API on `window.__CHOIR_API__` for companion overlays:

```typescript
interface ChoirBridge {
  version: 1;
  isAvailable(): boolean;
  getConfig(): ChoirConfig;
  isNarratorMuted(): boolean;
  setNarratorMuted(muted: boolean): void;
  setSoundEnabled(on: boolean): void;
  getMusic(): { title: string; credit: string } | null;
  openDrawer(): void;
  stop(): void;
  planParagraph(text: string, speaker?: string): { segments: SpeechBatch[] };
  playParagraph(options: PlayParagraphOptions): Promise<{ played: number; warnings?: string[] }>;
}
```

Companion interfaces listen for the `choir-available-v1` event on `window` to bind controls. `setSoundEnabled` turns sound effects, ambience and background music on or off together, like the drawer toggles, and saves the chat setting. `getMusic` returns the playing incompetech track with its CC BY 4.0 credit; `choir-music-v1` fires on `window` with the same value, or `null`, whenever the track changes or stops. In paragraph playback the playing track carries on into later paragraphs; the sound request names it and asks for new music only when the mood or setting clearly changes.

Paragraph plans may contain `kind: 'sfx'` audio parts when effects are enabled and `kind: 'ambience'` or `kind: 'music'` markers where a bed starts or stops. `playParagraph` handles those parts internally, retains speech when an effect or bed fails, and reports optional SFX warnings alongside the actual number of played audio parts; ambience and music markers are not counted. The bridge remains version 1.

## Development

Install dependencies and run test suites:

```bash
npm ci
npm test
npm run test:ui
```

If the environment prevents spawning test workers, use `node --test --test-isolation=none --test-concurrency=1 tests/*.test.mjs tests/*.browser.mjs` after building.

`npm test` validates core parsing, Jev integration, sound effect, ambience and music cue validation, music ranking, and cast validation. `npm run test:ui` executes browser-environment DOM, mixer, and companion bridge integration tests.
