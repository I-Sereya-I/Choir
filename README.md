<div align="center">

<img src="assets/logo.svg" alt="Choir icon" width="96" />

# Choir

[![Version](https://img.shields.io/badge/version-1.1.5--staging.2-blue.svg)](https://github.com/patatasbravasch-arch/Choir/tree/staging)
[![Platform](https://img.shields.io/badge/platform-Lumiverse%20Spindle-purple.svg)](https://docs.lumiverse.chat/)
[![Tests](https://img.shields.io/badge/tests-159%20passing-brightgreen.svg)](tests/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

An installable Lumiverse Spindle extension for multi-voice narration, dialogue attribution, and sound effects.

</div>

This is the **staging branch of the original Choir repository**, using the original `choir` identifier and settings. Version **1.1.5-staging.2** contains local-only heuristic planning, drawer Stop, optional Auto-plan controls, and provider-aware speech chunk sizes. Disable the separate Choir Staging test copy if you previously installed it, then use this repository's **staging** branch.


## Overview

Choir separates narration and character dialogue from chat messages, assigns distinct voices to each speaker, and plays the story with synchronized audio. It runs inside Lumiverse staging, caches speech passages in IndexedDB, and exposes a floating voice mixer.

## Key features

- **Multi-voice casting.** Cast distinct voices for the Narrator, player persona, and any number of characters or NPCs. Choose voices manually or let the planner cast them automatically.
- **Dual connection modes.** Use one TTS connection across the whole cast, or assign different providers to individual characters.
- **Choice of attribution engine.** Heuristic mode classifies narration and clear dialogue locally, without LLM requests. Ambiguous dialogue stops with guidance to choose Jev or LLM. Jev uses your Decision connection; LLM fallback requires the explicit opt-in. Standard LLM mode uses your selected planner connection.
- **Foley sound effects.** Automatic text scanning detects physical actions such as footsteps, opening doors, knocks, page turns, and impacts, pulling matching audio clips from Freesound with automatic pre-fetching and volume balancing.
- **Narrator muting.** Toggle narrator speech off to hear dialogue only, or leave it on for a full audiobook experience.
- **Companion extension bridge.** Exposes `window.__CHOIR_API__` so reading interfaces like Cue Living Novel can request speech turn planning and seamless paragraph playback.
- **Floating voice mixer.** A draggable sound icon expands into a transport with master and individual speaker volume controls, mute toggles, seeking, and skip buttons.
- **Passage caching.** Completed audio chunks cache immediately in local IndexedDB. Edits and reloads reuse matching attribution and audio without repurchasing tokens or quota.

### Mixer and saved settings

Click the small draggable speaker icon to open the compact player. Previous and Next move between spoken blocks; the playback bar seeks within the current audio part. **Silent** mutes playback. **No voice** skips that character's playback and new synthesis while retaining text and cached audio.

Cast and connection changes save automatically with Saving / Saved / Save failed feedback. A **Retry save** button appears only after saving fails; normal edits need no Save button. Each chat retains its cast; new chats inherit connection, planner and playback preferences. Gemini and Jev API keys remain session-only. Saved plans and completed audio survive navigation and provider failures.

The mixer's **Auto-plan On / Off** switch opts into planning new assistant replies without starting speech. **Show Auto-plan in chat toolbar** in the drawer adds a synchronized toolbar control. The setting is off by default, saves automatically, and uses your chosen planner engine; Jev and LLM planning may incur costs. **Auto-play new replies** remains a separate setting and still plans and plays replies when enabled.

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

### Foley sound effects

1. Check **Sound effects (Foley cues)** in Speech & Planner.
2. In Advanced Settings, add your Freesound API key.
3. When dialogue or narration describes footsteps, doors, paper rustles, or impacts, Choir pulls and caches matching clips, playing them at balanced background levels.

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
  playParagraph(options: PlayParagraphOptions): Promise<{ played: number }>;
}
```

Companion interfaces listen for the `choir-available-v1` event on `window` to bind controls.

## Development

Install dependencies and run test suites:

```bash
npm ci
npm test
npm run test:ui
```

If the environment prevents spawning test workers, use `node --test --test-isolation=none --test-concurrency=1 tests/*.test.mjs tests/*.browser.mjs` after building.

`npm test` validates core parsing, Jev integration, Foley cue detection, and cast validation. `npm run test:ui` executes browser-environment DOM, mixer, and companion bridge integration tests.
