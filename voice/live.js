// voice/live.js
// Noa's voice engine: Gemini Live API over a raw WebSocket, native
// audio-to-audio. This is the ONLY voice engine in the app — there is no
// separate speech-to-text or text-to-speech call anywhere in this module
// or anywhere else in the codebase. Mic audio is streamed to Gemini as
// PCM16 @16kHz via realtimeInput.audio; Gemini's spoken reply comes back
// as PCM @24kHz and is played directly through the Web Audio API.
//
// This model name is Google's current native-audio Live API preview model.
// Google occasionally renames/retires "-preview-" models — if this one
// 404s, swap it for whatever the current live-preview native-audio model
// is in the Gemini API docs.
const LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";

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

// Simple nearest-neighbor resample down to 16kHz — good enough for speech
// input, and avoids pulling in a resampling library for this one step.
function downsampleTo16k(float32, inRate) {
    if (inRate === INPUT_SAMPLE_RATE) return float32;
    const ratio = inRate / INPUT_SAMPLE_RATE;
    const outLength = Math.round(float32.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        out[i] = float32[Math.min(float32.length - 1, Math.round(i * ratio))];
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
        this.onQueueEmpty = null;
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

        const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
        source.start(startAt);
        this.nextStartTime = startAt + buffer.duration;
        this.activeSources += 1;
        source.onended = () => {
            this.activeSources = Math.max(0, this.activeSources - 1);
            if (this.activeSources === 0 && this.onQueueEmpty) this.onQueueEmpty();
        };
    }

    // Barge-in: cut off whatever's queued/playing right now.
    stopAll() {
        this.nextStartTime = 0;
        this.activeSources = 0;
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

        // Hooks the app controller (AirC.html) assigns before calling start().
        this.onStateChange = null;        // (state: "connecting"|"listening"|"speaking"|"idle") => void
        this.onCaption = null;            // (text: string) => void — live partial of what Noa is saying
        this.onUserUtterance = null;      // (text: string) => void — finalized transcript of user speech
        this.onAssistantUtterance = null; // (text: string) => void — finalized transcript of Noa's reply
        this.onError = null;              // (message: string) => void
    }

    isSpeaking() {
        return Boolean(this.player && this.player.isPlaying());
    }

    /**
     * Opens the Live session and starts streaming mic audio.
     * @param {string} systemInstruction - persona + language system prompt
     */
    async start(systemInstruction) {
        const apiKey = this.config.get("gemini_api_key");
        if (!apiKey) {
            this.onError && this.onError("Add your Gemini API key in Configuration first.");
            throw new Error("no-key");
        }

        this._setState("connecting");
        this.player = new PCMPlayer();
        this._pendingUserText = "";
        this._pendingAssistantText = "";

        try {
            await this._openSocket(apiKey, systemInstruction);
            await this._startMic();
        } catch (err) {
            this.stop();
            this.onError && this.onError("Couldn't start the voice session. Check your Gemini API key and try again.");
            throw err;
        }

        this.connected = true;
        this._setState("listening");
    }

    _openSocket(apiKey, systemInstruction) {
        return new Promise((resolve, reject) => {
            const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
            const ws = new WebSocket(url);
            this.ws = ws;
            let settled = false;

            ws.onopen = () => {
                ws.send(JSON.stringify({
                    setup: {
                        model: `models/${LIVE_MODEL}`,
                        generationConfig: { responseModalities: ["AUDIO"] },
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        // Transcripts drive the on-screen captions and the
                        // chat-history log — no separate STT call needed.
                        inputAudioTranscription: {},
                        outputAudioTranscription: {}
                    }
                }));
            };

            ws.onmessage = async (event) => {
                let payload = event.data;
                if (payload instanceof Blob) payload = await payload.text();
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
                this.onError && this.onError("Voice connection hiccuped.");
            };

            ws.onclose = () => {
                const wasConnected = this.connected;
                this.connected = false;
                if (!settled) {
                    settled = true;
                    reject(new Error("Gemini Live connection closed before setup completed."));
                } else if (wasConnected) {
                    this._setState("idle");
                }
            };
        });
    }

    _handleServerMessage(msg) {
        const serverContent = msg.serverContent;
        if (!serverContent) return;

        if (serverContent.interrupted) {
            // The user started talking over Noa — stop playback immediately
            // (barge-in), same as a real conversation.
            this.player && this.player.stopAll();
            if (!this.muted) this._setState("listening");
        }

        if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
            this._pendingUserText += serverContent.inputTranscription.text;
        }
        if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
            this._pendingAssistantText += serverContent.outputTranscription.text;
            this.onCaption && this.onCaption(this._pendingAssistantText);
        }

        const parts = serverContent.modelTurn && serverContent.modelTurn.parts;
        if (Array.isArray(parts)) {
            parts.forEach((part) => {
                if (part.inlineData && part.inlineData.data) {
                    this._setState("speaking");
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
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            clientContent: {
                turns: [{ role: "user", parts: [{ text: "(The user just opened the app — greet them first, briefly.)" }] }],
                turnComplete: true
            }
        }));
    }

    setMuted(muted) {
        this.muted = muted;
        if (muted) this._setState("idle");
        else if (!this.isSpeaking()) this._setState("listening");
    }

    _setState(state) {
        this.onStateChange && this.onStateChange(state);
    }

    stop() {
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
