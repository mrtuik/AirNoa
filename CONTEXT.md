# CONTEXT.md — AirC / Noa (read this first, then only open the file you need)

## What this project is
**AirC** is a mobile-first, fully client-side AI companion web app. The user talks (Gemini Live, native audio↔audio) or types to **Noa**, an animated anime-style avatar (two looping videos). A **persona** (Best Friend, Teacher, Mother, Girlfriend, Boyfriend, Coach) changes her tone. On the voice screen Noa also has a **whiteboard** below her for notes / flows / explanations.
- Target: phone browsers and WebView/APK. No backend, no build step, no framework.
- Owner works from a phone: prefer small, surgical patches over rewrites; keep everything vanilla JS + ES modules.

## Run
Serve over http(s) (not `file://`; mic + IndexedDB need it), open `AirC.html`, paste a Gemini API key in Settings (coffee-cup icon). One key powers both typed chat and live voice.

## File map (2.8k lines total)
| File | Role |
|---|---|
| `AirC.html` (~1.5k lines) | ALL UI + CSS + orchestration in one inline `<script type="module">`. Screens: `permission`, `home` (text chat), `assistant` (voice + avatar + whiteboard). Sheets/drawer/popovers for settings, history, persona, voice, language. |
| `config/config.js` | `NoaConfig`: settings + chat sessions. Async `init()` once at boot, then sync `get/set/save`, backed by `db/idb.js`. Defaults: `gemini_api_key, language(hi-IN), persona(friend), live_voice_name(Kore), show_captions(false), onboarding_complete, microphone_setup_complete`. Sessions capped at 40. Also `LANGUAGES` (Hindi/Bengali/English) + `languageSpeakingInstruction()` (Hinglish/Benglish in Roman letters). |
| `db/idb.js` | Tiny promise IndexedDB wrapper; stores `kv`, `sessions`. |
| `persona/personas.js` | `PERSONA_LIST` (UI labels) + `PERSONA_PROMPTS` (system-prompt fragments). Default `friend`. |
| `brain/brain.js` | `NoaBrain` — REST `generateContent` for TYPED chat only (`gemini-3.8-flash`, thinking low, 14-turn history, short 1–3 sentence replies, supports image/file attachments). |
| `voice/live.js` | `GeminiLiveVoice` — the ONLY voice engine. Raw WebSocket to Gemini Live (`gemini-3.8-live`), mic PCM16@16kHz in, PCM@24kHz out via Web Audio, input/output transcripts, barge-in, mute (`audioStreamEnd`), auto-reconnect/session resume, Noa speaks first + idle nudges. Tunables at top: `VAD_SILENCE_MS`, `NUDGE_*`. **Never send `thinkingConfig` to the live model.** |
| `voice/voices.js` | 30 Gemini prebuilt voices, default `Kore`. |
| `model/model.js` | `AirCModel` avatar: `mount() / setState(idle\|listening\|thinking\|speaking)`. Two `<video>`s (`assets/clia-idle.mp4` for idle/listening/thinking, `assets/clia-speaking.mp4` for speaking) cross-faded by opacity. Videos are portrait ~3:4 on a white background. |
| `assets/` | the two mp4s, `fonts/CSCalebMono-Regular_demo.otf` (caption font), stray 2-byte file `Hey` (ignore). |
| `Memory.md` | older detailed dev notes (Gemini Live specifics, removed stack). Still valid; this file is the entry point. |

## How the pieces connect
`boot()` → `config.init()` → mic permission screen → `home` (typed chat via `NoaBrain`) ↔ `assistant` (`goAssistant()` → `model.mount()` + `startLiveConversation()`). `liveVoice.onStateChange` → `setAvatarState()` → `model.setState()`. Live transcripts drive on-avatar captions (`captionUpdate`, ≤4 words/line, paced by `liveVoice.speechClock()`) and are saved to the session via `recordMessage`. Live system instruction = persona prompt + language + "you're speaking, not typing" rules (`buildLiveSystemInstruction()`).

## Assistant screen layout (avatar → whiteboard)
- `#model-container` = top **stage**, height `--stage-h` (`clamp(340px,53dvh,520px)`; `.board-open` → `clamp(270px,38dvh,380px)`). The frame-holder is offset 72px from the top (clears the header) and the video is `object-fit:contain; object-position:50% 0`, so Noa sits smaller and lower.
- Noa dissolves: `.airc-model-wrapper` has a `mask-image` gradient (opaque to 60%, transparent at 100%) + `.stage-blur` (backdrop-filter blur ramping in, fading to white). Screen bg is pure white so it blends with the clip's white backdrop.
- `#board` (`.board`) floats below, overlapping the faded feet by 26px: white, 12px radius, no border, soft shadow, bottom sits above the floating nav (`--safe-b + 90px`). Header has clear (✕) and expand (⌃, toggles `.board-open`).
- Captions (`#captions`) are plain dark text (no shadow/outline), at `--stage-h * .68` (chest area); tune that multiplier if the clip framing changes.
- **Board API** (`window.NoaBoard`, defined in AirC.html): `show({title, blocks})`, `append(block)`, `clear()`. Block types: `heading{text}`, `text{text}`, `list{items}`, `steps{items}`, `flow{nodes}`, `note{text}`, `code{text}`; `**bold**` supported; all via `textContent` (no HTML injection).
  - Added: `compare{title_a,items_a,title_b,items_b}`, `diagram{kind:cycle|hub|tree,nodes,center}` (SVG built in-page), `image{query,caption}` (Wikipedia lookup, block disappears if none), interactive `mcq{question,options,answer}`, `truefalse`, `wyr` (would-you-rather), `flashcard`. Tapping a quiz option sends a hidden text turn to Noa via `liveVoice.sendUserText()`. `show()` accepts `append:true` and returns a hint string used as the toolResponse. List items written `Label: value` render as separate cards; first heading/text gets the border-right icon; 'Board' label has the coffee icon.
- Mid-session hidden prompts (greeting, nudges, quiz taps) use `realtimeInput.text` (native-audio Live models ignore `clientContent` mid-session); `clientContent` is only the 4s fallback. `start(sys, voice, {greet:true})` starts mic + socket in parallel and greets as soon as the socket is up. Silence nudges (15s, then 35s, max 3) ask a question.
- **Wired to Noa** via a Gemini Live function tool: `BOARD_TOOL` (`show_on_board`) is declared in the `setup` message in `voice/live.js`; `_handleServerMessage` handles `toolCall`, calls `liveVoice.onBoard(args)` (→ `NoaBoard.show`) and ALWAYS replies with `toolResponse` (otherwise the model stalls). `buildLiveSystemInstruction()` tells Noa when to use it (Teacher: almost always). **Unverified on a real device** — if the board stays empty, check the console for setup errors / whether the live model accepts `tools`.

## Conventions / gotchas
- Keep UI/orchestration in `AirC.html`; keep modules free of DOM knowledge except `model.js`/`live.js` internals.
- Use `config.get/set` (+ `config.save()`), never touch storage directly.
- Design tokens are CSS vars in `:root` (`--accent:#111114`, `--bg`, `--line`, `--shadow-*`, `--ease`); monochrome, premium white look; Inter font; icons from Lucide (CDN, `renderIcons()`).
- External runtime deps: Lucide (unpkg), Inter (Google Fonts), Gemini REST + WebSocket. Nothing else.
- Live API + model names (`gemini-3.8-live`, `gemini-3.8-flash`) were **never verified end-to-end in the dev sandbox**; if setup 400/404s, check Google's current Live docs first.
- Known gap: resuming an old chat on the avatar screen doesn't seed Gemini's context with prior messages.
- Captions are off by default (`show_captions`).
