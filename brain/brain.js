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
import { BOARD_TOOL } from "../voice/live.js";

const MAX_HISTORY_TURNS = 14; // ~10-15 recent turns, in-memory only (session, not persisted)
// gemini-2.0-flash was shut down (Jun 1, 2026). 3.8 Flash thinks by default,
// so keep thinking at "low" for fast, short chat replies.
const TEXT_MODEL = "gemini-3.8-flash";

function buildSystemPrompt(personaKey, spokenLanguageLabel) {
    const persona = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS[DEFAULT_PERSONA];
    return `PRIORITY RULE — LISTEN FIRST: the user's newest message is what you answer next, exactly what it asks, nothing else. A new or rephrased question is a new topic — answer THAT, don't drift back to a related idea from earlier in the chat and don't answer a nearby topic instead of the one actually asked. If the newest message is only a bare greeting, greet back in one short line and ask what they want.

${persona}

VISUAL & DIAGRAM RULE: Whenever explaining ANY concept, topic, biology, science, anatomy, process, comparison, or steps, you MUST call the show_on_board tool. The tool call MUST ALWAYS include:
1. Structured bullet points ('list' or 'steps' block) with 2-4 points explaining the concept point-by-point.
2. A real-life everyday example ('note' block with 'Example: ...').
3. A diagram, chart, or image block floated at 40% on the right.
CRITICAL: The left side of the slide board must NEVER be left empty! Never send a diagram/image alone without bullet points and an example beside it.

TEACHING STYLE & WIT: Explain thoroughly point-by-point with clear real-life examples. If using Teacher persona, spice up your explanations with witty double-meaning puns, playful innuendos, cheeky teasing, and savage comebacks/roasts ('Mon ta kothay jacche haan?', 'Mathar CPU ki 2G cholche?'). Roast silly questions first with savage humor, then explain the real science cleanly with real-life examples!

FORMATTING RULES:
- Never say "As an AI..." or use generic assistant phrasing.
- Keep chat text replies natural and conversational (1-3 sentences) with savage/witty humor, while the detailed structured points, example, and diagram go on the slide board.
- Clean text only. Use **bold** for key concepts. DO NOT use raw color tags like {r:...}, {g:...}, {o:...}.
- No stage directions, no asterisks for actions, no emoji spam.
- Respond in ${spokenLanguageLabel}. This means: write everything in plain Roman/English alphabet letters, never in Devanagari or Bengali script, unless the user explicitly asks to switch.`;
}

export class IotaBrain {
    /**
     * @param {IotaConfig} config
     */
    constructor(config) {
        this.config = config;
        this.history = []; // { role: "user"|"assistant", content: string }
        this.onBoard = null; // (spec) => void
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
                    tools: [{ functionDeclarations: [BOARD_TOOL] }],
                    generationConfig: { temperature: 0.8, maxOutputTokens: 800, thinkingConfig: { thinkingLevel: "low" } }
                })
            }
        );

        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`Gemini error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const fcPart = parts.find((p) => p.functionCall);
        const textPart = parts.find((p) => p.text);

        if (fcPart && fcPart.functionCall) {
            const { name, args } = fcPart.functionCall;
            if (name === "show_on_board" && this.onBoard) {
                try { this.onBoard(args || {}); } catch (e) { console.warn("[IotaBrain] onBoard execution failed:", e); }
            }
            if (textPart && textPart.text && textPart.text.trim()) {
                return textPart.text.trim();
            }
            // Send follow-up toolResponse turn to get the companion's text response
            try {
                const followContents = [
                    ...contents,
                    { role: "model", parts: [fcPart] },
                    {
                        role: "user",
                        parts: [{
                            functionResponse: {
                                name: "show_on_board",
                                response: { result: "Slide with diagram/chart displayed on the board. Now give a short, friendly 1-2 sentence response explaining the main idea." }
                            }
                        }]
                    }
                ];
                const followRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: followContents,
                            systemInstruction: { parts: [{ text: systemPrompt }] },
                            generationConfig: { temperature: 0.8, maxOutputTokens: 500, thinkingConfig: { thinkingLevel: "low" } }
                        })
                    }
                );
                if (followRes.ok) {
                    const followData = await followRes.json();
                    const followParts = followData?.candidates?.[0]?.content?.parts || [];
                    const followText = followParts.map((p) => p.text || "").join("").trim();
                    if (followText) return followText;
                }
            } catch (followErr) {
                console.warn("[IotaBrain] Tool response follow-up failed:", followErr);
            }
        }

        const text = parts.map((p) => p.text || "").join("").trim();
        if (!text && fcPart) return "I've added the diagram and notes to the slide deck!";
        if (!text) throw new Error("Empty response from Gemini.");
        return text;
    }
}
