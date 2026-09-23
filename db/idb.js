// db/idb.js
// Tiny promise-based wrapper around raw IndexedDB — no external library.
// Everything here is local to the browser: no network calls, works fully
// offline. Two object stores:
//   - "kv"       small settings blob (single row, id "settings")
//   - "sessions" one row per conversation session
// This is the only place in the app that talks to IndexedDB directly;
// config/config.js is the only module that imports this file.

const DB_NAME = "noa_db_v1";
const DB_VERSION = 1;

let dbPromise = null;

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
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function withStore(storeName, mode) {
    return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrap(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
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
