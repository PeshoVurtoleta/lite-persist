// zero-gc.test.js
// Hot-path allocation contract: sig.set() during the coalescing window must
// retain ~zero bytes per call. The library's headline promise: a burst of N
// signal mutations costs no per-mutation heap (the debounce timer slides; the
// serialize chain + storage write happen once per settled window, OFF the
// hot path).
//
// User's bench (bench/bench-results.json, Node 23, MacBook) shows 8 bytes
// total over 100k sets -- essentially zero per mutation. Our threshold here
// is loose enough to absorb sandbox V8 housekeeping noise while still
// decisively catching a regression: a regression that allocated, say, a fresh
// {key, value} log object per set (~80 B with V8 minimal-object overhead)
// would land at 80 B/op, well past 5 B/op.
//
// Skips automatically without --expose-gc. min-of-3 to absorb single-run V8
// jitter (same pattern as lite-raf and lite-element).
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { persist } from "../Persist.js";

const hasGc = typeof global !== "undefined" && typeof global.gc === "function";

class MemStorage {
    constructor() { this.map = new Map(); this.writes = 0; }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.writes++; this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
}

function runBurst(N) {
    const mem = new MemStorage();
    const sig = signal(0);
    // Long debounce: the entire burst stays inside the quiet window, so the
    // serialize-chain + storage.setItem path is NEVER walked. We are measuring
    // pure sig.set() cost through lite-persist's debounce wrapper.
    const stop = persist(sig, "k", { storage: mem, debounce: 1_000_000 });

    // Warm V8 inlines, then measure.
    for (let i = 0; i < 5_000; i++) sig.set(i);
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) sig.set(i + 1_000_000);
    global.gc(); global.gc();
    const retained = process.memoryUsage().heapUsed - before;

    // Confirm the burst genuinely stayed inside the window (no writes).
    const writesDuringBurst = mem.writes;
    stop();
    return { retained, perSet: retained / N, writesDuringBurst };
}

function minOf3(N) {
    let best = Infinity;
    let bestRetained = 0;
    let writesDuringBurst = 0;
    for (let i = 0; i < 3; i++) {
        const r = runBurst(N);
        if (r.perSet < best) {
            best = r.perSet;
            bestRetained = r.retained;
            writesDuringBurst = r.writesDuringBurst;
        }
    }
    return { perSet: best, retained: bestRetained, writesDuringBurst };
}

test("zero-GC: 50k sig.set() during the quiet window retain < 5 B/set (min of 3)", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const { perSet, retained, writesDuringBurst } = minOf3(50_000);
    assert.equal(writesDuringBurst, 0, "burst stayed inside debounce window (sanity)");
    assert.ok(perSet < 5, `expected < 5 B/set retained; got ${perSet.toFixed(4)} B/set (${retained} B / 50000)`);
});

test("zero-GC: 100k sig.set() during the quiet window retain < 5 B/set (min of 3)", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const { perSet, retained, writesDuringBurst } = minOf3(100_000);
    assert.equal(writesDuringBurst, 0, "burst stayed inside debounce window (sanity)");
    assert.ok(perSet < 5, `expected < 5 B/set retained; got ${perSet.toFixed(4)} B/set (${retained} B / 100000)`);
});

test("zero-GC: coalescing guarantee -- N writes during one window settle to ONE storage write", async () => {
    // Not a memory test, but the structural twin: prove the *purpose* of the
    // zero-GC hot path. If this contract ever weakened, the perf claim
    // collapses regardless of allocation.
    const mem = new MemStorage();
    const sig = signal(0);
    const stop = persist(sig, "k", { storage: mem, debounce: 20 });
    for (let i = 0; i < 10_000; i++) sig.set(i);
    assert.equal(mem.writes, 0, "no writes during the burst");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mem.writes, 1, "exactly one write after the window settles");
    assert.equal(mem.getItem("k"), "9999", "carries the latest value");
    stop();
});
