# Iota (Iota) — Project Memory

Single-file-flavored web app (`iota.html` + ES modules) — a voice-first AI
companion avatar, now branded "Iota", that listens, replies via Gemini, and
speaks back with lip-synced idle/speaking video. Runs entirely client-side
(no backend), configured via a Settings sheet, all state in IndexedDB.

## File map
- `iota.html` — UI (chat/voice screens, Settings sheet, persona picker,
  onboarding), all app wiring/event listeners in one inline `<script type="module">`.
- `db/idb.js` — tiny promise-based raw IndexedDB wrapper (two object
  stores: `kv` for settings, `sessions` for conversations). Local only, no
  network calls.
- `config/config.js` — `IotaConfig` class: owns ALL persistent settings and
  sessions, backed by `db/idb.js`. Loads everything into an in-memory cache
  via `init()` (must be awaited once at boot) so the rest of the app can
  keep calling `get()/set()/getSessions()` synchronously; writes persist to
  IndexedDB in the background.
- `persona/personas.js` — preset personas (Best Friend, Teacher, Mother,
  Girlfriend, Boyfriend, Coach): label/tagline for the UI + a system-prompt
  fragment that drives tone for both the typed chat and live voice.
- `brain/brain.js` — `IotaBrain`: Gemini **text** generation
  (`gemini-3.8-flash`, thinking level low, REST `generateContent`; 2.0 Flash was shut down Jun 2026) for the typed chat only.
  Builds the system prompt from the active persona + language.
- `voice/live.js` — `GeminiLiveVoice`: the ONLY voice engine. Opens a raw
  WebSocket to the Gemini Live API, streams mic audio as PCM16 @16kHz via
  `realtimeInput.audio`, and plays the native PCM24 audio reply straight
  through the Web Audio API. No separate STT/TTS call anywhere. Also
  surfaces input/output transcripts (for captions + chat-history logging)
  and handles barge-in (`serverContent.interrupted`) by cutting playback.
- `model/model.js` — `IotaModel`: avatar state machine
  (idle/listening/thinking/speaking), driven directly by
  `liveVoice.onStateChange` — no audio-element attachment needed anymore.
- `assets/iota-idle.mp4`, `assets/iota-speaking.mp4` — avatar loop videos
  (filenames left as-is; internal names weren't part of the rename scope).

## Removed (previous session's stack)
Fully deleted, not just hidden: `voice/engines.js` (Edge/Google/ElevenLabs/
OpenAI TTS), `voice/stt.js` (on-device Whisper STT), `voice/voice.js` (TTS
orchestrator), and all OpenRouter calls in `brain.js`. No trace of
ElevenLabs, OpenAI audio, Whisper, or OpenRouter remains in the codebase.

## Gemini Live specifics (`voice/live.js`)
- Model: `gemini-3.8-live` (Google's default low-latency Live model as of
  Sep 2026). Do NOT send `thinkingConfig`/`thinkingLevel` with it. The old
  `gemini-2.5-flash-native-audio-preview-09-2025` was legacy/throttled and
  slow to answer.
- Speed: setup sends `realtimeInputConfig.automaticActivityDetection` with
  HIGH start/end sensitivity and `silenceDurationMs` = `VAD_SILENCE_MS`
  (500) at the top of `voice/live.js`. Muting sends `audioStreamEnd`.
- Iota speaks first on every live session start (`sendOpeningPrompt`, a
  hidden text turn via `clientContent`) and nudges on her own after
  `NUDGE_FIRST_MS` of user silence (max `NUDGE_MAX` in a row).
- Barge-in: `PCMPlayer.stopAll()` now really stops scheduled sources.
- WebSocket URL: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=...`
- Setup message uses the `setup` envelope (`BidiGenerateContentSetup`) with
  `responseModalities: ["AUDIO"]`, `inputAudioTranscription: {}`, and
  `outputAudioTranscription: {}` enabled so we get text transcripts for
  captions/history without a separate STT call.
- Mic capture uses `ScriptProcessorNode` (deprecated but universally
  supported) routed through a silent `GainNode` to avoid feeding audio back
  to the speakers; averaged (low-pass) downsample to 16kHz since
  `AudioContext` sample rate isn't reliably controllable via constraints.
- Playback uses a dedicated 24kHz `AudioContext` with buffers scheduled
  back-to-back (`nextStartTime` cursor) for gapless audio despite chunks
  arriving async over the socket.
- **Unverified end-to-end** — built from the current public Live API
  reference docs, but there's no network access in this dev sandbox to
  actually open a socket and confirm the exact message shapes/model name
  are still current. If the first real run 400s/404s on `setup`, check
  Google's latest Live API reference for field-name or model-name drift
  first.

## Config gating
- `config.canUseGemini()` = `Boolean(gemini_api_key)` — the only hard
  requirement now, for both typed chat and live voice (same key powers
  both). The old `hasVoiceSelected()`/`voice_setup_complete` step is gone;
  there's no separate voice-selection screen anymore.

## Known open items
- Live voice sessions don't currently replay a resumed session's prior
  messages into Gemini's context — reopening an old conversation on the
  avatar screen starts Gemini fresh (still shows the old messages in the
  text history/drawer, just not "remembered" by that turn's Live session).
  Could be improved later by seeding `clientContent` turns from the stored
  session before the first mic packet.
- The silence-timeout / low-effort "roast" nudge mechanic from the old
  STT-driven loop was removed rather than ported, since Gemini Live owns
  turn-taking/VAD itself now and the mechanic was tightly coupled to the
  old "sassy iota" personality, which doesn't fit personas like
  Teacher/Mother.
