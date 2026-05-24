/**
 * @zakkster/lite-persist — signal ↔ Storage
 *
 * Synchronizes a lite-signal state with localStorage, sessionStorage, or any
 * custom adapter implementing {getItem, setItem, removeItem}.
 *
 * Architecture
 * ------------
 * `debounce(sig, ms)` from @zakkster/lite-debounce is a *reactive combinator*:
 * it returns a read-only derived value that mirrors `sig`, trailing-debounced.
 * We `watch` that derived value and write to storage on each settled change.
 * A burst of `sig.set()` calls inside the quiet window collapses into exactly
 * one storage write carrying the most recent value.
 *
 *     sig.set() × N   ──►  debounce (coalesce)  ──►  watch  ──►  1 storage write
 *
 * Allocation profile
 * ------------------
 * Per `sig.set()` in steady state the only work on the synchronous path is the
 * debounce effect (zero-alloc, sliding-timestamp timer) — `watch` and the
 * serialize()/Storage write happen once per quiet window, off the hot path.
 * Measured: < 4 KB heap growth across 100,000 mutations (~0.04 B/mutation),
 * i.e. allocation-free within measurement noise. See bench/bench.js.
 *
 * @template T
 * @param {import("@zakkster/lite-signal").Signal<T>} sig  Source signal to track.
 * @param {string} key  Storage key.
 * @param {object} [options]
 * @param {Storage} [options.storage=localStorage]  Backend. Any object with
 *        getItem/setItem/removeItem. Defaults to localStorage when available.
 * @param {number} [options.debounce=50]  Quiet-window length in ms. 0 → microtask.
 * @param {boolean} [options.syncTabs=true]  Cross-tab sync via the `storage`
 *        event. Only fires for real Web Storage backends (localStorage /
 *        sessionStorage); custom adapters do not emit storage events.
 * @param {boolean} [options.flushOnDispose=false]  When true, persist whatever
 *        value is still inside the quiet window at dispose() time instead of
 *        discarding it. Recommended for save-on-unmount flows. Default false:
 *        dispose() cancels the pending write (matches the underlying debounce).
 * @param {(value: T) => string} [options.serialize=JSON.stringify]  Encoder.
 * @param {(str: string) => T} [options.deserialize=JSON.parse]  Decoder.
 * @returns {() => void}  Idempotent dispose function: stops watching, removes
 *          the storage listener, and (optionally) commits the pending value.
 */
import { watch } from "@zakkster/lite-signal";
import { debounce } from "@zakkster/lite-debounce";

export function persist(sig, key, options = {}) {
    const storage =
        options.storage ||
        (typeof localStorage !== "undefined" ? localStorage : null);

    // No storage available (Worker / SSR with no adapter): inert binding so
    // calling code never has to branch on environment.
    if (!storage) {
        console.warn(`[lite-persist] No storage available for key "${key}"; persistence disabled.`);
        return () => {};
    }

    const ms = options.debounce !== undefined ? options.debounce : 50;
    const syncTabs = options.syncTabs !== false;
    const flushOnDispose = options.flushOnDispose === true;
    const serialize = options.serialize || JSON.stringify;
    const deserialize = options.deserialize || JSON.parse;

    // Last string actually committed to storage (null === "removed").
    // Value-level dedupe is identity-independent, so it (1) breaks the cross-tab
    // echo loop for object/array values — where Object.is never dedupes equal
    // content with a fresh reference — and (2) suppresses redundant writes in
    // general. Primed from the boot read so the first settled emission of the
    // restored value is not written straight back out.
    let lastSerialized;

    // ── 1. Boot read (synchronous, before watch so it cannot trigger a write) ──
    try {
        const stored = storage.getItem(key);
        lastSerialized = stored; // string | null
        if (stored !== null) sig.set(deserialize(stored));
    } catch (err) {
        lastSerialized = undefined; // unknown; first real write will commit
        console.warn(`[lite-persist] Failed to initialize key "${key}":`, err);
    }

    // Single serialize per settled value; dedupe before crossing into Storage.
    const write = (val) => {
        let s;
        try {
            s = val === undefined ? null : serialize(val);
        } catch (err) {
            console.warn(`[lite-persist] Failed to serialize key "${key}":`, err);
            return;
        }
        if (s === lastSerialized) return; // echo or redundant write
        lastSerialized = s;
        try {
            if (s === null) storage.removeItem(key);
            else storage.setItem(key, s);
        } catch (err) {
            console.warn(`[lite-persist] Failed to save key "${key}":`, err);
        }
    };

    // ── 2. Reactive debounced mirror + observer. `sig` and `debounced` are both
    //       read functions, so they pass directly as watch sources — no wrapper. ──
    const debounced = debounce(sig, ms);
    const stopWatch = watch(debounced, write);

    // ── 3. Cross-tab syncing ──
    let onStorage = null;
    if (syncTabs && typeof window !== "undefined") {
        onStorage = (e) => {
            if (e.key !== key || e.storageArea !== storage) return;
            try {
                // Prime the dedupe with the incoming string BEFORE setting the
                // signal: the eventual debounced re-emission of this same value
                // then matches lastSerialized and skips the write-back. Assumes
                // serialize∘deserialize is idempotent on transported strings
                // (true for the default JSON codec).
                lastSerialized = e.newValue; // string | null
                const nextVal = e.newValue === null ? undefined : deserialize(e.newValue);
                sig.set(nextVal);
            } catch (err) {
                console.warn(`[lite-persist] Cross-tab sync failed for key "${key}":`, err);
            }
        };
        window.addEventListener("storage", onStorage);
    }

    // ── 4. Teardown (idempotent) ──
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        stopWatch();
        // Optionally commit a value still inside the quiet window before the
        // debounce timer is cancelled. No-op (deduped) when nothing is pending.
        if (flushOnDispose) write(sig.peek());
        debounced.dispose();
        if (onStorage) window.removeEventListener("storage", onStorage);
    };
}
