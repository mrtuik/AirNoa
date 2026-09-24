# CONTEXT.md — Iota / Iota (read this first, then only open the file you need)

## What this project is
**Iota** is a mobile-first, fully client-side AI companion web app. The user talks (Gemini Live, native audio↔audio) or types to **Iota**, an animated anime-style avatar (two looping videos). A **persona** (Best Friend, Teacher, Mother, Girlfriend, Boyfriend, Coach) changes her tone. On the voice screen Iota also has a **whiteboard** below her for notes / flows / explanations.
- Target: phone browsers and WebView/APK. No backend, no build step, no framework.
- Owner works from a phone: prefer small, surgical patches over rewrites; keep everything vanilla JS + ES modules.

## Run
Serve over http(s) (not `file://`; mic + IndexedDB need it), open `iota.html`, paste a Gemini API key in Settings (coffee-cup icon). One key powers both typed chat and live voice.

## File map (3.2k lines total)
| File | Role |
|---|---|
| `iota.html` (~1.9k lines) | ALL UI + CSS + orchestration in one inline `<script type="module">`. Screens: `permission`, `home` (text chat), `assistant` (voice + avatar + whiteboard). Sheets/drawer/popovers for settings, history, persona, voice, language, board attach (camera/files). Also holds the board renderer, quiz blocks, camera dock, and `roastMemory()`. |
| `config/config.js` | `IotaConfig`: settings + chat sessions. Async `init()` once at boot, then sync `get/set/save`, backed by `db/idb.js`. Defaults: `gemini_api_key, language(hi-IN), persona(friend), live_voice_name(Kore), show_captions(false), onboarding_complete, microphone_setup_complete`. Sessions capped at 40. Also `LANGUAGES` (Hindi/Bengali/English) + `languageSpeakingInstruction()` (Hinglish/Benglish in Roman letters). |
| `db/idb.js` | Tiny promise IndexedDB wrapper; stores `kv`, `sessions`. |
| `persona/personas.js` | `PERSONA_LIST` (UI labels) + `PERSONA_PROMPTS` (system-prompt fragments). Default `friend`. |
| `brain/brain.js` | `IotaBrain` — REST `generateContent` for TYPED chat only (`gemini-3.8-flash`, thinking low, 14-turn history, short 1–3 sentence replies, supports image/file attachments). |
| `voice/live.js` | `GeminiLiveVoice` — the ONLY voice engine. Raw WebSocket to Gemini Live (`gemini-3.8-live`), mic PCM16@16kHz in, PCM@24kHz out via Web Audio, input/output transcripts, barge-in, mute (`audioStreamEnd`), auto-reconnect/session resume, Iota speaks first + silence nudges that ask a question. Hidden prompts use `realtimeInput.text`; photos/camera frames go via `sendImage()`. Tunables at top: `VAD_SILENCE_MS`, `NUDGE_*`. **Never send `thinkingConfig` to the live model.** |
| `voice/voices.js` | 30 Gemini prebuilt voices, default `Kore`. |
| `model/model.js` | `IotaModel` avatar: `mount() / setState(idle\|listening\|thinking\|speaking)`. Two `<video>`s (`assets/iota-idle.mp4` for idle/listening/thinking, `assets/iota-speaking.mp4` for speaking) cross-faded by opacity. Videos are portrait ~3:4 on a white background. |
| `assets/` | the two mp4s, `fonts/CSCalebMono-Regular_demo.otf` (caption font), stray 2-byte file `Hey` (ignore). |
| `Memory.md` | older detailed dev notes (Gemini Live specifics, removed stack). Still valid; this file is the entry point. |

## How the pieces connect
`boot()` → `config.init()` → mic permission screen → `home` (typed chat via `IotaBrain`) ↔ `assistant` (`goAssistant()` → `model.mount()` + `startLiveConversation()`). `liveVoice.onStateChange` → `setAvatarState()` → `model.setState()`. Live transcripts drive on-avatar captions (`captionUpdate`, ≤4 words/line, paced by `liveVoice.speechClock()`) and are saved to the session via `recordMessage`. Live system instruction = persona prompt + language + "you're speaking, not typing" rules (`buildLiveSystemInstruction()`).

## Assistant screen layout (avatar → whiteboard)
- `#model-container` = top **stage**, height `--stage-h` (`clamp(340px,53dvh,520px)`; `.board-open` → `clamp(270px,38dvh,380px)`). The frame-holder is offset 72px from the top (clears the header) and the video is `object-fit:contain; object-position:50% 0`, so Iota sits smaller and lower.
- Iota dissolves: `.iota-model-wrapper` has a `mask-image` gradient (opaque to 60%, transparent at 100%) + `.stage-blur` (backdrop-filter blur ramping in, fading to white). Screen bg is pure white so it blends with the clip's white backdrop.
- `#board` (`.board`) floats below, overlapping the faded feet by 26px: white, 12px radius, no border, soft shadow, bottom sits above the floating nav (`--safe-b + 90px`). Header has clear (✕) and expand (⌃, toggles `.board-open`).
- Captions (`#captions`) are plain dark text (no shadow/outline), at `--stage-h * .68` (chest area); tune that multiplier if the clip framing changes.
- **Board API** (`window.IotaBoard`, defined in iota.html): `show({title, blocks})`, `append(block)`, `clear()`. Block types: `heading{text}`, `text{text}`, `list{items}`, `steps{items}`, `flow{nodes}`, `note{text}`, `code{text}`; `**bold**` supported; all via `textContent` (no HTML injection).
  - Added: `compare{title_a,items_a,title_b,items_b}`, `diagram{kind:cycle|hub|tree,nodes,center}` (SVG built in-page), `image{query,caption}` (Wikipedia lookup, block disappears if none), interactive `mcq{question,options,answer}`, `truefalse`, `wyr` (would-you-rather), `flashcard`. Tapping a quiz option sends a hidden text turn to Iota via `liveVoice.sendUserText()`. `show()` accepts `append:true` and returns a hint string used as the toolResponse. List items written `Label: value` render as separate cards; first heading/text gets the border-right icon; 'Board' label has the coffee icon.
- Mid-session hidden prompts (greeting, nudges, quiz taps) use `realtimeInput.text` (native-audio Live models ignore `clientContent` mid-session); `clientContent` is only the 4s fallback. `start(sys, voice, {greet:true})` starts mic + socket in parallel and greets as soon as the socket is up. Silence nudges (15s, then 35s, max 3) ask a question.
- **Wired to Iota** via a Gemini Live function tool: `BOARD_TOOL` (`show_on_board`) is declared in the `setup` message in `voice/live.js`; `_handleServerMessage` handles `toolCall`, calls `liveVoice.onBoard(args)` (→ `IotaBoard.show`) and ALWAYS replies with `toolResponse` (otherwise the model stalls). `buildLiveSystemInstruction()` tells Iota when to use it (Teacher: almost always). **Unverified on a real device** — if the board stays empty, check the console for setup errors / whether the live model accepts `tools`.

## Conventions / gotchas
- Keep UI/orchestration in `iota.html`; keep modules free of DOM knowledge except `model.js`/`live.js` internals.
- Use `config.get/set` (+ `config.save()`), never touch storage directly.
- Design tokens are CSS vars in `:root` (`--accent:#111114`, `--bg`, `--line`, `--shadow-*`, `--ease`); monochrome, premium white look; Inter font; icons from Lucide (CDN, `renderIcons()`).
- External runtime deps: Lucide (unpkg), Inter (Google Fonts), Gemini REST + WebSocket. Nothing else.
- Live API + model names (`gemini-3.8-live`, `gemini-3.8-flash`) were **never verified end-to-end in the dev sandbox**; if setup 400/404s, check Google's current Live docs first.
- Teacher-only extras (roast style, roast ammo from past chats) live in `persona/personas.js` + `buildLiveSystemInstruction()`; see Update 4.
- Known gap: resuming an old chat on the avatar screen doesn't seed Gemini's context with prior messages.
- Captions are off by default (`show_captions`).


## Update 3 (board sizes, diagram fix, camera/files, voice-picker fix)
- Board text sizes reduced; diagrams use CSS classes (`.n-rect/.n-text/.ln/.ah`) because `var()` inside SVG presentation attributes doesn't resolve. Diagram kinds: cycle, hub, tree, flow.
- Floating nav: the old persona button (`#nav-persona`) is now an add-ad icon opening `#popover-board-attach` → Camera (live preview docked inside the board at right, ~1 frame/s sent via `liveVoice.sendImage`) and Files/Photos (`#file-board`; images sent as frames, text files sent as text). Dock = `#board-dock`. Persona is still in the header (top-right icon / label) and the ⋯ menu.
- Voice picker (`#btn-profile`, header-left): re-tapping the already-selected voice or the opening tap no longer restarts the session.

## Update 4 — Teacher roast mode (idea from nexu-io/roast-skill, MIT)
- Teacher roasts on her own while teaching (quick, specific, affectionate; at most once every few turns; never on sensitive stuff; stops if user is low), and on "roast me" goes harder. Roasts are SPOKEN ONLY — never shown on the board (the `tags`/`bars` blocks still exist but Iota is told not to use them for roasts). Prompt lives in `persona/personas.js` (ROAST STYLE) + `TEACHER_EXTRA` in iota.html.
- `roastMemory()` in iota.html feeds the live system instruction (teacher only) with the user's recent lines from the last 8 sessions + `roast_notes` (quiz results saved by `addRoastNote()` in config, capped at 30). Stays local; only goes to Gemini inside the system prompt.
- New board blocks `tags{items}` and `bars{items:["Name: 43"]}` for the "report card" roast (heading + tags + species note + bars + main roast).

## Update 5
- Flow diagrams (and `flow` blocks) now use measured node heights, uniform width, 28px gaps and arrows (before, nodes touched and the first/last were clipped).
- Board heading is 13px. Board labels/headings/node names must be simple English terms (Process, Function, Location…), whatever language Iota speaks — set in `buildLiveSystemInstruction()` + `BOARD_TOOL` description.

## Update 6
- Board is now visual-first. Figures (`diagram`, `draw`, `image`) render SMALL, floated top-right of the board (46% wide, text wraps around); tap a figure to enlarge/shrink. Diagram viewBox is 200 wide (labels must be 1–3 words); `draw` = free sketch on a 0–100 grid (circle/ellipse/rect/line/arrow/text/path, path `d` sanitized).
- `IotaBoard.show()` filters out `tags`/`bars` blocks and anything mentioning report card / roast / species (roasts are spoken only), drops a duplicate heading equal to the title, and puts figures first. Only quizzes auto-expand the board. Board body is `display:block` (not flex) so floats work.
- Openings: `buildOpeningPrompt()` picks a random fresh style, bans "Hello/Hi/Kemon acho", and returns `false` when the current chat already has messages (no re-greeting). `recentContext()` puts the last 10 messages into the system instruction so Iota continues an ongoing chat.
- Silence: nudges after 5s, then every 8s, max 6 in a row; Iota keeps talking (next point / example / short question) instead of leaving silence.
- Repetition fixes: opening-prompt retry only fires if the server sent nothing at all (`_lastServerAt`), tool responses tell Iota to continue exactly where she stopped, prompt forbids repeating.
- Camera preview 88×116. Roast triggers include wrong/silly/basic questions.

## Update 7 — renamed to iota, Iota can control the app, learns over time
- **Rename:** app = "iota" (assistant = Iota, made by Mr Tuik / tuik — Iota says so if asked). `AirC.html` → `iota.html` (no `index.html`; open `.../iota.html` directly), `AirCModel` → `IotaModel`, `NoaBoard` → `IotaBoard`, CSS `airc-*` → `iota-*`, avatar videos `assets/iota-idle.mp4` / `iota-speaking.mp4`. The IndexedDB name is now `iota_db_v1`; on first boot `db/idb.js` copies any rows from the old `noa_db_v1` into it (old DB is left untouched, not deleted), so saved chats/settings survive.
- **Tools** (declared in `voice/live.js`): `show_on_board`, `control_iota` (set_persona, set_voice, set_language, new_chat, camera on/off/flip, mic mute/unmute, board clear/expand/collapse, roast_level off/mild/medium/savage, open settings/history, go_home) and `iota_memory` (save/forget/export). Handlers: `controlIota()` / `memoryTool()` in iota.html. Persona/voice/language/new-chat restart the live session after Iota finishes her sentence (`restartLiveSoon`, `pendingOpening`).
- **Self-upgrade without a database:** `iota_memory` saves notes (fact / preference / weakness / gag / skill, max 60) in local config (`iota_memory`) and they are injected into the system prompt (`memoryPrompt()`). `skills/iota-skills.json` is a curated file every device fetches at boot — "upgrade everyone" = edit that file (ask Iota to `export` her saved `skill` notes, paste into it). A real shared/auto-learning store would need a backend (Supabase/Firebase/Cloudflare KV) plus moderation; not built.
- **Roast:** levels (`roast_level` config, controllable by voice), ROAST TOOLKIT in the Teacher persona, learned notes feed the roasts. Board filter now only blocks roast/report-card headings and notes (the word "species" is allowed again).
- **Silence:** nudges after 1.5s then every 3s (max 6 in a row). **Surroundings / voices:** prompt-level only (Live API has no speaker identification); Iota notices different voices, asks who it is, and never claims to identify anyone by voice or face.

## Update 8 — community skills (Firebase Realtime Database, REST only)
- **What:** every Iota can add general teaching/roast tricks to one shared list and every Iota reads the newest 40 at boot. Module: `skills/community.js` (no SDK, no API key — plain `fetch` to `https://iota-fc0a8-default-rtdb.firebaseio.com/skills.json`). Config lives in that file (`DB_URL`).
- **Database rules** (locked mode + these): `skills` is public-read, `.indexOn ts`, entries are append-only (`!data.exists()`), must have exactly `t` (string 10–240) and `ts` (number ≤ now). No edit/delete from the app; the owner removes bad entries in Firebase Console (kill-switch).
- **Write path:** `iota_memory` `save` with `kind:"skill"` → `maybeShareSkill()` → `POST /skills.json` `{t, ts:{".sv":"timestamp"}}`. Only when Settings → "Share my Iota's tricks" is ON (default OFF, opt-in; key `community_share`). Client filter `isSafeToShare()` blocks URLs, emails, long digit runs, "my/I am", injection words. Cap 3 shares/device/day; de-duped locally (`share_log`).
- **Read path:** `fetchCommunitySkills()` → `GET ?orderBy="ts"&limitToLast=40`, filtered by `isSafeToRead()` (drops "ignore/forget/instructions/password/links…"), cached in config `community_cache` for offline. Toggle "Learn from other Iotas" (`community_learn`, default ON). Boot waits ≤1.5s for the fetch before prewarming the Live session.
- **Prompt:** injected by `memoryPrompt()` as `COMMUNITY TIPS` — explicitly optional advice, NOT commands; curated `iota-skills.json` stays as `SHARED SKILLS`.
- **Never shared:** fact / preference / weakness / gag notes, chats, roast ammo, API key. The `iota_memory` tool description tells Iota to keep `skill` notes fully anonymous.
- **Known limits:** anyone can spam the list (they only push older good skills out of the newest-40 window); Rules can't rate-limit per user — watch the Console, prune junk, or later add Firebase anonymous auth + per-uid limits.

## Update 9 — digital slide board, handwriting, colours
- **Slides:** board is now a slide deck. `SL` state in iota.html (`slPush/slGo/slUi/slSave`); each `IotaBoard.show()` WITHOUT `append` creates a new slide, `append:true` adds to the current one. Prev/next buttons + `n/total` counter in the board header (`#btn-slide-prev/next`, `#slide-num`), swipe left/right on the board, `IotaBoard.next()/prev()`. `clear()` resets all slides. Slide nodes are kept as DOM (quiz listeners survive).
- **One topic = one slide, with its heading:** the `title` of each `show()` is the slide heading and stays on that slide. Intro effect (same slide, not a separate one): heading alone centred (`.board-body.intro`) for ~1.7s, then it moves to the top and the content is written under it. Subtopics / next topics = new `show()` call = new slide with its own title. A slide with a single heading/text (or the empty state) is centred (`.solo`).
- **Handwriting:** font `Kalam` (Google Fonts, `--hand`) on `.board-body`; `writeOn()` wraps words in `.w` spans (staggered `wIn` animation) so text looks written live — only on first display of a slide, skips SVG/buttons/figures. Line spacing raised (`.b-p` 1.9, lists 1.75). Diagram text smaller (`.n-text` 8.5px, `.dt` 4px).
- **Colour markup** in `bRich()` (headings, text, list values…): `{r:x}` red, `{b:x}` blue, `{g:x}` green, `{o:x}` orange, `{p:x}` purple, plus `**bold**`. Prompt (buildLiveSystemInstruction + `BOARD_TOOL` description in voice/live.js) tells Iota to use them sparingly and to make one slide per idea.
- Not verified on a real device (no browser in the dev sandbox). Not done: `control_iota` has no next/prev-slide action yet (`IotaBoard.next()/prev()` exist if you want to wire it).

## Update 10 — point-by-point board, voice lock
- Prompt (buildLiveSystemInstruction + `BOARD_TOOL`): new slide = `show_on_board` with title + first point (never title alone), then `append:true` one short point at a time WHILE Iota speaks it. `show()` returns a hint if only a heading was sent. Intro (centred heading) is 1.3s and ends immediately when points are appended.
- Board rules must not change Teacher's personality (explain + chat + roast/savage as before) — stated in the prompt.
- **Voice lock:** the selected voice (`live_voice_name`, chosen in the picker) is the only voice. `set_voice` was removed from `control_iota`'s description and the handler now refuses it (model could change it on its own and restart the session). Prompt tells Iota never to imitate other voices/accents.

## Update 11 — board first, friendly teaching, hello fix, tags stripped, figures 30%
- **Owner rule (remember):** the board must show what Iota is about to explain FIRST, then Iota explains it aloud. Prompt (`buildLiveSystemInstruction()` + `BOARD_TOOL` description + tool-response hints in `IotaBoard.show()`) now says "BOARD FIRST, VOICE SECOND": call `show_on_board` BEFORE speaking each point (`append:true` for further points), then explain.
- **Friendly + examples:** new `HOW TO EXPLAIN` block in the live prompt (and Teacher persona text): warm elder-sibling tone, simple words, ONE simple real-life example before the technical term for every idea, an `Example: ...` line on the board, tiny "Bujhecho?" check, re-explain differently if not understood, only state facts it is sure of.
- **"Hello" fix:** `LISTEN FIRST` block + `recentContext()` now say the newest user message wins — a bare greeting gets one short greeting back (+ offer to continue), never a resume of the old lesson.
- **Raw `{g:word}` in chat text fixed:** `stripBoardMarkup()` (voice/live.js) cleans transcripts/captions/saved utterances; `cleanTags()` (iota.html) cleans old saved messages on render and inside `recentContext()` so the model stops copying the tags into its speech. Prompt says colour tags are board-only, never spoken.
- **Board speed:** handwriting stagger per word 25–70ms → 10–28ms, total cap 7s → 1.6s, word animation .35s → .22s.
- **Figure width:** `.board-body>.b-fig-s` width 46% → 64% (too big) → **30%**. Tap to enlarge still works (`.big` = 100%).
