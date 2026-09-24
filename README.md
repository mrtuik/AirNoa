# Iota — Iota

A live voice + text AI companion. Talk to Iota naturally over the Gemini Live
API (native audio-to-audio, no separate STT/TTS), or type to her from the
home screen. Pick a persona (Teacher, Mother, Girlfriend, Best Friend,
Boyfriend, Coach) to change her tone.

## Setup
1. Open `iota.html` in a browser (served over http(s), not `file://`, so
   microphone access and IndexedDB work correctly).
2. Add a Gemini API key in Settings (the coffee-cup icon on the home
   screen) — this single key powers both the typed chat and the live voice
   conversations.
3. Grant microphone access when prompted.

## Architecture
- `iota.html` — UI + orchestration only.
- `config/config.js` — all settings and conversation sessions, persisted to
  IndexedDB (`db/idb.js`). Fully local, no network calls in this layer.
- `brain/brain.js` — Gemini text generation for the typed chat.
- `voice/live.js` — the voice engine: Gemini Live API over WebSocket,
  PCM16 16kHz mic in, PCM 24kHz playback out. The only voice pipeline in
  the app — no ElevenLabs/OpenAI/Whisper/OpenRouter anywhere.
- `persona/personas.js` — persona presets and their system prompts.
- `skills/community.js` — optional shared skill list (Firebase Realtime Database over REST). Iota reads general tricks other Iotas learned; sharing is opt-in in Settings and never includes chats or personal notes.
- `model/model.js` — the on-screen avatar (idle/listening/thinking/speaking).
