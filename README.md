<div align="center">

<img src="assets/logo.svg" alt="Choir icon" width="96" />

# Choir

[![Version](https://img.shields.io/badge/version-1.1.5--staging.11-blue.svg)](https://github.com/patatasbravasch-arch/Choir/tree/staging)
[![Platform](https://img.shields.io/badge/platform-Lumiverse%20Spindle-purple.svg)](https://docs.lumiverse.chat/)
[![Tests](https://img.shields.io/badge/tests-205%20passing-brightgreen.svg)](tests/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

An installable Lumiverse Spindle extension for multi-voice narration, dialogue attribution, sound effects and ambience.

</div>

This is the **staging branch of the original Choir repository**, using the original `choir` identifier and settings. Version **1.1.5-staging.11** adds a captured **Default setup** as a stable basis for new chats, including lead voice choices that remain editable per chat. It retains **Paste voice ID** for Fish Audio, Auto-plan completion recovery, the compact **Plan latest** control beside Previous, latest-reply playback, **SFX On / Off** beside the automation toggles, and mixer channels for voices in the current plan or playback. Disable the separate Choir Staging test copy if you previously installed it, then use this repository's **staging** branch.


## Overview

Choir separates narration and character dialogue from chat messages, assigns distinct voices to each speaker, and plays the story with synchronized audio. It runs inside Lumiverse staging, caches speech passages in IndexedDB, and exposes a floating voice mixer.

## Key features

- **Multi-voice casting.** Cast distinct voices for the Narrator, player persona, and any number of characters or NPCs. Choose voices manually or let the planner cast them automatically.
- **Dual connection modes.** Use one TTS connection across the whole cast, or assign different providers to individual characters.
- **Choice of attribution engine.** Heuristic mode classifies narration and clear dialogue locally, without LLM requests. Ambiguous dialogue stops with guidance to choose Jev or LLM. Jev uses your Decision connection, or a saved Jev API key through TypeSafe's Decision API (`https://api.typesafe.ai/v1/systemone`, model `jev-latest`); saved endpoints ending in `/v1/classify` use that API too. LLM fallback requires the explicit opt-in. Standard LLM mode uses your selected planner connection.
- **Foley sound effects.** Your planner LLM picks the moments that should be audible and writes an English Freesound search for each, in any story language. Choir plays the matching clips right before those words, with pre-fetching and volume balancing. Quiet looping ambience beds such as rain, a tavern crowd or wind play under the narration of sustained scenes.
- **Narrator controls.** Use the mixer's Narrator **Silent** button to mute audio or **No voice** to skip narration and synthesis. Cue's narrator controls remain supported.
- **Companion extension bridge.** Exposes `window.__CHOIR_API__` so reading interfaces like Cue Living Novel can request speech turn planning and seamless paragraph playback.
- **Floating voice mixer.** A draggable sound icon expands into a transport with master and individual speaker volume controls, mute toggles, seeking, and skip buttons.
- **Passage caching.** Completed audio chunks cache immediately in local IndexedDB. Edits and reloads reuse matching attribution and audio without repurchasing tokens or quota.

### Mixer and saved settings

Click the small draggable speaker icon to open the compact player. The small **Plan latest** icon beside Previous plans the latest assistant reply without starting audio. The central **Play** button plays the latest reply, planning it first when needed, and pauses or resumes active playback. Previous and Next move between spoken blocks; the playback bar seeks within the current audio part. **Voices in this reply** shows only speakers used in the current plan, saved recording, or Cue paragraph. Hidden speakers retain their saved levels, and speakers with **No voice** remain listed so you can turn them back on. **Silent** mutes playback. **No voice** skips that character's playback and new synthesis while retaining text and cached audio.

The **SFX On / Off** button beside Auto-plan and Auto-play stays synchronized with **Sound effects (Foley cues)** in the drawer and saves automatically. Turning it off skips effects in Choir and Cue, including cached playback, while speech continues. SFX has no channel row; effects follow the master level at 45% of speech volume. Old SFX channel volume and mute preferences no longer override the switch.

The **Ambience** slider below Master sets the level of background beds, which play at 25% of speech volume at full slider. It applies immediately in Choir and Cue, including cached playback, and saves with the mixer. To stop fetching and playing beds entirely, turn off **Ambient sound** in the drawer.

Cast and connection changes save automatically with Saving / Saved / Save failed feedback. A **Retry save** button appears only after saving fails; normal edits need no Save button. Each chat retains its cast and settings. Gemini and Jev API keys remain session-only. Saved plans and completed audio survive navigation and provider failures.

Open **Default setup** below Speech & Planner and click **Capture as default** after configuring your preferred setup. Chats without saved settings start from that snapshot: connections, planner, playback and automation options, SFX, advanced settings, and the Narrator, Persona and Character voice choices. Lead voices follow those roles while names come from the new chat's active persona and `{{char}}`; NPCs, aliases and pronunciation instructions stay specific to each chat. Leave a lead voice on **Let LLM choose voice** before capturing to have the planner choose it independently for each chat. Later chat edits do not change the captured default; click **Capture as default** again to replace it. Existing chats keep their saved settings, with **Apply default to this chat** available to restore the captured preferences and lead voices while retaining their names and cast. Before the first capture, new chats continue inheriting your latest general preferences.

In **Standard LLM** mode, **Let LLM choose** sends the active character's description and personality, the active persona's description, and available voice descriptions to your selected planner. It chooses a voice that fits each speaker and saves that choice for later replies and reloads. NPCs use character cues from the story. To request a new choice, select **Let LLM choose** again, then plan or play a message where that character speaks. Cached attribution cannot substitute the first catalogue voice for this choice. Existing voice assignments stay fixed until you change them.

The mixer's **Auto-plan On / Off** switch opts into planning new assistant replies without starting speech. **Show Auto-plan in chat toolbar** in the drawer adds a synchronized toolbar control. The setting is off by default, saves automatically, and uses your chosen planner engine; Jev and LLM planning may incur costs. The mixer's **Auto-play On / Off** button stays synchronized with **Auto-play new replies** in the drawer, saves automatically, and plans and plays replies when enabled. Auto-plan and Auto-play can be toggled independently.

Automatic replies wait for the completed message or regenerated swipe to appear in the chat. Replies received while planning, playing, or using Cue queue until Choir is available. Duplicate completion events do not replay a generation. **Stop**, turning both automation switches off, changing chats, or disabling Choir cancels waiting replies. Edited, swiped, or deleted messages discard their pending automation. The removed **Mute narrator (dialogue only)** drawer setting is represented by Narrator **No voice** in the mixer if previously enabled, so you can turn narration back on there.

The drawer's **Stop** button cancels planning, speech generation, and playback, including paused audio, while keeping completed cached passages. Saved-settings feedback sits above the aligned action buttons. **Test planner** follows the selected engine: heuristic tests run locally; Jev and LLM tests use their selected connections. Heuristic mode still uses your TTS provider when you play speech.

Advanced **Max characters per request** accepts a whole number from **80 to 10000**, default **1800**. Larger chunks reduce request count but can delay initial playback. Invalid edits are shown and are not saved. The limit applies to individual speech requests, so longer replies are split automatically.

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

For a Fish Audio speaker, open its cast editor and click **Paste voice ID** beside the voice selector. Paste the ID, optionally describe its timbre, age, accent or delivery, then click **Use this voice**. Choir saves and selects it without generating speech. Use the small preview button to audition it through that speaker's Fish connection. Opening the ID editor also shows the currently selected ID. The Advanced Settings catalogue remains available for bulk entries in `ID | description` format. A valid ID does not resolve provider or gateway failures by itself.

### Foley sound effects

1. Check **Sound effects (Foley cues)** and/or **Ambient sound** in Speech & Planner.
2. In Advanced Settings, add your Freesound API key.
3. After attribution, Choir makes one small request to your Planner LLM connection, in every planner mode. The model picks concrete sounds that happen in the scene, such as doors, footsteps, weather, fire or weapons, and anchors each to the words where it happens. It skips voices, music and imagined sounds. Each search is 1 to 3 English words naming the sound the way Freesound files are named, such as `door slam` or `egg crack`; when a search finds nothing, Choir retries without its last word. Choir then searches Freesound and plays the clips at balanced background levels.

Freesound ranks results by their words, so its top result can be the wrong sound, such as a bottle smashing when a character only picks one up. Choir therefore shows a Decision model the top eight results, with their names, tags and lengths, and the story text around the anchor, and plays the clip it picks. Choir uses your Lumiverse Decision connection, the one selected for Jev or the default, in every planner mode. On hosts without Decision connections, it uses a saved Jev API key. Without either, or when the choice fails or takes longer than 5 seconds, Choir plays Freesound's top result. A chosen clip is cached by its search, so later cues with the same search reuse it.

The same request also picks up to three ambience entries for sustained environments. A bed starts right before its anchor words and loops quietly under the speech until the next bed, an explicit stop, or the end of the message, crossfading over about 1.5 seconds. Beds use Freesound sounds of 10 to 120 seconds, never delay speech while they download, pause with the speech, and follow Next, Previous and resume to the bed in effect at the new position.

No sound request is made while both effects and ambience are off or no Freesound key is set; with only one enabled, the request still runs and only that kind plays. The choices are saved with the plan, so replays and reloads reuse them. Plans made before effects were enabled get their effects chosen once, on the next play; passages that gain an effect are synthesized again.

Effects and beds play in both Choir's chat player and companion paragraph playback. Cue requests a paragraph through Choir's bridge; Choir chooses the sounds once per paragraph, searches Freesound, and plays the preview audio. In Cue, a bed keeps running across consecutive paragraphs of the same chat until another bed, a stop, Stop or cancellation. Turning off **Sound effects (Foley cues)** or **Ambient sound** disables that kind in both players, including saved replays. Muting the narrator keeps effects available.

A valid Freesound API key is required for uncached effects and beds. Missing keys, failed searches, and unavailable or invalid previews show **SFX skipped** in Choir while speech continues. Failed sounds are not cached as silence; retry playback after correcting the key or service problem. Freesound searches use its [current search API](https://freesound.org/docs/api/resources_apiv2.html) and token authentication. Completed chat audio, including effects and beds, survives reloads under your selected retention policy.

## Companion bridge

Choir mounts a global API on `window.__CHOIR_API__` for companion overlays:

```typescript
interface ChoirBridge {
  version: 1;
  isAvailable(): boolean;
  getConfig(): ChoirConfig;
  isNarratorMuted(): boolean;
  setNarratorMuted(muted: boolean): void;
  openDrawer(): void;
  stop(): void;
  planParagraph(text: string, speaker?: string): { segments: SpeechBatch[] };
  playParagraph(options: PlayParagraphOptions): Promise<{ played: number; warnings?: string[] }>;
}
```

Companion interfaces listen for the `choir-available-v1` event on `window` to bind controls.

Paragraph plans may contain `kind: 'sfx'` audio parts when effects are enabled and `kind: 'ambience'` markers where a bed starts or stops. `playParagraph` handles those parts internally, retains speech when an effect or bed fails, and reports optional SFX warnings alongside the actual number of played audio parts; ambience markers are not counted. The bridge remains version 1.

## Development

Install dependencies and run test suites:

```bash
npm ci
npm test
npm run test:ui
```

If the environment prevents spawning test workers, use `node --test --test-isolation=none --test-concurrency=1 tests/*.test.mjs tests/*.browser.mjs` after building.

`npm test` validates core parsing, Jev integration, sound effect and ambience cue validation, and cast validation. `npm run test:ui` executes browser-environment DOM, mixer, and companion bridge integration tests.
