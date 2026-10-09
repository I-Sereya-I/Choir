# Lumivoice for Lumiverse staging

An installable Spindle extension for narrated roleplay with multiple voices.

- You choose the narrator, your persona, and one or more main-character voices.
- A separate LLM pass identifies narration and dialogue, casts NPCs from the available voice catalogue, and suggests delivery styles.
- NPC voices persist per chat and speech provider. Fixed and previously assigned voices override any contradictory model suggestion.
- Gemini 3.8 uses `speech_metadata.style`, separate from the spoken transcript.
- Other speech providers use existing Lumiverse TTS connections and their saved credentials.
- Review the plan, correct the cast, play, pause/resume, stop, or enable automatic playback of completed replies.

## Install from GitHub

In Lumiverse, open **Extensions → Add → Install from source**, paste [https://github.com/patatasbravasch-arch/Lumivoice](https://github.com/patatasbravasch-arch/Lumivoice), and select the `main` branch. Enable **Lumivoice** after installation. For a private repository, your Lumiverse server needs GitHub credentials with repository access.

## Install locally

This archive includes ready-built `dist/backend.js` and `dist/frontend.js`; no compilation is needed to install it. It does not modify Lumiverse itself.

1. Extract the archive. The extension folder is named `lumivoice`.
2. Copy that entire folder into your Lumiverse **configured data directory** under `extensions/lumivoice`. A typical layout is:

   ```text
   Lumiverse/
     data/
       extensions/
         lumivoice/
           spindle.json
           dist/
             backend.js
             frontend.js
           src/
           ...
   ```

   If you use Docker, copy into the mounted data volume. The host folder must correspond to the container's configured data directory.
3. In Lumiverse, open **Extensions**, open its **Add** menu, and choose **Import local** as an owner/admin.
4. Enable **Lumivoice** and grant its requested permissions if Lumiverse prompts you. Reload the frontend if its tab is not yet visible.
5. Open a chat and select **Lumivoice** from the sidebar/command palette or the input-bar action.

Optional Windows copy helper:

```powershell
.\Install.ps1 -LumiverseDataDirectory 'C:\path\to\Lumiverse\data'
```

It copies the extension only if the destination does not exist. You still perform **Import local** in Lumiverse afterward.

The manifest points to the GitHub repository above. Ready-built `dist/` files are committed alongside the source.

## Configure Gemini 3.8 Flash TTS

1. Keep **Playback adapter → Gemini 3.8 · style metadata** selected.
2. Select `gemini-3.8-flash-tts` (the default) or `gemini-3.8-flash-lite-tts`.
3. Enter a Gemini API key with access to the selected TTS model. This key is kept in the page session and sent through Spindle's backend proxy; it is never written to extension settings. Enter it again after a reload.
4. Choose a **Planner LLM connection**, or leave the field at **Default LLM connection**. The planner must support text generation; it is separate from the TTS model.
5. Check the fixed speaker names and choose voices. The active persona and main character names are prefilled on first use where available. You can edit the persona name and add additional main characters. `Narrator` is reserved.
6. Set optional base styles such as “measured storytelling” or “soft French accent.” Leave **Use delivery styles** checked for LLM-generated turn styles.
7. Click **Save cast and settings**, then **Plan latest reply**, inspect the speech plan, and click **Play plan**.

The 30 standard Gemini voices are included. Under advanced options, you can add extended/custom voice IDs using one `ID | description` per line, then click **Reload connections and voices**. Descriptions help the planner choose suitable NPC voices.

## Other speech providers

Choose **Lumiverse TTS connection**, then select a connection you already configured in Lumiverse and assign voices from its catalogue. Its saved model, API URL, credentials and default parameters are used by Lumiverse's authenticated synthesis endpoint. This adapter supports providers that return a voice list and browser-playable audio through that endpoint, including the OpenAI-compatible family.

The **Style handling** selector enables parameters advertised by the provider:

| Provider capability | Setting |
| --- | --- |
| OpenAI `gpt-4o-mini-tts` / compatible supported models | `instructions` |
| Qwen3 server built-in speaker synthesis | `instruct` |
| Provider advertising a style `prompt` parameter | `prompt` |
| Providers without delivery instructions | Ignore style; keep multiple voices |

Provider/model support determines whether these parameters are honored. Gemini style metadata requires the dedicated Gemini adapter; the staging native Gemini provider inspected here does not forward that metadata.

NPC lists are stored independently for Gemini and each native connection. Fixed voice selections are the current chat's settings; reselect appropriate fixed voices when changing provider. If a speaker name conflicts with an existing NPC, remove that NPC row before saving.

## Daily use and corrections

Use **Plan** beside any recent message, or **Plan latest reply**. After a plan is accepted, newly cast NPCs are saved for this chat. Replay the current plan without another LLM call. Correct a speaker/voice in the fixed or NPC cast, save, and replan the message to apply the change.

The optional JSON editor can correct segment boundaries and speaker attribution. Every segment must copy an exact consecutive substring of the cleaned transcript. The validator rejects invented, rewritten or omitted prose. Existing cast assignments still take priority over a JSON voice suggestion. Styles in this editor are turn styles; base cast styles are added automatically.

**Auto-play completed replies** makes a planner call and starts playback after each successful completed assistant generation in the active chat. Disable Lumiverse's native TTS autoplay to prevent overlapping playback. Browser audio restrictions may require a manual **Play plan** click first.

Changing chat, editing/deleting a message, or changing its swipe stops the active playback and invalidates the plan. **Stop** cancels the planner, halts playback and prevents further speech chunks. A Gemini request already sent through Lumiverse's CORS proxy can finish upstream after you stop; its result is discarded, and it may still be billed.

## Limits and troubleshooting

- Playback synthesizes one speaker at a time, in transcript order. This supports an arbitrary cast without relying on Gemini's two-speaker dialogue request format. There can be pauses between requests; audio is not generated as one continuous multi-speaker file.
- Each plan handles up to 30,000 characters and 250 turns. It uses up to 12 recent messages for speaker context. Ambiguous attribution and unnamed NPC identity may need correction.
- The extension strips presentation markup, code blocks, images and closed thinking blocks before planning. Narration remains spoken.
- The default chunk size is 350 characters. Larger chunks reduce request count; smaller chunks help with the staging CORS proxy's **30-second request timeout**. This timeout is host-controlled.
- Planning makes a separate text-model request, with one corrective retry if needed. Playback makes a separate speech request per chunk. Provider quota and billing apply.
- On HTTP 401/403/429 or a timeout, check the key, model access, quota and connection settings. A provider error is shown without silently changing the cast or speaking unvalidated text.
- Use WAV or MP3 when a browser cannot decode your native provider's output. Gemini WAV is preserved; legacy raw PCM responses are wrapped in WAV.
- Advanced **Lumiverse API base** defaults to `/api/v1`. Change it if your frontend reaches Lumiverse at a different API URL; session authentication and the server's CORS settings still apply.
- Cast settings persist per user/chat. Speech plans and audio remain in memory; this version does not attach recordings to messages or cache audio across reloads.

## Validation and development

Built against Lumiverse `staging` commit `069777a6cc7fef9a735dd9a460d6da0ab9c72b0f` and extension API types `0.6.40`. The package passed 14 automated tests, including a DOM integration scenario covering both speech adapters, persistence, a detached drawer, cancellation, message edits and chat switching. Identifier/permission validation and the raw backend capability scanner from that staging source also passed.

**It has not been installed into your running Lumiverse instance or tested with real provider credentials.** Actual synthesis quality, provider availability and live UI integration still need your first-use check.

The runtime has no package dependencies. To rebuild and run core/backend tests:

```text
node scripts/build.mjs
npm test
```

For the optional DOM integration test, install `jsdom@26.1.0` locally without saving it, then run `npm run test:ui`. Node 24 is the tested development runtime. Sandbox environments that disallow child processes can use `node --test --test-isolation=none` with the test paths instead.

Sources: [Lumiverse staging](https://github.com/prolix-oc/Lumiverse/tree/staging), [Spindle developer documentation](https://docs.lumiverse.chat/), [Google Gemini TTS REST documentation](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation).

