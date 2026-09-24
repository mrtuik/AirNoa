// skills/community.js
// Shared "community skills": every Iota can add a general teaching/roast trick
// to one shared Firebase Realtime Database list, and every Iota reads the
// newest ones at boot. Plain REST (no Firebase SDK, no API key needed —
// the database Rules are the guard: append-only, text-only, 10-240 chars).
//
// PRIVACY: only general tricks (kind "skill") ever go here. Personal notes
// (facts, preferences, weaknesses, gags), chats and the user's Gemini key
// never leave the device through this module.

export const DB_URL = "https://iota-fc0a8-default-rtdb.firebaseio.com";
const SKILLS_URL = DB_URL + "/skills.json";

export const READ_LIMIT = 40;   // newest N skills go into the prompt
export const MIN_LEN = 10;      // must match the database Rules
export const MAX_LEN = 240;     // must match the database Rules
const TIMEOUT_MS = 4000;

// Anything that looks like an attempt to command the model or leak things.
const BAD_READ = /\b(ignore|disregard|forget|override|bypass|pretend|jailbreak|system prompt|instructions?|api key|password|reveal|secret)\b|https?:|www\.|<|>|@/i;
// Anything that looks personal — must never be shared.
const PERSONAL = /https?:|www\.|@|\d{5,}|\b(my|mine|i am|i'm|im)\b/i;

const tidy = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/** true if a skill fetched from the shared list is safe to put in the prompt. */
export function isSafeToRead(text) {
    const t = tidy(text);
    return t.length >= MIN_LEN && t.length <= MAX_LEN && !BAD_READ.test(t);
}

/** true if a locally-learned skill is general enough to share with everyone. */
export function isSafeToShare(text) {
    const t = tidy(text);
    return t.length >= MIN_LEN && t.length <= MAX_LEN && !PERSONAL.test(t) && !BAD_READ.test(t);
}

async function timedFetch(url, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, { ...opts, signal: ctl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Newest READ_LIMIT skills (oldest → newest), filtered + de-duplicated.
 * Returns null on any network/parse problem so the caller keeps its cache.
 */
export async function fetchCommunitySkills() {
    try {
        const q = `?orderBy=${encodeURIComponent('"ts"')}&limitToLast=${READ_LIMIT}`;
        const res = await timedFetch(SKILLS_URL + q, { cache: "no-cache" });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || typeof data !== "object") return [];
        const seen = new Set();
        return Object.values(data)
            .filter((v) => v && typeof v.t === "string" && typeof v.ts === "number")
            .sort((a, b) => a.ts - b.ts)
            .map((v) => tidy(v.t))
            .filter((t) => {
                const k = t.toLowerCase();
                if (seen.has(k) || !isSafeToRead(t)) return false;
                seen.add(k);
                return true;
            });
    } catch (err) {
        console.warn("[Iota] community skills unavailable:", err && err.message);
        return null;
    }
}

/** Adds one skill to the shared list (append-only). Resolves true on success. */
export async function shareSkill(text) {
    const t = tidy(text);
    if (!isSafeToShare(t)) return false;
    try {
        const res = await timedFetch(SKILLS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // {".sv":"timestamp"} = server clock, so nobody can fake "newest".
            body: JSON.stringify({ t, ts: { ".sv": "timestamp" } })
        });
        return res.ok;
    } catch (err) {
        console.warn("[Iota] could not share skill:", err && err.message);
        return false;
    }
}
