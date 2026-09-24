// brain/brain.js
// Iota Brain Module
// Owns: Gemini text generation for the typed chat on the home screen,
// persona-driven system prompt, and that chat's in-memory history.
//
// Live voice conversations (the avatar screen) do NOT go through this
// module — they run entirely through voice/live.js, which streams audio
// straight to/from the Gemini Live API. This module exists only for the
// text composer, where there's no live audio session to lean on.

import { languageSpeakingInstruction } from "../config/config.js";
import { PERSONA_PROMPTS, DEFAULT_PERSONA } from "../persona/personas.js";

const MAX_HISTORY_TURNS = 14; // ~10-15 recent turns, in-memory only (session, not persisted)
// gemini-2.0-flash was shut down (Jun 1, 2026). 3.8 Flash thinks by default,
// so keep thinking at "low" for fast, short chat replies.
const TEXT_MODEL = "gemini-3.8-flash";

function buildSystemPrompt(personaKey, spokenLanguageLabel) {
    const persona = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS[DEFAULT_PERSONA];
    return `PRIORITY RULE — LISTEN FIRST: the user's newest message is what you answer next, exactly what it asks, nothing else. A new or rephrased question is a new topic — answer THAT, don't drift back to a related idea from earlier in the chat and don't answer a nearby topic instead of the one actually asked. If the newest message is only a bare greeting, greet back in one short line and ask what they want.

${persona}

You are Iota. You're texting with the user, not writing an essay.
Hard rules:
- Never say "As an AI..." or use generic assistant phrasing.
- Keep replies short and natural — 1-3 sentences, like a real message.
- No stage directions, no asterisks, no emoji spam.
- Respond in ${spokenLanguageLabel}. This means: write everything in plain Roman/English alphabet letters, never in Devanagari or Bengali script, unless the user explicitly asks to switch.`;
}

export class IotaBrain {
    /**
     * @param {IotaConfig} config
     */
    constructor(config) {
        this.config = config;
        this.history = []; // { role: "user"|"assistant", content: string }
    }

    resetSession() {
        this.history = [];
    }

    /**
     * Change the active persona (Teacher / Mother / Girlfriend / etc.).
     * Persisted via config, which is backed by IndexedDB.
     */
    setPersona(persona) {
        this.config.set("persona", persona);
        this.config.save();
        return this.config.get("persona");
    }

    getPersona() {
        return this.config.get("persona") || DEFAULT_PERSONA;
    }

    /**
     * Rehydrate the in-memory conversation from a stored session so an old
     * conversation can be continued with context.
     */
    loadHistory(messages) {
        // Old attachments aren't re-sent to Gemini after a reload — they
        // become a short text note so the conversation still makes sense.
        this.history = (messages || [])
            .filter((m) => m && (m.role === "user" || m.role === "assistant") && (m.content || (m.attachments && m.attachments.length)))
            .map((m) => {
                const note = (m.attachments || []).map((a) => `[${a.kind === "image" ? "photo" : "file"}: ${a.name}]`).join(" ");
                return { role: m.role, content: [note, m.content].filter(Boolean).join(" ") };
            });
    }

    _pushHistory(role, content, attachments) {
        const entry = { role, content };
        if (attachments && attachments.length) entry.attachments = attachments;
        this.history.push(entry);
        const maxMessages = MAX_HISTORY_TURNS * 2;
        if (this.history.length > maxMessages) {
            this.history = this.history.slice(this.history.length - maxMessages);
        }
    }

    /**
     * First line Iota "says" when a fresh conversation opens.
     */
    async openingLine() {
        const text = "Hey! I'm here — what's going on with you today?";
        this._pushHistory("assistant", text);
        return { type: "normal", text };
    }

    /**
     * Generate a response to typed user text via the Gemini text API.
     * @param {string} userText
     * @param {Array} attachments  [{ kind: "image"|"pdf"|"text", name, mime, base64?, text? }]
     */
    async respond(userText, attachments = []) {
        this._pushHistory("user", userText, attachments);
        try {
            const text = await this._generate();
            this._pushHistory("assistant", text);
            return { type: "normal", text };
        } catch (err) {
            console.error("[IotaBrain] Generation failed.", err);
            const fallback = "Internet's being dramatic. Give me a second.";
            this._pushHistory("assistant", fallback);
            return { type: "fallback", text: fallback, error: err };
        }
    }

    _partsFor(m, includeData) {
        const parts = [];
        for (const a of m.attachments || []) {
            if (!includeData) { parts.push({ text: `[Earlier attachment: ${a.name}]` }); continue; }
            if (a.kind === "text") parts.push({ text: `[Attached file: ${a.name}]\n${a.text}` });
            else parts.push({ inlineData: { mimeType: a.mime, data: a.base64 } });
        }
        const text = m.content || (m.attachments && m.attachments.length ? "Take a look at what I just sent." : "");
        if (text) parts.push({ text });
        return parts;
    }

    async _generate() {
        const apiKey = this.config.get("gemini_api_key");
        if (!apiKey) {
            throw new Error("Gemini is not configured.");
        }

        const systemPrompt = buildSystemPrompt(this.getPersona(), languageSpeakingInstruction(this.config.get("language")));
        // Only the 3 most recent messages that carry attachments are sent as
        // real data; older ones become a text note to keep requests light.
        const withAtts = this.history.map((m, i) => (m.attachments ? i : -1)).filter((i) => i >= 0);
        const keep = new Set(withAtts.slice(-3));
        const contents = this.history.map((m, i) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: this._partsFor(m, keep.has(i))
        }));

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents,
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    generationConfig: { temperature: 0.9, maxOutputTokens: 600, thinkingConfig: { thinkingLevel: "low" } }
                })
            }
        );

        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`Gemini error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p.text || "").join("").trim();
        if (!text) throw new Error("Empty response from Gemini.");
        return text;
    }
}
