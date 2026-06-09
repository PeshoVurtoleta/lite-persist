// @zakkster/lite-persist -- test suite (node:test)
//
// Timing: debounce is exercised with small real timers (the debounce package has
// its own deterministic timer tests; here we only need its coalescing behaviour).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { persist, idbStorage } from "../Persist.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 40; // comfortably past a 10ms quiet window

// -- in-memory synchronous Storage, counting writes/removes --
class MemStorage {
    constructor() {
        this.map = new Map();
        this.writes = 0;
        this.removes = 0;
    }
    getItem(k) {
        return this.map.has(k) ? this.map.get(k) : null;
    }
    setItem(k, v) {
        this.writes++;
        this.map.set(k, String(v));
    }
    removeItem(k) {
        this.removes++;
        this.map.delete(k);
    }
}

// -- in-memory asynchronous adapter (no IndexedDB needed) --
class AsyncMem {
    constructor(seed) {
        this.map = new Map(seed ? Object.entries(seed) : []);
    }
    async getItem(k) {
        await delay(1);
        return this.map.has(k) ? this.map.get(k) : null;
    }
    async setItem(k, v) {
        await delay(1);
        this.map.set(k, String(v));
    }
    async removeItem(k) {
        await delay(1);
        this.map.delete(k);
    }
}

// -- mock window for cross-tab storage events --
function installWindow() {
    const listeners = new Set();
    global.window = {
        addEventListener: (t, fn) => {
            if (t === "storage") listeners.add(fn);
        },
        removeEventListener: (t, fn) => {
            if (t === "storage") listeners.delete(fn);
        },
    };
    return {
        fire: (detail) => {
            for (const fn of [...listeners]) fn(detail);
        },
        count: () => listeners.size,
        uninstall: () => {
            delete global.window;
        },
    };
}

test("boot restore (sync adapter)", () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ a: 7 }));
    const sig = signal({ a: 0 });
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    assert.deepEqual(sig(), { a: 7 }); // restored synchronously, before return
    stop();
});

test("coalesces a burst into one write", async () => {
    const mem = new MemStorage();
    const sig = signal(0);
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    sig.set(1);
    sig.set(2);
    sig.set(3);
    await delay(SETTLE);
    assert.equal(mem.writes, 1, "one storage write for the burst");
    assert.equal(mem.getItem("k"), "3", "carries the last value");
    stop();
});

test("primed dedupe: restored value is not written straight back", async () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ a: 1 }));
    const sig = signal({ a: 0 });
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    await delay(SETTLE);
    assert.equal(mem.writes, 0, "no echo write of the booted value");
    stop();
});

test("flush() commits the current value immediately", () => {
    const mem = new MemStorage();
    const sig = signal("a");
    const stop = persist(sig, "k", { storage: mem, debounce: 1000 });
    sig.set("b");
    assert.equal(mem.getItem("k"), null, "nothing written yet (long window)");
    stop.flush();
    assert.equal(mem.getItem("k"), JSON.stringify("b"), "flush wrote current value");
    stop();
});

test("flushOnDispose: true commits pending, default discards", async () => {
    // default: dispose before the window closes -> pending value never persisted
    const mem1 = new MemStorage();
    const sig1 = signal("x");
    const stop1 = persist(sig1, "k", { storage: mem1, debounce: 1000 });
    sig1.set("y");
    stop1();
    await delay(SETTLE);
    assert.equal(mem1.getItem("k"), null, "pending value discarded by default");

    // flushOnDispose:true -> committed at dispose
    const mem2 = new MemStorage();
    const sig2 = signal("x");
    const stop2 = persist(sig2, "k", { storage: mem2, debounce: 1000, flushOnDispose: true });
    sig2.set("y");
    stop2();
    assert.equal(mem2.getItem("k"), JSON.stringify("y"), "pending value committed");
});

test(".ready resolves for a sync adapter", async () => {
    const mem = new MemStorage();
    const stop = persist(signal(1), "k", { storage: mem });
    await stop.ready; // must not hang
    stop();
});

test("schema migration: old envelope is upgraded and re-persisted", async () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ __v: 1, data: { count: 5 } }));
    const sig = signal({ count: 0, label: "" });
    const stop = persist(sig, "k", {
        storage: mem,
        debounce: 10,
        version: 2,
        migrate: (data, from) => (from < 2 ? { ...data, label: "migrated" } : data),
    });
    assert.deepEqual(sig(), { count: 5, label: "migrated" }, "migrated value applied");
    // upgraded envelope written back immediately
    assert.deepEqual(JSON.parse(mem.getItem("k")), { __v: 2, data: { count: 5, label: "migrated" } });
    stop();
});

test("schema migration: legacy unversioned data is fromVersion 0", () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ count: 9 })); // raw, no envelope
    const seenFrom = [];
    const sig = signal({ count: 0 });
    const stop = persist(sig, "k", {
        storage: mem,
        debounce: 10,
        version: 1,
        migrate: (data, from) => {
            seenFrom.push(from);
            return data;
        },
    });
    assert.deepEqual(seenFrom, [0], "legacy data presented as v0");
    assert.deepEqual(sig(), { count: 9 });
    stop();
});

test("partialize writes a subset; merge restores non-persisted fields", async () => {
    const mem = new MemStorage();
    const pick = (s) => ({ a: s.a, b: s.b });

    const sig = signal({ a: 1, b: 2, token: "secret" });
    const stop = persist(sig, "k", { storage: mem, debounce: 10, partialize: pick });
    sig.set({ a: 9, b: 8, token: "secret2" });
    await delay(SETTLE);
    assert.deepEqual(JSON.parse(mem.getItem("k")), { a: 9, b: 8 }, "only allowlisted keys persisted");
    stop();

    // reload into a fresh signal carrying its own defaults
    const sig2 = signal({ a: 0, b: 0, token: "default" });
    const stop2 = persist(sig2, "k", { storage: mem, debounce: 10, partialize: pick });
    assert.deepEqual(sig2(), { a: 9, b: 8, token: "default" }, "subset merged over current defaults");
    stop2();
});

test("encode/decode round-trips through the stored string", async () => {
    const mem = new MemStorage();
    const encode = (s) => Buffer.from(s, "utf8").toString("base64");
    const decode = (s) => Buffer.from(s, "base64").toString("utf8");

    const sig = signal({ x: 1 });
    const stop = persist(sig, "k", { storage: mem, debounce: 10, encode, decode });
    sig.set({ x: 2 });
    await delay(SETTLE);
    const stored = mem.getItem("k");
    assert.throws(() => JSON.parse(stored), "stored form is encoded, not plain JSON");
    assert.equal(decode(stored), JSON.stringify({ x: 2 }));
    stop();

    const sig2 = signal({ x: 0 });
    const stop2 = persist(sig2, "k", { storage: mem, debounce: 10, encode, decode });
    assert.deepEqual(sig2(), { x: 2 }, "decoded on boot");
    stop2();
});

test("SSR / no storage: fully inert handle, no throw", async () => {
    // Node has no localStorage and we pass none -> inert path.
    const sig = signal({ a: 1 });
    const stop = persist(sig, "k");
    assert.equal(typeof stop, "function");
    assert.equal(typeof stop.flush, "function");
    assert.ok(stop.ready instanceof Promise);
    stop.flush(); // no-op
    await stop.ready; // resolved
    sig.set({ a: 2 }); // no observer attached; nothing happens
    stop();
});

test("onError sink replaces console.warn on serialize failure", async () => {
    const mem = new MemStorage();
    const errs = [];
    const sig = signal({ ok: true });
    const stop = persist(sig, "k", {
        storage: mem,
        debounce: 10,
        onError: (err, ctx) => errs.push(ctx),
    });
    const circular = {};
    circular.self = circular; // JSON.stringify throws
    sig.set(circular);
    await delay(SETTLE);
    assert.ok(errs.some((c) => /serialize/i.test(c)), "serialize failure routed to onError");
    stop();
});

test("async adapter: signal restored after .ready, writes persist", async () => {
    const store = new AsyncMem({ k: JSON.stringify({ v: 1 }) });
    const sig = signal(null);
    const stop = persist(sig, "k", { storage: store, syncTabs: false, debounce: 10 });
    assert.equal(sig(), null, "not restored synchronously for an async adapter");
    await stop.ready;
    assert.deepEqual(sig(), { v: 1 }, "restored after ready");
    sig.set({ v: 2 });
    await delay(SETTLE);
    assert.equal(store.map.get("k"), JSON.stringify({ v: 2 }), "async write landed");
    stop();
});

test("cross-tab: storage event updates signal without echo write-back", async () => {
    const win = installWindow();
    try {
        const mem = new MemStorage();
        const sig = signal({ a: 1 });
        const stop = persist(sig, "k", { storage: mem, debounce: 10 });
        sig.set({ a: 1 }); // identical -> deduped anyway
        await delay(SETTLE);
        const baselineWrites = mem.writes;

        win.fire({ key: "k", newValue: JSON.stringify({ a: 2 }), storageArea: mem });
        assert.deepEqual(sig(), { a: 2 }, "signal updated from another tab");
        await delay(SETTLE);
        assert.equal(mem.writes, baselineWrites, "no write-back of the echoed value");

        stop();
        assert.equal(win.count(), 0, "listener removed on dispose");
    } finally {
        win.uninstall();
    }
});

test("idbStorage: round-trips a value through IndexedDB", async () => {
    const store = idbStorage({ db: "lp-test", store: "kv" });

    const sig = signal({ n: 1 });
    const stop = persist(sig, "k", { storage: store, syncTabs: false, debounce: 10 });
    await stop.ready; // empty store -> sig keeps its initial value
    assert.deepEqual(sig(), { n: 1 });
    sig.set({ n: 42 });
    await delay(60);
    stop();

    // fresh handle reads the persisted value back
    const sig2 = signal(null);
    const stop2 = persist(sig2, "k", { storage: store, syncTabs: false, debounce: 10 });
    await stop2.ready;
    assert.deepEqual(sig2(), { n: 42 }, "value survived via IndexedDB");
    stop2();
});
