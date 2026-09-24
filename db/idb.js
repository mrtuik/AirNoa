// db/idb.js
// Tiny promise-based wrapper around raw IndexedDB — no external library.
// Everything here is local to the browser: no network calls, works fully
// offline. Two object stores:
//   - "kv"       small settings blob (single row, id "settings")
//   - "sessions" one row per conversation session
// This is the only place in the app that talks to IndexedDB directly;
// config/config.js is the only module that imports this file.

const DB_NAME = "iota_db_v1";
const DB_VERSION = 1;

// Old name from before the rename (Noa/AirC -> iota). On first boot with an
// empty new DB, rows are copied over so saved chats and settings survive.
// The old DB is only read, never deleted.
const LEGACY_DB_NAME = "noa_db_v1";
const STORES = ["kv", "sessions"];
const MIGRATED_FLAG = "iota_legacy_db_migrated";

let dbPromise = null;

function flagGet() {
    try { return localStorage.getItem(MIGRATED_FLAG) === "1"; } catch (_) { return false; }
}
function flagSet() {
    try { localStorage.setItem(MIGRATED_FLAG, "1"); } catch (_) { /* ignore */ }
}

function wrap(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Opens the legacy DB only if it already exists. Aborting inside
// onupgradeneeded stops the browser from creating an empty one.
function openLegacy() {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open(LEGACY_DB_NAME); } catch (_) { resolve(null); return; }
        req.onupgradeneeded = () => {
            try { req.transaction.abort(); } catch (_) { /* ignore */ }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
    });
}

async function migrateLegacy(db) {
    if (flagGet()) return;
    try {
        // Never overwrite anything already saved in the new DB.
        const existing = await Promise.all(
            STORES.map((s) => wrap(db.transaction(s, "readonly").objectStore(s).count()))
        );
        if (existing.some((n) => n > 0)) { flagSet(); return; }

        const legacy = await openLegacy();
        if (!legacy) { flagSet(); return; }

        const rows = {};
        for (const s of STORES) {
            rows[s] = legacy.objectStoreNames.contains(s)
                ? await wrap(legacy.transaction(s, "readonly").objectStore(s).getAll())
                : [];
        }
        legacy.close();

        if (STORES.some((s) => rows[s].length)) {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORES, "readwrite");
                for (const s of STORES) {
                    const store = tx.objectStore(s);
                    rows[s].forEach((row) => store.put(row));
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        }
        flagSet();
    } catch (err) {
        // Not fatal: the app runs on the new DB and retries the copy next boot.
        console.warn("[idb] Legacy DB migration failed, will retry next boot.", err);
    }
}

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
            reject(new Error("IndexedDB is not available in this browser."));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "id" });
            if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
        };
        req.onsuccess = async () => {
            const db = req.result;
            await migrateLegacy(db);
            resolve(db);
        };
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function withStore(storeName, mode) {
    return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

export const idb = {
    async getAll(storeName) {
        const store = await withStore(storeName, "readonly");
        const result = await wrap(store.getAll());
        return result || [];
    },
    async get(storeName, id) {
        const store = await withStore(storeName, "readonly");
        return wrap(store.get(id));
    },
    async put(storeName, value) {
        const store = await withStore(storeName, "readwrite");
        await wrap(store.put(value));
        return value;
    },
    async delete(storeName, id) {
        const store = await withStore(storeName, "readwrite");
        return wrap(store.delete(id));
    },
    async clear(storeName) {
        const store = await withStore(storeName, "readwrite");
        return wrap(store.clear());
    }
};
