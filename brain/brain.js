// brain/brain.js
// Noa Brain Module
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
const TEXT_MODEL = "gemini-2.0-flash";

function buildSystemPrompt(personaKey, spokenLanguageLabel) {
    const persona = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS[DEFAULT_PERSONA];
    return `${persona}

You are Noa. You're texting with the user, not writing an essay.
Hard rules:
- Never say "As an AI..." or use generic assistant phrasing.
- Keep replies short and natural — 1-3 sentences, like a real message.
- No stage directions, no asterisks, no emoji spam.
- Respond in ${spokenLanguageLabel}. This means: write everything in plain Roman/English alphabet letters, never in Devanagari or Bengali script, unless the user explicitly asks to switch.`;
}

export class NoaBrain {
    /**
     * @param {NoaConfig} config
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
        this.history = (messages || [])
            .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
            .map((m) => ({ role: m.role, content: m.content }));
    }

    _pushHistory(role, content) {
        this.history.push({ role, content });
        const maxMessages = MAX_HISTORY_TURNS * 2;
        if (this.history.length > maxMessages) {
            this.history = this.history.slice(this.history.length - maxMessages);
        }
    }

    /**
     * First line Noa "says" when a fresh conversation opens.
     */
    async openingLine() {
        const text = "Hey! I'm here — what's going on with you today?";
        this._pushHistory("assistant", text);
        return { type: "normal", text };
    }

    /**
     * Generate a response to typed user text via the Gemini text API.
     * @param {string} userText
     */
    async respond(userText) {
        this._pushHistory("user", userText);
        try {
            const text = await this._generate();
            this._pushHistory("assistant", text);
            return { type: "normal", text };
        } catch (err) {
            console.error("[NoaBrain] Generation failed.", err);
            const fallback = "Internet's being dramatic. Give me a second.";
            this._pushHistory("assistant", fallback);
            return { type: "fallback", text: fallback, error: err };
        }
    }

    async _generate() {
        const apiKey = this.config.get("gemini_api_key");
        if (!apiKey) {
            throw new Error("Gemini is not configured.");
        }

        const systemPrompt = buildSystemPrompt(this.getPersona(), languageSpeakingInstruction(this.config.get("language")));
        const contents = this.history.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }]
        }));

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents,
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    generationConfig: { temperature: 0.9, maxOutputTokens: 200 }
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
