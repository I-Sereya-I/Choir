# Choir 1.1.3 for Lumiverse staging

An installable Spindle extension for narrated roleplay with multiple voices.

## What's new in 1.1.3

- Playback controls and the seek bar now live only in the floating mixer. Messages keep their compact Play Choir button and optional section menu. The drawer focuses on cast and connections; speech-plan details and saved-audio history start collapsed. Passage selection, Play selected passages, Resume last position and passage synthesis checkboxes are removed. Play in the mixer automatically resumes the saved position; message Play Choir starts that message.
- Mixer **Silent** mutes playback; audio may still be generated and cached. **No voice** skips the character entirely, including cached playback, without requesting new audio. Text and saved audio remain available, and turning No voice off reuses saved audio. Both controls show checkmarks when enabled. Silent replaces Mute; Solo is removed, and old solo preferences are ignored. Character exclusions are controlled here rather than inside cast editors.
- **One TTS** uses the selected connection for the whole cast and hides per-character connection fields. **Several TTS** shows those fields and restores saved character routes and voices. Switching modes or the shared connection reuses saved attribution. One TTS remembers voice choices separately for each shared connection. New chats default to One TTS; existing chats retain Several TTS until changed. Cast import/export includes these preferences.
- No voice choices persist per chat and can be changed during playback. Already dispatched synthesis can finish and be cached; excluded characters are skipped immediately, and no further requests are started for them. Failed requests for a newly excluded character do not prevent other characters from playing. Paused navigation stays paused.
- Legacy per-passage selection/exclusion controls are retired; character-level No voice now governs exclusions.

## What's new in 1.1.2

- Removed the guided setup. **Test planner** and **Test TTS** remain beside the Speech & Planner settings, and voice previews remain inside each cast editor.
- Lead and NPC cast entries start as compact **Narrator · Edit** rows. Click **Edit** to change voices, routes, aliases, pronunciation, accent, or exclusions; **Done** closes the editor. Adding a character opens its editor immediately. Hidden fields remain saved and do not trigger new attribution.
- Circular **Previous** and **Next** controls move between spoken blocks (narration or a character's turn), including saved recordings. Next skips any remaining chunks of the current block. Previous reuses cached audio. Paused navigation stays paused, and neither control replans the message.
- A draggable playback bar appears in the mixer, the drawer and the active message. It seeks within the audio part currently playing, preserves paused playback, and saves the new resume position. Long blocks can contain several audio parts; seeking does not generate other parts.
- Skipping retains completed audio and avoids starting unrequested remaining chunks. Already prefetched audio remains cached. Provider failures in a skipped chunk do not prevent the next block from playing.

## What's new in 1.1.1

- The floating mixer starts as a draggable **44 px sound icon**. Click it to open the controls, or close it back to the icon. Its position and volume settings persist. Host remounts remove the previous mixer and stop its playback.
- Message playback uses a compact **28 px play icon** with a tooltip. It reuses the current validated plan even when saving that plan failed, then checks saved plans and audio before making another planner request. Repeated clicks during loading cannot launch duplicate planning.
- A planned latest reply displays **latest already planned, click on plan latest to redo it**. Clicking **Plan latest reply** explicitly replans it; existing audio remains reusable when the synthesis inputs are unchanged.
- Enable **Show section play buttons** in Speech & Planner to add a small expandable **Sections** menu to each message and numbered controls above its plan. Each button plays that section's narration and dialogue and synthesizes only missing included audio. The toggle is off by default and persists per chat. Older plans and local/Jev attribution use individual passages as sections.
- Completed LLM planning sections now save immediately. After a planner error, cancellation, or reload, **Play Choir** resumes matching attribution sections and cached audio. Changing message text invalidates saved attribution; explicit **Plan latest reply** redo bypasses it.

## What's new in 1.1.0

- Jev requests send only plain data through `spindle.cors`. `AbortSignal` stays local because Spindle forwards CORS options through worker messaging. Cancellation discards late proxy results; it cannot revoke an already billed upstream request.
- **Allow LLM fallback after Jev fails** is off by default. Select its saved LLM connection explicitly before enabling it. The original Jev error remains visible in the plan and persists with it, including when the fallback succeeds. Missing keys and malformed classifications no longer silently choose another planner or the first candidate.
- Validated attribution is saved per chat/message in extension settings. Returning to a chat or reloading restores the last plan. Saving voice, route, or style changes reuses attribution. Text/swipe edits invalidate attribution; unchanged audio passages remain reusable after the new text is planned.
- Every completed audio passage is cached immediately, including prefetched audio that has not played yet. Provider failure or cancellation retains those passages. Retry generates only missing or changed synthesis inputs. If IndexedDB fails, audio remains available for the page session and Choir reports the persistence failure.
- A floating mixer provides master and individual speaker volume, mute, multiple-speaker solo, current-speaker highlighting, pause/resume, collapse/reopen, and a remembered draggable position. Controls work independently of the settings drawer. Individual passage playback replaces Gemini two-speaker batching so each speaker can be mixed and excluded separately.
- Guided setup has independent planner and short billable TTS tests, automatic persona/character names, and previews beside every voice. The roleplay formatting suggestion is optional; Choir never changes your chat prompt.
- Cast rows support aliases, pronunciation instructions, accent preferences, exclusions, and provider routing. Accent parameters are sent only when advertised by the provider; enum values are validated. Otherwise accents and pronunciation use supported delivery instructions (or Gemini speech metadata). Providers without either capability cannot apply those preferences.
- Select passages in the plan to play a subset. Exclude passages or entire characters to skip synthesis while retaining every original word for later. **Resume last position** resumes the saved passage/chunk and time offset, including after reload; edited text starts fresh.
- The plan shows **Cached**, partial cache counts, or **requires generation**. Default prefetch is one upcoming passage, adjustable from zero to four; concurrency is separately capped at four. TTS requests have no automatic retries. Provider failure stops playback rather than switching providers. Optional Gemini custom-voice fallback is separately enabled and limited to one retry to Kore/Charon. Planner JSON repair has one retry, and slow-section splitting is limited to two splits.
- Web Audio loudness matching measures passage RMS and peak, applies bounded gain, and preserves the original cached audio. Disable it in Advanced Settings if desired. Silent audio is not amplified. Mixer volume and loudness settings never invalidate the audio cache.
- Versioned cast JSON import/export includes aliases, routing, exclusions, accents, and pronunciation, and excludes credentials. Imports validate all provider routes and voice catalogues before saving. Connection IDs are host-specific; configure or remap them on the destination host.
- Message buttons support both `ctx.ui.registerDomDecorator` and the older top-level decorator API, including detached drawers and both message layouts.

Gemini and Jev keys are page-session credentials. Legacy saved Jev keys are removed from settings on first load; that load can still use the key for the current session. Enter it again after reload. Plans persist independently of audio retention; clearing audio does not delete attribution. Audio is device-local IndexedDB data, while plan/cast settings use Lumiverse extension settings.

- Choose narrator/persona/main-character voices yourself, or select **Let LLM choose**. Gemini voice selectors display Male/Female labels and can filter the catalogue by gender. The filter also guides automatic casting; manual voices take priority. Custom/provider voices without metadata are marked Gender unknown. Select Let LLM choose again to apply a changed preference to a previously cast voice.
- Choir separates narration from double-quoted dialogue locally. An LLM assigns character identities, NPC voices and delivery styles to numbered source pieces; Choir reconstructs the original words without model rewrites.
- NPC voices persist per chat and speech provider. Fixed and previously assigned voices override any contradictory model suggestion.
- Gemini 3.8 uses `speech_metadata.style`, separate from the spoken transcript.
- Other speech providers use existing Lumiverse TTS connections and their saved credentials.
- Play directly from the message's small play icon (**Play Choir** tooltip), or review/edit a plan, pause/resume, stop, and enable automatic playback from settings.

## Install from GitHub

In Lumiverse, open **Extensions → Add → Install from source**, paste [https://github.com/patatasbravasch-arch/Choir](https://github.com/patatasbravasch-arch/Choir), and select the `main` branch. Enable **Choir** after installation. For a private repository, your Lumiverse server needs GitHub credentials with repository access.

Open its controls through **Settings → Choir**, or click Choir's **Settings** button in Extensions and then **Open Choir settings**. The Choir/Voices drawer and input-bar shortcut open the same controls.

Already installed? Update Choir to **1.1.3**, restart it, then reload. GitHub updates use the repository and branch selected when installing Choir. Choir pipelines multi-section planning and playback and strips tracker/status/state blocks, details panels, HTML comments, and HUD panels. Nested and unfinished metadata blocks are handled. Older recordings containing removed metadata need regeneration. Existing complete recordings can still replay; new playback uses passage caches.

## Install locally

The repository includes ready-built `dist/backend.js` and `dist/frontend.js`; no compilation is needed to install it. It does not modify Lumiverse itself.

1. Extract the archive. The extension folder is named `choir`.
2. Copy that entire folder into your Lumiverse **configured data directory** under `extensions/choir`. A typical layout is:

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
           ...
   ```

   If you use Docker, copy into the mounted data volume. The host folder must correspond to the container's configured data directory.
3. In Lumiverse, open **Extensions**, open its **Add** menu, and choose **Import local** as an owner/admin.
4. Enable **Choir** and grant its requested permissions if Lumiverse prompts you. Reload the frontend if its tab is not yet visible.
5. Open a chat, then open **Settings → Choir**, or choose **Choir** from the sidebar/command palette or the input-bar action.

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
5. Click **Edit** beside each fixed speaker to choose voices and optional preferences. The active persona and main character names are prefilled on first use where available. You can edit the persona name and add additional main characters. `Narrator` is reserved.
6. Set optional base styles such as “measured storytelling” or “soft French accent.” Leave **Use delivery styles** checked for LLM-generated turn styles.
7. Click **Save cast and settings**, then **Plan latest reply**, inspect the speech plan, and click **Play in the mixer**.

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

Use **Plan** beside any recent message, or **Plan latest reply**. After validation, attribution and newly cast NPCs are saved for this chat. **Plan** and **Play Choir** reuse matching attribution without another planner call; **Plan latest reply** explicitly redoes an already planned latest reply. Change a voice, provider route, or base style in the cast and save to apply it. Correct attribution through the JSON editor; **Apply JSON** validates and persists the correction. The **Replay** action plays the last saved recording; **Play Choir** uses the current plan and cast and generates only missing audio. To play a section, enable **Show section play buttons** and open the message's **Sections** menu.

The optional JSON editor can correct segment boundaries and speaker attribution. Every segment must copy an exact consecutive substring of the cleaned transcript. The validator rejects invented, rewritten or omitted prose. Existing cast assignments still take priority over a JSON voice suggestion. Styles in this editor are turn styles; base cast styles are added automatically.

**Auto-play completed replies** makes a planner call and starts playback after each successful completed assistant generation in the active chat. Disable Lumiverse's native TTS autoplay to prevent overlapping playback. Browser audio restrictions may require a manual **Play in the mixer** click first.

Changing chat stops active playback and restores that chat's last matching plan. Editing/deleting a message or changing its swipe cancels planning and playback for that message and clears current attribution. **Stop** cancels planning and playback and prevents additional chunks. A proxy request already sent upstream can finish after cancellation; its late result is discarded and may still be billed. Already completed audio stays cached.

## Limits and troubleshooting

- Playback synthesizes one speaker at a time, in transcript order. This supports an arbitrary cast without relying on Gemini's two-speaker dialogue request format. There can be pauses between requests; audio is not generated as one continuous multi-speaker file.
- Each plan handles up to 30,000 characters and 250 turns. It uses up to 12 recent messages for speaker context. Ambiguous attribution and unnamed NPC identity may need correction.
- The extension strips presentation markup, code blocks, images and closed thinking blocks before planning. Narration remains spoken.
- The default chunk size is 1,800 characters. Larger chunks reduce request count; smaller chunks help with host/provider timeouts. Set the chunk size in Advanced Settings. Changing chunk boundaries may require new audio.
- New text makes a separate attribution request, with one corrective retry if needed. Slow sections can be split at most twice. Playback makes a speech request only for each uncached included chunk. Provider quota and billing apply.
- Planning uses the selected LLM connection's model and saved credentials, with chat preset parameters excluded and reasoning disabled for this request. Its output budget defaults to 8,192 tokens; the corrective retry can increase it up to 32,768. Under advanced options, set **Planner output budget** to suit your model's supported limit. Empty responses and output cutoffs produce explicit errors. The planner must be a text-generation model, separately from Gemini TTS.
- Before planning, Choir checks that its backend replies within eight seconds. If that fails, update/restart Choir in Extensions and reload the page. Planning errors appear both at the top and next to the playback controls.
- On HTTP 401/403/429 or a timeout, check the key, model access, quota and connection settings. A provider error is shown without silently changing the cast or speaking unvalidated text.
- Use WAV or MP3 when a browser cannot decode your native provider's output. Gemini WAV is preserved; legacy raw PCM responses are wrapped in WAV.
- Advanced **Lumiverse API base** defaults to `/api/v1`. Change it if your frontend reaches Lumiverse at a different API URL; session authentication and the server's CORS settings still apply.
- Cast and validated attribution settings persist per user/chat/message. Partial and complete audio persist according to **Audio retention** (default: indefinitely) in browser IndexedDB, scoped to the extension namespace and chat/message. Unchanged passage variants remain cached across recasting and text edits until retention expires or you delete audio. Old recordings cannot replay edited text. Clearing browser site data removes recordings; they do not sync to other devices or appear in native Lumiverse TTS controls. Session-only audio is kept until Choir restarts or the page reloads. Storage failure retains a session copy and displays an error. **Delete audio** and **Clear chat audio** remove all passage variants for the selected message/chat.

## Validation and development

The original extension targeted Lumiverse `staging` commit `069777a6cc7fef9a735dd9a460d6da0ab9c72b0f` and extension API types `0.6.40`. This update also inspected current staging worker CORS messaging and the frontend decorator API. Automated regression tests cover backend cancellation, clone-safe Jev transport, explicit fallback diagnostics, both speech adapters, detached drawers, saved-plan restoration, recasting, edited/swiped messages during planning and synthesis, chat switching, partial provider failure, storage failure, selection/exclusion, resume, aliases, loudness gains, and cast exchange.

An optional Chrome smoke test uses actual WAV decoding and Web Audio with simulated providers. It checks quiet/loud passage gains, live mute, current-speaker highlighting, drag, pause, cache replay without new synthesis, and teardown. This fixture is not a running Lumiverse installation or a real-provider quality test.

**It has not been installed into your running Lumiverse instance or tested with real provider credentials.** Actual synthesis quality, provider availability and live UI integration still need your first-use check.

The runtime has no package dependencies. To install development dependencies, rebuild, and run all regression tests:

```text
npm ci
npm test
```

`npm test` rebuilds both distribution bundles and includes DOM integration tests. `npm run test:ui` runs only DOM tests after a build. For the optional real-browser check, install `playwright@1.62.1` without saving it, have Chrome installed, and run `npm run test:chromium`. Set `CHOIR_BROWSER_CHANNEL` to another supported Chromium channel if needed, and `CHOIR_SCREENSHOT` to save a fixture screenshot. Node 24 is the tested development runtime.

Sources: [Lumiverse staging](https://github.com/prolix-oc/Lumiverse/tree/staging), [Spindle developer documentation](https://docs.lumiverse.chat/), [Google Gemini TTS REST documentation](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation).


Named Google voice gender labels follow [Google’s published named voice table](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd). The names match the [Gemini studio catalogue](https://ai.google.dev/gemini-api/docs/speech-generation). The filter shows an already selected voice even if it differs from the filter. Saved voice changes reuse attribution and generate only affected passages; **Replay** retains the last recording's voices.

## Mixed TTS providers

For example, keep the chat default on Gemini, select a saved ElevenLabs/OpenAI/etc. TTS connection on Bakugo’s row, and choose its voice. Choir loads only catalogues needed by the active cast; changing a row connection loads that connection’s voices. Voice gender filters use that catalogue. Provider choices and voices persist together, and every spoken turn is synthesized through its speaker’s connection in order. Native connections reuse Lumiverse credentials; the dedicated Gemini adapter still needs its session API key if any speaker uses it. The key fields are visible even when the chat default is another provider. Delivery style is sent through a supported instructions/instruct/prompt parameter for native overrides when Use delivery styles is enabled; some providers cannot accept styles. Fixed and saved NPC routes override contradictory planner suggestions. Existing NPC cast groups remain scoped by the chat default provider, as before.
