// 03-async-and-dispose.test.js
// Async write/read rejection routing, async-restore timing contract,
// dispose() + flush() idempotency, debounce: 0 (microtask) timing,
// syncTabs: false suppresses listener installation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { persist } from "../Persist.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 40;

class MemStorage {
    constructor() { this.map = new Map(); this.writes = 0; this.removes = 0; }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.writes++; this.map.set(k, String(v)); }
    removeItem(k) { this.removes++; this.map.delete(k); }
}

class AsyncRejectingWrite {
    constructor(seed) { this.map = new Map(seed ? Object.entries(seed) : []); this.rejectNextSet = false; }
    async getItem(k) { await delay(1); return this.map.has(k) ? this.map.get(k) : null; }
    async setItem(k, v) {
        await delay(1);
        if (this.rejectNextSet) { this.rejectNextSet = false; throw new Error("write failed"); }
        this.map.set(k, String(v));
    }
    async removeItem(k) { await delay(1); this.map.delete(k); }
}

class AsyncRejectingRead {
    async getItem() { await delay(1); throw new Error("read failed"); }
    async setItem() { await delay(1); }
    async removeItem() { await delay(1); }
}

// ─── Async rejection paths ──────────────────────────────────────────────────

test("async setItem rejection: error routed to onError, app keeps running", async () => {
    const store = new AsyncRejectingWrite();
    const errs = [];
    const sig = signal({ a: 1 });
    const stop = persist(sig, "k", {
        storage: store, syncTabs: false, debounce: 10,
        onError: (err, ctx) => errs.push({ msg: err.message, ctx }),
    });
    await stop.ready;
    store.rejectNextSet = true;
    sig.set({ a: 2 });
    await delay(SETTLE);
    // Give the rejected microtask one more turn to propagate to onError.
    await delay(20);
    assert.ok(errs.some((e) => /save/i.test(e.ctx) && /write failed/.test(e.msg)),
        `setItem rejection routed; got ${JSON.stringify(errs)}`);
    // Subsequent writes should still work (rejectNextSet was one-shot).
    sig.set({ a: 3 });
    await delay(SETTLE);
    assert.equal(store.map.get("k"), JSON.stringify({ a: 3 }), "next write landed normally");
    stop();
});

test("async getItem rejection at boot: onError fires, .ready still resolves, signal keeps initial", async () => {
    const store = new AsyncRejectingRead();
    const errs = [];
    const sig = signal({ initial: true });
    const stop = persist(sig, "k", {
        storage: store, syncTabs: false, debounce: 10,
        onError: (err, ctx) => errs.push(ctx),
    });
    // Critical: .ready must NOT hang on a boot read error.
    await stop.ready;
    assert.deepEqual(sig(), { initial: true }, "signal keeps its initial value after read failure");
    assert.ok(errs.some((c) => /initialize/i.test(c)), `read rejection routed; got ${JSON.stringify(errs)}`);
    stop();
});

test("async adapter: signal is NOT restored synchronously (only after .ready)", async () => {
    class SlowAsync {
        constructor(seed) { this.map = new Map(seed ? Object.entries(seed) : []); }
        async getItem(k) { await delay(5); return this.map.has(k) ? this.map.get(k) : null; }
        async setItem(k, v) { await delay(1); this.map.set(k, String(v)); }
        async removeItem(k) { await delay(1); this.map.delete(k); }
    }
    const store = new SlowAsync({ k: JSON.stringify({ v: 99 }) });
    const sig = signal({ v: 0 });
    const stop = persist(sig, "k", { storage: store, syncTabs: false, debounce: 10 });
    // Right after persist() returns, the boot read is still in flight.
    assert.deepEqual(sig(), { v: 0 }, "signal still has its initial value before .ready");
    await stop.ready;
    assert.deepEqual(sig(), { v: 99 }, "restored only after .ready resolves");
    stop();
});

// ─── Dispose / flush idempotency ────────────────────────────────────────────

test("dispose() is idempotent: calling twice (or three times) is safe", () => {
    const mem = new MemStorage();
    const stop = persist(signal(1), "k", { storage: mem, debounce: 10 });
    assert.doesNotThrow(() => { stop(); stop(); stop(); });
});

test("flush() after dispose() is a no-op (does not throw)", () => {
    const mem = new MemStorage();
    const sig = signal("a");
    const stop = persist(sig, "k", { storage: mem, debounce: 1000 });
    sig.set("b");
    stop();
    // flush() must be safe to call after dispose -- treat it as a no-op.
    const writesBefore = mem.writes;
    assert.doesNotThrow(() => stop.flush());
    assert.equal(mem.writes, writesBefore, "no extra write after dispose");
});

test("flush() on the inert (no-storage) handle is a no-op", async () => {
    // No localStorage in Node, no adapter passed -> inert path.
    const sig = signal({ a: 1 });
    const stop = persist(sig, "k");
    assert.doesNotThrow(() => stop.flush());
    await stop.ready;       // resolves immediately on inert
    assert.doesNotThrow(() => stop());
});

// ─── Debounce edge cases ────────────────────────────────────────────────────

test("debounce: 0 settles on a microtask (no setTimeout wait needed)", async () => {
    const mem = new MemStorage();
    const sig = signal(0);
    const stop = persist(sig, "k", { storage: mem, debounce: 0 });
    sig.set(1);
    sig.set(2);
    sig.set(3);
    // Yield ONLY a microtask. If debounce: 0 used setTimeout, this would be 0
    // writes; the docs promise microtask-tick timing.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(mem.writes, 1, "burst settled on microtask, single write");
    assert.equal(mem.getItem("k"), "3", "latest value committed");
    stop();
});

// ─── syncTabs gating ────────────────────────────────────────────────────────

test("syncTabs: false suppresses the storage-event listener installation", () => {
    const listeners = new Set();
    global.window = {
        addEventListener: (t, fn) => { if (t === "storage") listeners.add(fn); },
        removeEventListener: (t, fn) => { if (t === "storage") listeners.delete(fn); },
    };
    try {
        const mem = new MemStorage();
        const stop = persist(signal({a: 1}), "k", {
            storage: mem, debounce: 10, syncTabs: false,
        });
        assert.equal(listeners.size, 0, "no storage listener installed when syncTabs:false");
        stop();
    } finally {
        delete global.window;
    }
});

test("syncTabs: true with NO window (worker/SSR): does not throw, no listener attempted", () => {
    // Ensure window is gone.
    delete global.window;
    const mem = new MemStorage();
    // syncTabs defaults true, but no window -> the guard inside applyBoot
    // (`typeof window !== "undefined"`) must skip listener registration cleanly.
    assert.doesNotThrow(() => {
        const stop = persist(signal({a: 1}), "k", { storage: mem, debounce: 10 });
        stop();
    });
});

// ─── Cross-tab corner cases ─────────────────────────────────────────────────

test("cross-tab: newValue: null evicts via merge(undefined, current)", async () => {
    const listeners = new Set();
    global.window = {
        addEventListener: (t, fn) => { if (t === "storage") listeners.add(fn); },
        removeEventListener: (t, fn) => { if (t === "storage") listeners.delete(fn); },
    };
    try {
        const mem = new MemStorage();
        const sig = signal({a: 1});
        const stop = persist(sig, "k", { storage: mem, debounce: 10 });
        for (const fn of [...listeners]) {
            fn({ key: "k", newValue: null, storageArea: mem });
        }
        // Default merge with restored=undefined returns undefined -> signal set to undefined.
        assert.equal(sig(), undefined, "signal cleared on cross-tab eviction");
        stop();
    } finally {
        delete global.window;
    }
});

test("cross-tab: events for OTHER keys are ignored", async () => {
    const listeners = new Set();
    global.window = {
        addEventListener: (t, fn) => { if (t === "storage") listeners.add(fn); },
        removeEventListener: (t, fn) => { if (t === "storage") listeners.delete(fn); },
    };
    try {
        const mem = new MemStorage();
        const sig = signal({a: 1});
        const stop = persist(sig, "k", { storage: mem, debounce: 10 });
        for (const fn of [...listeners]) {
            fn({ key: "different-key", newValue: JSON.stringify({a: 999}), storageArea: mem });
        }
        assert.deepEqual(sig(), {a: 1}, "signal NOT touched by other-key event");
        stop();
    } finally {
        delete global.window;
    }
});

test("cross-tab: events from a DIFFERENT storageArea are ignored", async () => {
    const listeners = new Set();
    global.window = {
        addEventListener: (t, fn) => { if (t === "storage") listeners.add(fn); },
        removeEventListener: (t, fn) => { if (t === "storage") listeners.delete(fn); },
    };
    try {
        const ours = new MemStorage();
        const theirs = new MemStorage();
        const sig = signal({a: 1});
        const stop = persist(sig, "k", { storage: ours, debounce: 10 });
        for (const fn of [...listeners]) {
            fn({ key: "k", newValue: JSON.stringify({a: 999}), storageArea: theirs });
        }
        assert.deepEqual(sig(), {a: 1}, "events for the wrong storage area are ignored");
        stop();
    } finally {
        delete global.window;
    }
});
