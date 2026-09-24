// config/config.js
// Iota Configuration Module
// Owns ALL persistent settings and conversation sessions. Nothing else in
// the app should touch storage directly. Backed by IndexedDB (see
// db/idb.js) instead of a remote database — everything is local-only and
// works fully offline, no network calls in this file.
//
// IndexedDB is asynchronous, but the rest of the app expects synchronous
// get()/set()/getSessions() calls (same shape as the old localStorage-based
// version). To keep that contract, init() loads everything into an
// in-memory cache once at boot; every read after that is served from the
// cache, and every write updates the cache immediately and persists to
// IndexedDB in the background (fire-and-forget).

import { idb } from "../db/idb.js";
import { DEFAULT_PERSONA } from "../persona/personas.js";
import { DEFAULT_VOICE } from "../voice/voices.js";

const SETTINGS_ROW_ID = "settings";
const SESSION_LIMIT = 40;

export const LANGUAGES = [
    { code: "hi-IN", label: "Hindi" },
    { code: "bn-IN", label: "Bengali" },
    { code: "en-US", label: "English" }
];

export function languageLabel(code) {
    const found = LANGUAGES.find((l) => l.code === code);
    return found ? found.label : "Hindi";
}

// Used only when building the LLM system prompt (see brain/brain.js) — same
// language choice as languageLabel(), but spelled out so the model replies
// in plain Roman/English letters (Hinglish/Benglish) instead of switching
// into native Devanagari/Bengali script.
export function languageSpeakingInstruction(code) {
    if (code === "hi-IN") {
        return 'Hinglish — Hindi words, but spelled out in plain Roman/English letters only (e.g. "Main accha hun, tum kaise ho"), never Devanagari script';
    }
    if (code === "bn-IN") {
        return 'Benglish — Bengali words, but spelled out in plain Roman/English letters only (e.g. "Ami bhalo achi, tumi kemon acho"), never Bengali script';
    }
    return languageLabel(code);
}

const DEFAULTS = {
    gemini_api_key: "",
    language: "hi-IN",
    persona: DEFAULT_PERSONA,
    live_voice_name: DEFAULT_VOICE,
    show_captions: false,
    community_learn: true,   // read general skills other Iotas shared
    community_share: false,  // opt-in: share this Iota's general skills
    onboarding_complete: false,
    microphone_setup_complete: false
};

export class IotaConfig {
    constructor() {
        this._data = { ...DEFAULTS };
        this._sessions = [];
        this._ready = false;
    }

    /**
     * Loads settings + sessions out of IndexedDB into the in-memory cache.
     * Must be awaited once before the rest of the app boots.
     */
    async init() {
        try {
            const row = await idb.get("kv", SETTINGS_ROW_ID);
            if (row && row.value) this._data = { ...DEFAULTS, ...row.value };
        } catch (err) {
            console.warn("[IotaConfig] Failed to load settings from IndexedDB, using defaults.", err);
        }
        try {
            const sessions = await idb.getAll("sessions");
            this._sessions = (sessions || []).sort((a, b) => b.ts - a.ts).slice(0, SESSION_LIMIT);
        } catch (err) {
            console.warn("[IotaConfig] Failed to load sessions from IndexedDB.", err);
        }
        this._ready = true;
        return this;
    }

    get(key) {
        return this._data[key];
    }

    set(key, value) {
        this._data[key] = value;
        return this._data[key];
    }

    setMany(obj) {
        Object.keys(obj).forEach((k) => this.set(k, obj[k]));
    }

    getAll() {
        return { ...this._data };
    }

    save() {
        idb.put("kv", { id: SETTINGS_ROW_ID, value: { ...this._data } }).catch((err) => {
            console.error("[IotaConfig] Failed to save settings to IndexedDB.", err);
        });
        return true;
    }

    reset() {
        this._data = { ...DEFAULTS };
        this.save();
    }

    // Whether Iota's brain (Gemini) is configured — the only hard
    // requirement to start using the app, for both typed chat and the
    // live voice screen (same API key powers both).
    canUseGemini() {
        return Boolean(this._data.gemini_api_key);
    }

    // ---------------------------------------------------------------------
    // Conversation sessions (chat history drawer)
    // ---------------------------------------------------------------------

    getSessions() {
        return this._sessions;
    }

    _persistSession(session) {
        idb.put("sessions", session).catch((err) => {
            console.warn("[IotaConfig] Failed to save session to IndexedDB.", err);
        });
    }

    createSession(title) {
        const session = {
            id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title: title || "New conversation",
            ts: Date.now(),
            messages: [],
            slides: []
        };
        this._sessions.unshift(session);
        this._sessions = this._sessions.slice(0, SESSION_LIMIT);
        this._persistSession(session);
        return session;
    }

    getSession(id) {
        return this._sessions.find((s) => s.id === id) || null;
    }

    getSlides(sessionId) {
        const session = this.getSession(sessionId);
        return (session && Array.isArray(session.slides)) ? session.slides : [];
    }

    saveSlide(sessionId, spec) {
        if (!sessionId || !spec) return;
        const session = this.getSession(sessionId);
        if (!session) return;
        if (!Array.isArray(session.slides)) session.slides = [];
        const rawBlocks = (spec.blocks || []).filter((b) => b && (typeof b === "object" || typeof b === "string"));
        const BAD = /report card|\broast/i;
        const blocks = rawBlocks.filter((b) => typeof b === "string" || (!["tags"].includes(b.type) && !(["heading", "note"].includes(b.type) && BAD.test(String(b.text || "")))));
        if (!blocks.length && !spec.title) return;

        if (spec.append && session.slides.length > 0) {
            const last = session.slides[session.slides.length - 1];
            if (!Array.isArray(last.blocks)) last.blocks = [];
            last.blocks.push(...blocks);
            if (spec.title && !last.title) last.title = spec.title;
            last.ts = Date.now();
        } else {
            session.slides.push({
                title: spec.title || `Slide ${session.slides.length + 1}`,
                blocks: spec.title && !blocks.some((b) => b.type === "heading") ? [{ type: "heading", text: spec.title }, ...blocks] : blocks,
                ts: Date.now()
            });
        }
        this._persistSession(session);
    }

    clearSlides(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) return;
        session.slides = [];
        this._persistSession(session);
    }

    appendMessage(sessionId, role, content, attachments) {
        const hasAtts = Array.isArray(attachments) && attachments.length > 0;
        if (!sessionId || (!content && !hasAtts)) return;
        const session = this._sessions.find((s) => s.id === sessionId);
        if (!session) return;
        const msg = { role, content: content || "", ts: Date.now() };
        if (hasAtts) msg.attachments = attachments; // images keep a preview, files keep just the name
        session.messages.push(msg);
        session.ts = Date.now();
        if (session.title === "New conversation" && role === "user") {
            session.title = (content || (hasAtts && attachments[0].name) || "Attachment").slice(0, 42);
        }
        this._sessions = [session, ...this._sessions.filter((s) => s.id !== sessionId)];
        this._persistSession(session);
    }

    deleteSession(id) {
        this._sessions = this._sessions.filter((s) => s.id !== id);
        idb.delete("sessions", id).catch(() => { /* ignore */ });
    }

    clearSessions() {
        this._sessions = [];
        idb.clear("sessions").catch(() => { /* ignore */ });
    }
}
