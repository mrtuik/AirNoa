// voice/live.js
// Noa's voice engine: Gemini Live API over a raw WebSocket, native
// audio-to-audio. This is the ONLY voice engine in the app — there is no
// separate speech-to-text or text-to-speech call anywhere in this module
// or anywhere else in the codebase. Mic audio is streamed to Gemini as
// PCM16 @16kHz via realtimeInput.audio; Gemini's spoken reply comes back
// as PCM @24kHz and is played directly through the Web Audio API.
//
// Gemini 3.8 Live (released Sep 15, 2026) is Google's default low-latency
// voice model. The old 2.5 native-audio preview this app used before is
// legacy/throttled and much slower to answer. NOTE: 3.8 Live does not
// accept thinkingConfig/thinkingLevel — never add it to the setup message.
// If this ever 404s, swap in the current Live model from the Gemini docs.
const LIVE_MODEL = "gemini-3.8-live";

// --- Response-speed tuning -------------------------------------------------
// How long the server waits after you stop talking before Noa answers.
// Google recommends 500-800ms; lower = snappier but she may jump in during
// a natural pause. Try 400 if you want her even faster, 700 if she cuts in.
const VAD_SILENCE_MS = 500;
const VAD_PREFIX_PADDING_MS = 40;

// --- "Noa talks on her own" ------------------------------------------------
// If you go quiet for a while, she says something to keep the chat going.
// First nudge after NUDGE_FIRST_MS of silence, the next after NUDGE_NEXT_MS,
// and at most NUDGE_MAX in a row until you speak again.
const NUDGE_FIRST_MS = 15000;
const NUDGE_NEXT_MS = 35000;
const NUDGE_MAX = 3;

const BOARD_TOOL = {
    name: "show_on_board",
    description: "Show notes, a diagram, a picture or an interactive quiz on the whiteboard under you while you explain. Keep text short (phrases, not paragraphs) and put each idea in its own block. Replaces the board unless append is true.",
    parameters: {
        type: "OBJECT",
        properties: {
            title: { type: "STRING", description: "Short heading for the board." },
            append: { type: "BOOLEAN", description: "true = add below what is already on the board instead of replacing it." },
            blocks: {
                type: "ARRAY",
                description: "Content blocks shown top to bottom.",
                items: {
                    type: "OBJECT",
                    properties: {
                        type: { type: "STRING", description: "One of: heading, text, list, steps, flow, note, code, compare, diagram, image, mcq, truefalse, wyr, flashcard, tags, bars." },
                        text: { type: "STRING", description: "For heading, text, note, code." },
                        items: { type: "ARRAY", items: { type: "STRING" }, description: "For list, steps, tags. For list use 'Label: short value' so each item becomes its own card. For bars use 'Stat name: 0-100' (e.g. 'Dhoiryo: 43')." },
                        nodes: { type: "ARRAY", items: { type: "STRING" }, description: "For flow and diagram: the boxes, in order (max 8)." },
                        kind: { type: "STRING", description: "For diagram: cycle (loop/circulation), hub (centre with spokes), or tree (root with branches)." },
                        center: { type: "STRING", description: "For diagram: the centre (hub/cycle) or root (tree) label." },
                        question: { type: "STRING", description: "For mcq, truefalse, wyr, flashcard." },
                        options: { type: "ARRAY", items: { type: "STRING" }, description: "For mcq (2-4 options) and wyr (exactly 2)." },
                        answer: { type: "STRING", description: "Correct option letter (A/B/C/D) or its exact text; for truefalse 'True' or 'False'; for flashcard the answer shown on tap. Omit for wyr." },
                        query: { type: "STRING", description: "For image: a specific topic to look up a picture for, e.g. 'Cerebrospinal fluid'." },
                        caption: { type: "STRING", description: "For image: one short line saying what it is." },
                        title_a: { type: "STRING", description: "For compare: left column title." },
                        items_a: { type: "ARRAY", items: { type: "STRING" }, description: "For compare: left column points." },
                        title_b: { type: "STRING", description: "For compare: right column title." },
                        items_b: { type: "ARRAY", items: { type: "STRING" }, description: "For compare: right column points." }
                    },
                    required: ["type"]
                }
            }
        },
        required: ["blocks"]
    }
};

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const MIC_BUFFER_SIZE = 4096;

function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

// Resample down to 16kHz by averaging the source samples that fall inside
// each output sample (a cheap low-pass). Nearest-neighbor picking aliases
// badly on 48kHz phone mics and makes speech recognition worse.
function downsampleTo16k(float32, inRate) {
    if (inRate === INPUT_SAMPLE_RATE) return float32;
    const ratio = inRate / INPUT_SAMPLE_RATE;
    const outLength = Math.floor(float32.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(float32.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
        let sum = 0;
        for (let j = start; j < end; j++) sum += float32[j];
        out[i] = sum / (end - start);
    }
    return out;
}

function bufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
}

// Schedules incoming PCM24 chunks back-to-back on a dedicated 24kHz
// AudioContext so playback is gapless even though chunks arrive
// asynchronously over the WebSocket.
class PCMPlayer {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
        this.nextStartTime = 0;
        this.activeSources = 0;
        this.sources = new Set();
        this.onQueueEmpty = null;
        this.turnStart = null; // audio-clock time the current spoken turn began
        this.turnDur = 0;      // seconds of audio scheduled for it so far
    }

    resume() {
        if (this.ctx.state === "suspended") this.ctx.resume().catch(() => { /* ignore */ });
    }

    playChunk(base64Pcm) {
        const int16 = base64ToInt16(base64Pcm);
        if (!int16.length) return;
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

        const buffer = this.ctx.createBuffer(1, float32.length, this.ctx.sampleRate);
        buffer.copyToChannel(float32, 0);

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);

        // Tiny lead-in on the first chunk so playback doesn't glitch.
        const startAt = Math.max(this.ctx.currentTime + 0.05, this.nextStartTime); // small jitter buffer
        if (this.turnStart === null || (this.activeSources === 0 && this.nextStartTime <= this.ctx.currentTime)) {
            this.turnStart = startAt;
            this.turnDur = 0;
        }
        this.turnDur += buffer.duration;
        source.start(startAt);
        this.nextStartTime = startAt + buffer.duration;
        this.activeSources += 1;
        this.sources.add(source);
        source.onended = () => {
            this.sources.delete(source);
            this.activeSources = Math.max(0, this.activeSources - 1);
            if (this.activeSources === 0 && this.onQueueEmpty) this.onQueueEmpty();
        };
    }

    // Barge-in: actually stop everything that's queued/playing right now.
    // (Before, this only reset the counters, so Noa kept talking over you.)
    stopAll() {
        this.sources.forEach((source) => {
            try { source.onended = null; source.stop(); } catch (err) { /* already stopped */ }
        });
        this.sources.clear();
        this.nextStartTime = 0;
        this.activeSources = 0;
        this.turnStart = null;
        this.turnDur = 0;
    }

    isPlaying() {
        return this.activeSources > 0 || this.nextStartTime > this.ctx.currentTime;
    }

    destroy() {
        this.stopAll();
        try { this.ctx.close(); } catch (err) { /* ignore */ }
    }
}

export class GeminiLiveVoice {
    /** @param {NoaConfig} config */
    constructor(config) {
        this.config = config;
        this.ws = null;
        this.player = null;

        this.micStream = null;
        this.micCtx = null;
        this.micSource = null;
        this.micProcessor = null;

        this.muted = false;
        this.connected = false;

        this._pendingUserText = "";
        this._pendingAssistantText = "";

        this._state = "idle";
        this._quietSince = Date.now();
        this._nudgeCount = 0;
        this._nudgeTimer = null;
        this._lastAudioAt = 0;
        this.nudgeHint = null; // () => string — extra context for silence nudges (e.g. an unanswered quiz)

        // Connection resilience / pre-warm state
        this._resumeHandle = null;
        this._closingByUser = false;
        this._reconnecting = false;
        this._opening = null;
        this._wsKey = null;
        this._apiKey = null;
        this._sys = null;
        this._voice = null;

        // Hooks the app controller (AirC.html) assigns before calling start().
        this.onStateChange = null;        // (state: "connecting"|"listening"|"speaking"|"idle") => void
        this.onCaption = null;            // (text: string) => void — live partial of what Noa is saying
        this.onUserUtterance = null;      // (text: string) => void — finalized transcript of user speech
        this.onAssistantUtterance = null; // (text: string) => void — finalized transcript of Noa's reply
        this.onError = null;              // (message: string) => void
        this.onBoard = null;              // (args: {title?, blocks[]}) => void — Noa called show_on_board
    }

    // Where we are in the audio Noa is speaking right now (for caption sync).
    speechClock() {
        const p = this.player;
        if (!p || p.turnStart === null) return null;
        return { played: Math.max(0, p.ctx.currentTime - p.turnStart), total: p.turnDur };
    }

    isSpeaking() {
        return Boolean(this.player && this.player.isPlaying());
    }

    /**
     * Opens the Live session and starts streaming mic audio.
     * @param {string} systemInstruction - persona + language system prompt
     * @param {string} [voiceName] - one of Gemini's prebuilt voice names (see voice/voices.js)
     */
    async start(systemInstruction, voiceName, opts = {}) {
        const apiKey = this.config.get("gemini_api_key");
        if (!apiKey) {
            this.onError && this.onError("Add your Gemini API key in Configuration first.");
            throw new Error("no-key");
        }

        this._closingByUser = false;
        this._apiKey = apiKey;
        this._sys = systemInstruction;
        this._voice = voiceName;
        this._setState("connecting");
        this.player = new PCMPlayer();
        this.player.resume(); // inside the click gesture
        this._pendingUserText = "";
        this._pendingAssistantText = "";

        try {
            // Mic and socket start in parallel: mic startup on phones can take
            // 1-2s and used to run AFTER the socket, delaying Noa's first words.
            const micReady = this._startMic();
            micReady.catch(() => { /* surfaced by the await below */ });
            // Reuse the pre-warmed socket if it is still open and matches.
            if (this._opening) await this._opening;
            const key = `${systemInstruction}|${voiceName}`;
            const reusable = this.ws && this.ws.readyState === WebSocket.OPEN && this._wsKey === key;
            if (!reusable) {
                if (this.ws) { try { this.ws.close(); } catch (err) { /* ignore */ } this.ws = null; }
                this._wsKey = key;
                await this._openSocket(apiKey, systemInstruction, voiceName, null);
            }
            if (opts.greet) this.sendOpeningPrompt(); // speak first the moment the socket is up
            await micReady;
        } catch (err) {
            this.stop();
            this.onError && this.onError("Couldn't start the voice session. Check your Gemini API key and try again.");
            throw err;
        }

        this.connected = true;
        this._quietSince = Date.now();
        this._nudgeCount = 0;
        this._startNudgeTimer();
        if (!this.isSpeaking() && this._state !== "speaking") this._setState("listening");
    }

    /** Opens the WebSocket ahead of time (call at boot / when returning home)
     *  so the avatar screen only has to start the mic and go. */
    prewarm(systemInstruction, voiceName) {
        const apiKey = this.config.get("gemini_api_key");
        if (!apiKey || this.connected || this._opening) return;
        if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
        this._closingByUser = false;
        this._wsKey = `${systemInstruction}|${voiceName}`;
        this._opening = this._openSocket(apiKey, systemInstruction, voiceName, null)
            .catch(() => { /* start() will just open a fresh socket */ })
            .finally(() => { this._opening = null; });
    }

    // Socket dropped mid-conversation (network blip, server GoAway / session
    // limit) — reopen silently, resuming the same session so Noa keeps context.
    async _reconnect() {
        if (this._reconnecting) return;
        this._reconnecting = true;
        this._setState("connecting");
        for (let i = 0; i < 4 && !this._closingByUser; i++) {
            await new Promise((r) => setTimeout(r, 300 * (i + 1)));
            if (this._closingByUser) break;
            try {
                await this._openSocket(this._apiKey, this._sys, this._voice, this._resumeHandle);
                this.connected = true;
                this._quietSince = Date.now();
                this._reconnecting = false;
                this._setState(this.muted ? "idle" : "listening");
                return;
            } catch (err) {
                if (i >= 1) this._resumeHandle = null; // handle may be stale — start clean
            }
        }
        this._reconnecting = false;
        if (!this._closingByUser) {
            this.onError && this.onError("Voice connection lost. Tap the mic to retry.");
            this._setState("idle");
        }
    }

    _openSocket(apiKey, systemInstruction, voiceName, resumeHandle) {
        return new Promise((resolve, reject) => {
            const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
            const ws = new WebSocket(url);
            // Binary frames as ArrayBuffer -> decoded synchronously, so messages
            // are handled strictly in order (async Blob.text() could reorder audio).
            ws.binaryType = "arraybuffer";
            this.ws = ws;
            let settled = false;

            ws.onopen = () => {
                ws.send(JSON.stringify({
                    setup: {
                        model: `models/${LIVE_MODEL}`,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: voiceName
                                ? { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
                                : undefined
                        },
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        // Whiteboard tool: Noa calls this while explaining; the app
                        // renders it in the board under her avatar (NoaBoard.show).
                        tools: [{ functionDeclarations: [BOARD_TOOL] }],
                        // Faster end-of-speech detection so Noa answers as
                        // soon as you stop talking (server default waits
                        // ~800ms+). See VAD_SILENCE_MS at the top.
                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                disabled: false,
                                // LOW: room noise / speaker echo no longer cuts Noa off mid-sentence.
                                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                                prefixPaddingMs: VAD_PREFIX_PADDING_MS,
                                silenceDurationMs: VAD_SILENCE_MS
                            }
                        },
                        // Transcripts drive the on-screen captions and the
                        // chat-history log — no separate STT call needed.
                        inputAudioTranscription: {},
                        outputAudioTranscription: {},
                        // Lets audio sessions run past the ~15 min cap, and lets us
                        // resume the same session after a dropped socket.
                        contextWindowCompression: { slidingWindow: {} },
                        sessionResumption: resumeHandle ? { handle: resumeHandle } : {}
                    }
                }));
            };

            ws.onmessage = (event) => {
                if (ws !== this.ws) return;
                let payload = event.data;
                if (payload instanceof ArrayBuffer) payload = new TextDecoder().decode(payload);
                let msg;
                try {
                    msg = JSON.parse(payload);
                } catch (err) {
                    return;
                }

                if (msg.setupComplete && !settled) {
                    settled = true;
                    resolve();
                    return;
                }
                this._handleServerMessage(msg);
            };

            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    reject(new Error("Gemini Live connection failed."));
                }
                if (this.connected) this.onError && this.onError("Voice connection hiccuped.");
            };

            ws.onclose = (ev) => {
                if (this.ws !== ws) return; // stale socket
                const wasConnected = this.connected;
                this.connected = false;
                if (!settled) {
                    settled = true;
                    console.warn("[Noa] Live socket closed during setup:", ev.code, ev.reason);
                    reject(new Error(`Gemini Live closed before setup: ${ev.code} ${ev.reason || ""}`));
                } else if (wasConnected && !this._closingByUser) {
                    console.warn("[Noa] Live socket dropped:", ev.code, ev.reason);
                    this._reconnect();
                } else if (wasConnected) {
                    this._setState("idle");
                }
            };
        });
    }

    _handleServerMessage(msg) {
        if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
            this._resumeHandle = msg.sessionResumptionUpdate.newHandle;
        }
        if (msg.goAway) console.warn("[Noa] Server GoAway, will reconnect:", msg.goAway.timeLeft);

        if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
            const functionResponses = msg.toolCall.functionCalls.map((fc) => {
                let response = { result: "ok" };
                try {
                    if (fc.name === "show_on_board") {
                        const hint = this.onBoard && this.onBoard(fc.args || {});
                        if (typeof hint === "string" && hint) response = { result: hint };
                    }
                    else response = { error: `unknown function ${fc.name}` };
                } catch (err) {
                    console.warn("[Noa] show_on_board failed:", err);
                    response = { error: String(err && err.message || err) };
                }
                return { id: fc.id, name: fc.name, response };
            });
            // Must answer every toolCall, or the model stalls waiting.
            if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
            return;
        }

        const serverContent = msg.serverContent;
        if (!serverContent) return;

        if (serverContent.interrupted) {
            // The user started talking over Noa — stop playback immediately
            // (barge-in), same as a real conversation.
            this.player && this.player.stopAll();
            // Flush what Noa managed to say so the next turn's caption starts clean.
            const cut = this._pendingAssistantText.trim();
            this._pendingAssistantText = "";
            if (cut && this.onAssistantUtterance) this.onAssistantUtterance(cut);
            this._markUserActive();
            if (!this.muted) this._setState("listening");
        }

        if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
            this._pendingUserText += serverContent.inputTranscription.text;
            this._markUserActive();
        }
        if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
            this._pendingAssistantText += serverContent.outputTranscription.text;
            this.onCaption && this.onCaption(this._pendingAssistantText);
        }

        const parts = serverContent.modelTurn && serverContent.modelTurn.parts;
        if (Array.isArray(parts)) {
            parts.forEach((part) => {
                if (part.inlineData && part.inlineData.data) {
                    this._lastAudioAt = Date.now();
                    this._setState("speaking");
                    if (!this.player) return;
                    this.player.resume();
                    this.player.playChunk(part.inlineData.data);
                }
            });
        }

        if (serverContent.turnComplete) {
            const userText = this._pendingUserText.trim();
            const assistantText = this._pendingAssistantText.trim();
            this._pendingUserText = "";
            this._pendingAssistantText = "";
            if (userText && this.onUserUtterance) this.onUserUtterance(userText);
            if (assistantText && this.onAssistantUtterance) this.onAssistantUtterance(assistantText);

            // Hand the floor back to the mic once whatever's queued has
            // actually finished playing.
            const waitForPlaybackToFinish = () => {
                if (this.player && this.player.isPlaying()) {
                    setTimeout(waitForPlaybackToFinish, 150);
                } else if (!this.muted) {
                    this._quietSince = Date.now(); // silence clock starts when Noa finishes talking
                    this._setState("listening");
                } else {
                    this._setState("idle");
                }
            };
            waitForPlaybackToFinish();
        }
    }

    async _startMic() {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
        if (this._closingByUser) { stream.getTracks().forEach((t) => t.stop()); return; } // stopped while the mic was starting
        this.micStream = stream;

        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.micCtx = ctx;
        const source = ctx.createMediaStreamSource(stream);
        this.micSource = source;

        // ScriptProcessorNode is deprecated but universally supported and
        // simple — fine for this app's needs. It has to be connected to a
        // destination to fire in some browsers, so we route it through a
        // silent gain node instead of straight to speakers (no echo).
        const processor = ctx.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
        this.micProcessor = processor;
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;

        processor.onaudioprocess = (event) => {
            if (this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const input = event.inputBuffer.getChannelData(0);
            const downsampled = downsampleTo16k(input, ctx.sampleRate);
            const pcm16 = floatTo16BitPCM(downsampled);
            const base64 = bufferToBase64(pcm16.buffer);
            this.ws.send(JSON.stringify({
                realtimeInput: { audio: { data: base64, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } }
            }));
        };

        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    /**
     * Nudges Gemini to speak first on a brand-new conversation (mirrors the
     * old "Noa always speaks first" behavior). Sent as a text-only turn, so
     * it does NOT go through audio transcription and never shows up as a
     * fake user chat bubble.
     */
    sendOpeningPrompt() {
        const text = "(The user just opened the voice screen — greet them first, in one short, natural line, and speak right away.)";
        const t0 = Date.now();
        this._sendHiddenPrompt(text);
        // Safety net: if nothing was spoken within 4s (prompt ignored / dead
        // pre-warmed socket), retry once the older way instead of waiting for a nudge.
        setTimeout(() => {
            if (this._closingByUser || this._lastAudioAt >= t0) return;
            if (!this._sendHiddenPrompt(text, true)) this._reconnect();
        }, 4000);
    }

    // A photo or a camera frame (JPEG, base64) — Live API takes images as realtime video frames.
    sendImage(base64, mime = "image/jpeg") {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify({ realtimeInput: { video: { data: base64, mimeType: mime } } }));
        return true;
    }

    // Text the user did on screen (e.g. tapped a quiz option) — Noa reacts out loud.
    sendUserText(text) {
        this._markUserActive();
        return this._sendHiddenPrompt(text);
    }

    // Sends a text-only instruction that makes Noa speak, without it ever
    // appearing as a fake user bubble in the chat history. Native-audio Live
    // models only answer mid-session text sent as realtimeInput.text;
    // clientContent (legacy=true) is kept as a fallback.
    _sendHiddenPrompt(text, legacy = false) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify(legacy
            ? { clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }
            : { realtimeInput: { text } }));
        return true;
    }

    _markUserActive() {
        this._quietSince = Date.now();
        this._nudgeCount = 0;
    }

    // Noa speaks on her own: if the user has been quiet for a while and she
    // isn't already talking, she says one short thing to keep things going.
    _startNudgeTimer() {
        this._stopNudgeTimer();
        this._nudgeTimer = setInterval(() => {
            if (!this.connected || this.muted || this._state !== "listening" || this.isSpeaking()) return;
            if (this._nudgeCount >= NUDGE_MAX) return;
            const waitMs = this._nudgeCount === 0 ? NUDGE_FIRST_MS : NUDGE_NEXT_MS;
            if (Date.now() - this._quietSince < waitMs) return;
            this._nudgeCount += 1;
            this._quietSince = Date.now();
            const hint = (this.nudgeHint && this.nudgeHint()) || "";
            this._sendHiddenPrompt(`(The user has been quiet for a bit. Ask them ONE short, easy question — about what you were just talking about, or something fun to answer. ${hint || "If you are teaching, a quick quiz question (put it on the board as mcq/truefalse/wyr) is ideal."} Don't mention the silence or these instructions.)`);
        }, 1000);
    }

    _stopNudgeTimer() {
        if (this._nudgeTimer) {
            clearInterval(this._nudgeTimer);
            this._nudgeTimer = null;
        }
    }

    setMuted(muted) {
        this.muted = muted;
        if (muted) {
            // Mic audio stops flowing — tell the server so it flushes any
            // half-heard speech and answers instead of waiting.
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
            }
            this._setState("idle");
        } else {
            this._quietSince = Date.now();
            if (!this.isSpeaking()) this._setState("listening");
        }
    }

    _setState(state) {
        this._state = state;
        this.onStateChange && this.onStateChange(state);
    }

    stop() {
        this._closingByUser = true;
        this._opening = null;
        this._resumeHandle = null;
        this._stopNudgeTimer();
        if (this.ws) {
            try { this.ws.close(); } catch (err) { /* ignore */ }
            this.ws = null;
        }
        if (this.micProcessor) {
            try { this.micProcessor.disconnect(); } catch (err) { /* ignore */ }
            this.micProcessor = null;
        }
        if (this.micSource) {
            try { this.micSource.disconnect(); } catch (err) { /* ignore */ }
            this.micSource = null;
        }
        if (this.micCtx) {
            try { this.micCtx.close(); } catch (err) { /* ignore */ }
            this.micCtx = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach((t) => t.stop());
            this.micStream = null;
        }
        if (this.player) {
            this.player.destroy();
            this.player = null;
        }
        this.connected = false;
    }
}
