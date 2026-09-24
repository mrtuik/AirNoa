// voice/live.js
// Iota's voice engine: Gemini Live API over a raw WebSocket, native
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
// How long the server waits after you stop talking before Iota answers.
// Google recommends 500-800ms; lower = snappier but she may jump in during
// a natural pause. Try 400 if you want her even faster, 700 if she cuts in.
const VAD_SILENCE_MS = 500;
const VAD_PREFIX_PADDING_MS = 40;

// --- "Iota talks on her own" ------------------------------------------------
// If you go quiet for a while, she says something to keep the chat going.
// First nudge after NUDGE_FIRST_MS of silence, the next after NUDGE_NEXT_MS,
// and at most NUDGE_MAX in a row until you speak again.
const NUDGE_FIRST_MS = 1500;
const NUDGE_NEXT_MS = 3000;
const NUDGE_MAX = 6;

const BOARD_TOOL = {
    name: "show_on_board",
    description: "Show notes, a diagram, a picture or an interactive quiz on the whiteboard under you while you explain. Keep text short (phrases, not paragraphs) and put each idea in its own block. Write headings, labels and node names in simple English terms (Process, Function, Location...). Diagrams/drawings appear SMALL at the top right, so labels must be 1-3 words. Handwritten slide board that follows your speech. New topic/subtopic: call with a title (topic name) + its first point(s), never a title alone — starts a new slide. While you explain each next point aloud, call again with append:true and just that point (same slide, under the heading). Short lines. Colour a key word now and then: {r:x} {b:x} {g:x} {o:x} {p:x}.",
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
                        type: { type: "STRING", description: "One of: heading, text, list, steps, flow, note, code, compare, diagram, draw, image, mcq, truefalse, wyr, flashcard." },
                        text: { type: "STRING", description: "For heading, text, note, code." },
                        items: { type: "ARRAY", items: { type: "STRING" }, description: "For list and steps. Use 'Label: short value' so each item becomes its own card." },
                        nodes: { type: "ARRAY", items: { type: "STRING" }, description: "For flow and diagram: the boxes, in order (max 8)." },
                        kind: { type: "STRING", description: "For diagram: cycle (loop/circulation), hub (centre with spokes), or tree (root with branches)." },
                        center: { type: "STRING", description: "For diagram: the centre (hub/cycle) or root (tree) label." },
                        question: { type: "STRING", description: "For mcq, truefalse, wyr, flashcard." },
                        options: { type: "ARRAY", items: { type: "STRING" }, description: "For mcq (2-4 options) and wyr (exactly 2)." },
                        answer: { type: "STRING", description: "Correct option letter (A/B/C/D) or its exact text; for truefalse 'True' or 'False'; for flashcard the answer shown on tap. Omit for wyr." },
                        query: { type: "STRING", description: "For image: a specific topic to look up a picture for, e.g. 'Cerebrospinal fluid'." },
                        caption: { type: "STRING", description: "For image: one short line saying what it is." },
                        shapes: {
                            type: "ARRAY",
                            description: "For draw: simple shapes on a 0-100 grid (x right, y down), max 40. shape = circle (x,y,r) | ellipse (x,y = centre, w,h = radii) | rect (x,y = top-left, w,h) | line or arrow (x,y -> x2,y2) | text (x,y) | path (SVG path d). Optional text = short label (1-2 words) drawn at the shape's centre.",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    shape: { type: "STRING" }, x: { type: "NUMBER" }, y: { type: "NUMBER" }, r: { type: "NUMBER" },
                                    w: { type: "NUMBER" }, h: { type: "NUMBER" }, x2: { type: "NUMBER" }, y2: { type: "NUMBER" },
                                    text: { type: "STRING" }, d: { type: "STRING" }
                                },
                                required: ["shape"]
                            }
                        },
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

const CONTROL_TOOL = {
    name: "control_iota",
    description: "Control the Iota app itself. Use it when the user asks you to change something in the app (or when a change clearly helps them): 'switch to coach', 'change your voice to Puck', 'turn the camera on', 'mute my mic', 'start a new chat', 'roast me harder'. Not for teaching content — use show_on_board for that.",
    parameters: {
        type: "OBJECT",
        properties: {
            action: { type: "STRING", description: "One of: set_persona (value: friend|teacher|mother|girlfriend|boyfriend|coach), set_language (value: hindi|bengali|english), new_chat, camera (value: on|off|flip), mic (value: mute|unmute), board (value: clear|expand|collapse), roast_level (value: off|mild|medium|savage), open (value: settings|history), go_home." },
            value: { type: "STRING", description: "The value for the action, if it takes one." }
        },
        required: ["action"]
    }
};

const MEMORY_TOOL = {
    name: "iota_memory",
    description: "Your long-term memory. Quietly save useful things you learn (op=save) so you get better and more personal over time; forget notes when asked (op=forget); or (op=export) show your saved 'skill' notes so the owner can share them with every Iota. Kinds: fact (about the user: name, goals, exam, interests, habits), preference (how they like you to behave), weakness (topics or mistakes to revisit or roast), gag (a running joke that landed), skill (a general teaching or roast trick that worked, 10-200 chars, written as a generic tip with no names, no 'I/my', no details about this user or anyone else — skills may be shared with other Iotas, so keep it fully anonymous; everything else stays private on this device). Never save passwords, ID or payment numbers, health details, or private info about other people. Don't announce saving.",
    parameters: {
        type: "OBJECT",
        properties: {
            op: { type: "STRING", description: "save | forget | export" },
            kind: { type: "STRING", description: "fact | preference | weakness | gag | skill (for save)" },
            note: { type: "STRING", description: "One short sentence (for save), or text to match (for forget)." }
        },
        required: ["op"]
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
    // (Before, this only reset the counters, so Iota kept talking over you.)
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
    /** @param {IotaConfig} config */
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
        this._lastServerAt = 0;
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

        // Hooks the app controller (iota.html) assigns before calling start().
        this.onStateChange = null;        // (state: "connecting"|"listening"|"speaking"|"idle") => void
        this.onCaption = null;            // (text: string) => void — live partial of what Iota is saying
        this.onUserUtterance = null;      // (text: string) => void — finalized transcript of user speech
        this.onAssistantUtterance = null; // (text: string) => void — finalized transcript of Iota's reply
        this.onError = null;              // (message: string) => void
        this.onControl = null;            // (args) => string — Iota called control_iota
        this.onMemory = null;             // (args) => string — Iota called iota_memory
        this.onBoard = null;              // (args: {title?, blocks[]}) => void — Iota called show_on_board
    }

    // Where we are in the audio Iota is speaking right now (for caption sync).
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
            // 1-2s and used to run AFTER the socket, delaying Iota's first words.
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
            if (opts.greet) this.sendOpeningPrompt(typeof opts.greet === "string" ? opts.greet : undefined); // speak first the moment the socket is up
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
    // limit) — reopen silently, resuming the same session so Iota keeps context.
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
                        // Whiteboard tool: Iota calls this while explaining; the app
                        // renders it in the board under her avatar (IotaBoard.show).
                        tools: [{ functionDeclarations: [BOARD_TOOL, CONTROL_TOOL, MEMORY_TOOL] }],
                        // Faster end-of-speech detection so Iota answers as
                        // soon as you stop talking (server default waits
                        // ~800ms+). See VAD_SILENCE_MS at the top.
                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                disabled: false,
                                // LOW: room noise / speaker echo no longer cuts Iota off mid-sentence.
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
                    console.warn("[Iota] Live socket closed during setup:", ev.code, ev.reason);
                    reject(new Error(`Gemini Live closed before setup: ${ev.code} ${ev.reason || ""}`));
                } else if (wasConnected && !this._closingByUser) {
                    console.warn("[Iota] Live socket dropped:", ev.code, ev.reason);
                    this._reconnect();
                } else if (wasConnected) {
                    this._setState("idle");
                }
            };
        });
    }

    _handleServerMessage(msg) {
        this._lastServerAt = Date.now();
        if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
            this._resumeHandle = msg.sessionResumptionUpdate.newHandle;
        }
        if (msg.goAway) console.warn("[Iota] Server GoAway, will reconnect:", msg.goAway.timeLeft);

        if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
            const functionResponses = msg.toolCall.functionCalls.map((fc) => {
                let response = { result: "ok" };
                try {
                    if (fc.name === "show_on_board") {
                        const hint = this.onBoard && this.onBoard(fc.args || {});
                        if (typeof hint === "string" && hint) response = { result: hint };
                    }
                    else if (fc.name === "control_iota") response = { result: (this.onControl && this.onControl(fc.args || {})) || "done" };
                    else if (fc.name === "iota_memory") response = { result: (this.onMemory && this.onMemory(fc.args || {})) || "saved" };
                    else response = { error: `unknown function ${fc.name}` };
                } catch (err) {
                    console.warn("[Iota] show_on_board failed:", err);
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
            // The user started talking over Iota — stop playback immediately
            // (barge-in), same as a real conversation.
            this.player && this.player.stopAll();
            // Flush what Iota managed to say so the next turn's caption starts clean.
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
                    this._quietSince = Date.now(); // silence clock starts when Iota finishes talking
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
     * old "Iota always speaks first" behavior). Sent as a text-only turn, so
     * it does NOT go through audio transcription and never shows up as a
     * fake user chat bubble.
     */
    sendOpeningPrompt(text = "(The user just opened the voice screen. Open in a fresh, unique way — no standard greeting. One or two short lines, then wait.)") {
        const t0 = Date.now();
        this._sendHiddenPrompt(text);
        // Safety net ONLY for a dead pre-warmed socket: if the server sent nothing at all
        // within 4s, retry once (a slow-but-alive reply must not get a second greeting,
        // that caused repeated sentences).
        setTimeout(() => {
            if (this._closingByUser || this._lastServerAt >= t0) return;
            if (!this._sendHiddenPrompt(text, true)) this._reconnect();
        }, 4000);
    }

    // A photo or a camera frame (JPEG, base64) — Live API takes images as realtime video frames.
    sendImage(base64, mime = "image/jpeg") {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify({ realtimeInput: { video: { data: base64, mimeType: mime } } }));
        return true;
    }

    // Text the user did on screen (e.g. tapped a quiz option) — Iota reacts out loud.
    sendUserText(text) {
        this._markUserActive();
        return this._sendHiddenPrompt(text);
    }

    // Sends a text-only instruction that makes Iota speak, without it ever
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

    // Iota speaks on her own: if the user has been quiet for a while and she
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
            this._sendHiddenPrompt(`(The user is quiet. Don't leave silence — keep talking naturally: carry on with the next point of what you're teaching (use the board / a diagram when it helps), give a quick example, or ask them one short easy question. ${hint} Never repeat anything you already said — if your last line was a question, don't ask it again, give a tiny hint or move on to the next point. Don't mention the silence or these instructions.)`);
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
