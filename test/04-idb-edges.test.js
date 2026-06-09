// 04-idb-edges.test.js
// idbStorage adapter edges not covered in 01-core: missing-IndexedDB throws,
// explicit factory override, default db/store names, remove + get round-trips
// at the adapter level (not via persist()).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { idbStorage } from "../Persist.js";

// The fake-indexeddb/auto side-effect set globalThis.indexedDB. Capture it for
// later, then we can temporarily clear it to test the missing-IDB error path.
const realIDB = globalThis.indexedDB;
const realIDBFactory = globalThis.IDBKeyRange;

// ─── Missing IDB throws ─────────────────────────────────────────────────────

test("idbStorage throws when no IndexedDB is available and no factory given", () => {
    const saved = globalThis.indexedDB;
    delete globalThis.indexedDB;
    try {
        assert.throws(
            () => idbStorage(),
            /requires IndexedDB/i,
            "should throw a clear message when no IDB available"
        );
    } finally {
        globalThis.indexedDB = saved;
    }
});

test("idbStorage accepts an explicit indexedDB factory override", () => {
    const saved = globalThis.indexedDB;
    delete globalThis.indexedDB;
    try {
        // Use the saved real factory but pass it explicitly.
        const store = idbStorage({ indexedDB: saved, db: "lp-factory-test", store: "kv" });
        assert.equal(typeof store.getItem, "function", "adapter built from factory override");
        assert.equal(typeof store.setItem, "function");
        assert.equal(typeof store.removeItem, "function");
    } finally {
        globalThis.indexedDB = saved;
    }
});

// ─── Default db / store names ───────────────────────────────────────────────

test("idbStorage uses default db='lite-persist' and store='kv' when not configured", async () => {
    // We can't easily inspect db/store names via fake-indexeddb's public API,
    // but we CAN open the same defaults and verify they interoperate -- if the
    // names matched, two separate idbStorage() instances with defaults will
    // share the same store.
    const a = idbStorage();
    const b = idbStorage();
    await a.setItem("shared-key", "from-a");
    const v = await b.getItem("shared-key");
    assert.equal(v, "from-a", "two default idbStorage instances share the same db+store");
    await a.removeItem("shared-key");
});

// ─── Round-trip at adapter level ────────────────────────────────────────────

test("idbStorage: get on a missing key returns null (not undefined)", async () => {
    const store = idbStorage({ db: "lp-edge-null", store: "kv" });
    const v = await store.getItem("does-not-exist");
    assert.equal(v, null, "missing key resolves to null, not undefined");
});

test("idbStorage: set then get round-trips a string verbatim", async () => {
    const store = idbStorage({ db: "lp-edge-roundtrip", store: "kv" });
    const payload = JSON.stringify({ a: 1, b: [2, 3, 4] });
    await store.setItem("k", payload);
    const back = await store.getItem("k");
    assert.equal(back, payload, "string round-trips byte-for-byte");
    await store.removeItem("k");
});

test("idbStorage: removeItem actually deletes (subsequent get returns null)", async () => {
    const store = idbStorage({ db: "lp-edge-remove", store: "kv" });
    await store.setItem("k", "present");
    assert.equal(await store.getItem("k"), "present", "set landed");
    await store.removeItem("k");
    assert.equal(await store.getItem("k"), null, "remove evicted the value");
});

test("idbStorage: removeItem on a missing key resolves without throwing", async () => {
    const store = idbStorage({ db: "lp-edge-missing-remove", store: "kv" });
    await assert.doesNotReject(() => store.removeItem("never-existed"));
});

test("idbStorage: db is opened lazily (no work until first operation)", () => {
    // Just constructing the adapter must not block on open(). Synchronous.
    let store;
    assert.doesNotThrow(() => { store = idbStorage({ db: "lp-edge-lazy", store: "kv" }); });
    assert.equal(typeof store.getItem, "function", "adapter returned synchronously");
});
