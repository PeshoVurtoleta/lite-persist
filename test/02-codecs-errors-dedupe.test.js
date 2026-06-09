// 02-codecs-errors-dedupe.test.js
// Custom serialize/deserialize; (de)serialize and (en|de)code failure routing;
// consecutive identical writes deduped by stored string; sig.set(undefined)
// eviction; default vs custom merge.
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

// ─── Custom codecs ──────────────────────────────────────────────────────────

test("custom serialize/deserialize: lib uses them in place of JSON", async () => {
    const mem = new MemStorage();
    // Trivial codec: stash a sentinel that JSON.parse would choke on.
    const serialize = (v) => "VAL:" + v.x;
    const deserialize = (s) => ({ x: Number(s.slice(4)) });

    const sig = signal({ x: 0 });
    const stop = persist(sig, "k", { storage: mem, debounce: 10, serialize, deserialize });
    sig.set({ x: 7 });
    await delay(SETTLE);
    assert.equal(mem.getItem("k"), "VAL:7", "custom serialize produced the stored string");
    stop();

    const sig2 = signal({ x: 0 });
    const stop2 = persist(sig2, "k", { storage: mem, debounce: 10, serialize, deserialize });
    assert.deepEqual(sig2(), { x: 7 }, "custom deserialize parsed it back");
    stop2();
});

// ─── Error routing ──────────────────────────────────────────────────────────

test("deserialize failure on boot: onError fires, signal keeps its initial value", () => {
    const mem = new MemStorage();
    mem.map.set("k", "this is not JSON {[");
    const errs = [];
    const sig = signal({ initial: true });
    const stop = persist(sig, "k", {
        storage: mem, debounce: 10,
        onError: (err, ctx) => errs.push(ctx),
    });
    assert.deepEqual(sig(), { initial: true }, "signal kept its initial value");
    assert.ok(errs.some((c) => /initialize/i.test(c)), `boot error routed; got ${JSON.stringify(errs)}`);
    stop();
});

test("decode failure on boot: onError fires, signal keeps its initial value", () => {
    const mem = new MemStorage();
    mem.map.set("k", "stored");
    const errs = [];
    const sig = signal({ initial: true });
    const stop = persist(sig, "k", {
        storage: mem, debounce: 10,
        decode: () => { throw new Error("decode bomb"); },
        onError: (err, ctx) => errs.push(ctx),
    });
    assert.deepEqual(sig(), { initial: true }, "signal kept its initial value");
    assert.ok(errs.length >= 1, "decode error routed to onError");
    stop();
});

test("encode failure on write: onError fires, nothing committed to storage", async () => {
    const mem = new MemStorage();
    const errs = [];
    const sig = signal({ a: 1 });
    const stop = persist(sig, "k", {
        storage: mem, debounce: 10,
        encode: () => { throw new Error("encode bomb"); },
        onError: (err, ctx) => errs.push(ctx),
    });
    sig.set({ a: 2 });
    await delay(SETTLE);
    assert.equal(mem.writes, 0, "no write committed when encode threw");
    assert.ok(errs.some((c) => /serialize/i.test(c)), `encode failure routed via 'serialize' ctx; got ${JSON.stringify(errs)}`);
    stop();
});

// ─── Dedupe ─────────────────────────────────────────────────────────────────

test("consecutive identical writes are deduped by stored string", async () => {
    const mem = new MemStorage();
    const sig = signal({ x: 1 });
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    sig.set({ x: 2 });
    await delay(SETTLE);
    assert.equal(mem.writes, 1, "first change committed");
    // Now write the SAME value structurally. Different object identity, but
    // identical serialized form -> dedupe kicks in at the stored-string level.
    sig.set({ x: 2 });
    await delay(SETTLE);
    assert.equal(mem.writes, 1, "structurally identical value did not write again");
    sig.set({ x: 3 });
    await delay(SETTLE);
    assert.equal(mem.writes, 2, "different value did write");
    stop();
});

test("sig.set(undefined) evicts the key (removeItem)", async () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ a: 1 }));
    const sig = signal({ a: 1 });
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    sig.set(undefined);
    await delay(SETTLE);
    assert.equal(mem.removes, 1, "removeItem was called");
    assert.equal(mem.getItem("k"), null, "key is gone");
    stop();
});

test("sig.set(undefined) when key already absent: no spurious remove (dedupe by null)", async () => {
    const mem = new MemStorage();
    // No initial value in storage.
    const sig = signal(undefined);
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    sig.set(undefined);
    await delay(SETTLE);
    // lastSerialized was primed to null on boot (nothing stored). Re-emitting
    // undefined -> null -> matches -> no removeItem call.
    assert.equal(mem.removes, 0, "no remove when nothing to remove");
    stop();
});

// ─── Merge variants ─────────────────────────────────────────────────────────

test("default merge (no partialize) REPLACES current value with restored", () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ a: 99, b: 99 }));
    const sig = signal({ a: 1, b: 2, c: 3 });   // c is NOT in storage
    const stop = persist(sig, "k", { storage: mem, debounce: 10 });
    // Default merge is replace -> c is GONE after restore.
    assert.deepEqual(sig(), { a: 99, b: 99 }, "current value fully replaced (c dropped)");
    stop();
});

test("custom merge function: receives (restored, current) and its result is set", () => {
    const mem = new MemStorage();
    mem.map.set("k", JSON.stringify({ a: 10 }));
    const callArgs = [];
    const sig = signal({ a: 1, locked: true });
    const stop = persist(sig, "k", {
        storage: mem, debounce: 10,
        merge: (restored, current) => {
            callArgs.push([restored, current]);
            return { ...current, ...restored }; // shallow merge, current's `locked` survives
        },
    });
    assert.deepEqual(callArgs, [[{ a: 10 }, { a: 1, locked: true }]], "merge received both args");
    assert.deepEqual(sig(), { a: 10, locked: true }, "result of custom merge applied");
    stop();
});

test("custom merge runs on every cross-tab event too, not just boot", async () => {
    // Install a window stub
    const listeners = new Set();
    global.window = {
        addEventListener: (t, fn) => { if (t === "storage") listeners.add(fn); },
        removeEventListener: (t, fn) => { if (t === "storage") listeners.delete(fn); },
    };
    try {
        const mem = new MemStorage();
        let mergeCalls = 0;
        const sig = signal({ a: 1, ephemeral: "keep-me" });
        const stop = persist(sig, "k", {
            storage: mem, debounce: 10,
            merge: (restored, current) => {
                mergeCalls++;
                return { ...current, ...restored };
            },
        });
        mergeCalls = 0;  // discard the boot-time call
        // Simulate another tab writing to the same key.
        for (const fn of [...listeners]) {
            fn({ key: "k", newValue: JSON.stringify({ a: 42 }), storageArea: mem });
        }
        assert.equal(mergeCalls, 1, "custom merge invoked for cross-tab update");
        assert.deepEqual(sig(), { a: 42, ephemeral: "keep-me" }, "custom-merge result applied");
        stop();
    } finally {
        delete global.window;
    }
});
