/**
 * @zakkster/lite-persist -- signal <-> Storage
 *
 * Synchronizes a lite-signal state with localStorage, sessionStorage, an
 * IndexedDB store (see idbStorage), or any custom adapter implementing
 * {getItem, setItem, removeItem}. Synchronous and asynchronous (Promise-
 * returning) adapters are both supported.
 *
 * Architecture
 * ------------
 * debounce(sig, ms) from @zakkster/lite-debounce is a reactive combinator: it
 * returns a read-only derived value that mirrors sig, trailing-debounced. We
 * watch that derived value and write to storage on each settled change. A burst
 * of sig.set() calls inside the quiet window collapses into exactly one storage
 * write carrying the most recent value.
 *
 *     sig.set() x N  -->  debounce (coalesce)  -->  watch  -->  1 storage write
 *
 * Read/write pipeline (each stage is opt-in and defaults to identity):
 *
 *     write:  value -> partialize -> {version envelope} -> serialize -> encode -> storage
 *     read:   storage -> decode -> deserialize -> {unwrap + migrate} -> merge -> sig
 *
 * Allocation profile
 * ------------------
 * Per sig.set() in steady state the only synchronous work is the debounce
 * effect (zero-alloc, sliding-timestamp timer). watch, the serialize chain, and
 * the storage write happen once per quiet window, off the hot path. Measured:
 * < 4 KB heap growth across 100,000 mutations (~0.04 B/mutation). See bench/.
 *
 * @template T
 * @param {import("@zakkster/lite-signal").Signal<T>} sig  Source signal to track.
 * @param {string} key  Storage key.
 * @param {object} [options]
 * @param {Storage|AsyncStorageLike} [options.storage=localStorage]  Backend. Any
 *        object with getItem/setItem/removeItem; methods may return Promises
 *        (e.g. idbStorage). Defaults to localStorage when available.
 * @param {number} [options.debounce=50]  Quiet-window length in ms. 0 -> microtask.
 * @param {boolean} [options.syncTabs=true]  Cross-tab sync via the storage event.
 *        Only fires for real Web Storage backends; async/custom adapters do not
 *        emit storage events.
 * @param {boolean} [options.flushOnDispose=false]  Commit the value still inside
 *        the quiet window at dispose() time instead of discarding it.
 * @param {(value: T) => string} [options.serialize=JSON.stringify]  Encoder.
 * @param {(str: string) => T} [options.deserialize=JSON.parse]  Decoder.
 * @param {(plain: string) => string} [options.encode]  Post-serialize transform
 *        applied to the stored string (encryption / compression hook).
 * @param {(stored: string) => string} [options.decode]  Inverse of encode,
 *        applied before deserialize.
 * @param {number} [options.version]  Schema version. When set, values are stored
 *        inside a {__v, data} envelope and migrate() runs whenever the stored
 *        version differs from this one.
 * @param {(data: any, fromVersion: number) => T} [options.migrate]  Upgrade a
 *        value persisted under an older version. Legacy unversioned data is
 *        presented as fromVersion 0. Defaults to identity.
 * @param {(state: T) => any} [options.partialize]  Project the value to the
 *        subset that should be persisted (allowlist). Defaults to identity.
 * @param {(restored: any, current: T) => T} [options.merge]  Combine the
 *        restored value with the signal's current value on boot and on cross-tab
 *        updates. Default: replace; with partialize, shallow-merge restored over
 *        current so non-persisted fields survive.
 * @param {(error: unknown, context: string) => void} [options.onError]  Error
 *        sink, replaces the default console.warn. Receives a short context tag.
 * @returns {PersistHandle}  Idempotent dispose function with two extras:
 *          .flush() commits the current value immediately, and .ready is a
 *          Promise that resolves once the (possibly async) boot read completes.
 *
 * @typedef {(() => void) & { flush(): void, ready: Promise<void> }} PersistHandle
 */
import { watch } from "@zakkster/lite-signal";
import { debounce } from "@zakkster/lite-debounce";

const isThenable = (x) => x != null && typeof x.then === "function";
const isPlainObject = (x) =>
    x != null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

export function persist(sig, key, options = {}) {
    const storage =
        options.storage ||
        (typeof localStorage !== "undefined" ? localStorage : null);

    const warn = (err, ctx) =>
        console.warn(`[lite-persist] ${ctx} for key "${key}":`, err);
    const onError = typeof options.onError === "function" ? options.onError : warn;

    // No storage available (Worker / SSR with no adapter): a fully inert handle
    // so calling code never has to branch on environment. Silent -- absence of
    // storage outside the browser is expected, not an error worth warning about.
    if (!storage) {
        const noop = () => {};
        noop.flush = () => {};
        noop.ready = Promise.resolve();
        return noop;
    }

    const ms = options.debounce !== undefined ? options.debounce : 50;
    const syncTabs = options.syncTabs !== false;
    const flushOnDispose = options.flushOnDispose === true;
    const serialize = options.serialize || JSON.stringify;
    const deserialize = options.deserialize || JSON.parse;
    const encode = typeof options.encode === "function" ? options.encode : (s) => s;
    const decode = typeof options.decode === "function" ? options.decode : (s) => s;
    const partialize = typeof options.partialize === "function" ? options.partialize : (v) => v;
    const version = options.version;
    const versioned = version !== undefined && version !== null;
    const migrate = typeof options.migrate === "function" ? options.migrate : (data) => data;

    // merge default: replace, unless an allowlist is in play -- then a shallow
    // merge keeps the fields partialize dropped (and breaks the cross-tab echo
    // loop, since re-projecting the merged value reproduces the stored subset).
    const hasPartialize = typeof options.partialize === "function";
    const merge =
        typeof options.merge === "function"
            ? options.merge
            : hasPartialize
              ? (restored, current) =>
                    isPlainObject(restored) && isPlainObject(current)
                        ? { ...current, ...restored }
                        : restored
              : (restored) => restored;

    // Last string actually committed to storage (null === removed). Value-level
    // dedupe is identity-independent, so it (1) breaks the cross-tab echo loop
    // for object/array values and (2) suppresses redundant writes in general.
    let lastSerialized;

    // value -> stored string | null
    const toStored = (val) => {
        if (val === undefined) return null;
        const picked = partialize(val);
        const payload = versioned ? { __v: version, data: picked } : picked;
        return encode(serialize(payload));
    };

    // stored string -> [data, fromVersion|null]  (unwrap only; no migration)
    const unwrap = (str) => {
        const decoded = deserialize(decode(str));
        if (!versioned) return [decoded, null];
        if (isPlainObject(decoded) && "__v" in decoded && "data" in decoded) {
            return [decoded.data, decoded.__v];
        }
        // Legacy value written before versioning was enabled -> treat as v0.
        return [decoded, 0];
    };

    // Single serialize per settled value; dedupe before crossing into Storage.
    const write = (val) => {
        let s;
        try {
            s = toStored(val);
        } catch (err) {
            onError(err, "Failed to serialize");
            return;
        }
        if (s === lastSerialized) return; // echo or redundant write
        lastSerialized = s;
        try {
            const r = s === null ? storage.removeItem(key) : storage.setItem(key, s);
            if (isThenable(r)) r.then(undefined, (err) => onError(err, "Failed to save"));
        } catch (err) {
            onError(err, "Failed to save");
        }
    };

    let stopWatch = null;
    let onStorage = null;
    let disposed = false;

    // Apply the boot read and start the reactive mirror. Runs synchronously for
    // sync adapters; on a microtask for async ones. Guarded so an early dispose()
    // (before an async read resolves) leaves nothing running.
    const applyBoot = (stored) => {
        if (disposed) return;

        lastSerialized = stored; // string | null -- primes the dedupe
        if (stored !== null) {
            try {
                let [data, fromVersion] = unwrap(stored);
                let migrated = false;
                if (versioned && fromVersion !== version) {
                    data = migrate(data, fromVersion);
                    migrated = true;
                }
                sig.set(merge(data, sig.peek()));
                // A migration changed the on-disk shape: re-persist the upgraded
                // form now (write() self-dedupes, so this is a no-op otherwise).
                if (migrated) write(sig.peek());
            } catch (err) {
                onError(err, "Failed to initialize");
                lastSerialized = undefined; // unknown; first real write will commit
            }
        }

        // Mirror + observer. sig and debounced are both read functions, so they
        // pass directly as watch sources. Started AFTER the boot read so the
        // restore cannot trigger a write-back.
        const debounced = debounce(sig, ms);
        const stop = watch(debounced, write);
        stopWatch = () => {
            stop();
            debounced.dispose();
        };

        if (syncTabs && typeof window !== "undefined") {
            onStorage = (e) => {
                if (e.key !== key || e.storageArea !== storage) return;
                try {
                    // Prime the dedupe with the incoming string BEFORE setting the
                    // signal: the debounced re-emission then matches lastSerialized
                    // and skips the write-back.
                    lastSerialized = e.newValue; // string | null
                    if (e.newValue === null) {
                        sig.set(merge(undefined, sig.peek()));
                    } else {
                        let [data, fromVersion] = unwrap(e.newValue);
                        if (versioned && fromVersion !== version) data = migrate(data, fromVersion);
                        sig.set(merge(data, sig.peek()));
                    }
                } catch (err) {
                    onError(err, "Cross-tab sync failed");
                }
            };
            window.addEventListener("storage", onStorage);
        }
    };

    // Boot read (sync adapter -> inline; async adapter -> awaited). ready
    // resolves when the signal has been restored (or immediately for the inert
    // and error paths), letting async-backed callers await first paint.
    let settleReady;
    const ready = new Promise((res) => {
        settleReady = res;
    });
    try {
        const r = storage.getItem(key);
        if (isThenable(r)) {
            r.then(
                (stored) => {
                    applyBoot(stored == null ? null : stored);
                    settleReady();
                },
                (err) => {
                    onError(err, "Failed to initialize");
                    lastSerialized = undefined;
                    applyBoot(null);
                    settleReady();
                }
            );
        } else {
            applyBoot(r);
            settleReady();
        }
    } catch (err) {
        onError(err, "Failed to initialize");
        lastSerialized = undefined;
        applyBoot(null);
        settleReady();
    }

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (stopWatch) stopWatch();
        // Optionally commit a value still inside the quiet window. No-op (deduped)
        // when nothing is pending.
        if (flushOnDispose) write(sig.peek());
        if (onStorage && typeof window !== "undefined") {
            window.removeEventListener("storage", onStorage);
        }
    };
    // Force-commit the current value immediately, outside the quiet window. Any
    // trailing debounced emission of the same value is deduped to a no-op.
    dispose.flush = () => {
        if (!disposed) write(sig.peek());
    };
    dispose.ready = ready;
    return dispose;
}

/**
 * Promise-based IndexedDB adapter for persist(), for payloads larger than the
 * ~5 MB Web Storage ceiling. Returns an async {getItem, setItem, removeItem}
 * backed by a single object store. Because reads are asynchronous, the signal is
 * restored after the persist() handle's .ready promise resolves -- not before
 * the call returns.
 *
 * Cross-tab sync (syncTabs) does not apply: IndexedDB writes do not emit the
 * storage event. Pair with @zakkster/lite-channel for cross-tab coordination.
 *
 * @param {object} [options]
 * @param {string} [options.db="lite-persist"]  Database name.
 * @param {string} [options.store="kv"]  Object-store name.
 * @param {IDBFactory} [options.indexedDB]  Factory override (testing / non-global env).
 * @returns {AsyncStorageLike}
 *
 * @typedef {{ getItem(key: string): Promise<string|null>, setItem(key: string, value: string): Promise<void>, removeItem(key: string): Promise<void> }} AsyncStorageLike
 */
export function idbStorage(options = {}) {
    const dbName = options.db || "lite-persist";
    const storeName = options.store || "kv";
    const idb =
        options.indexedDB ||
        (typeof indexedDB !== "undefined" ? indexedDB : null);
    if (!idb) {
        throw new Error("[lite-persist] idbStorage requires IndexedDB; none available in this environment.");
    }

    let dbp = null;
    const open = () =>
        dbp ||
        (dbp = new Promise((res, rej) => {
            const req = idb.open(dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
            };
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        }));

    // Run one request inside a transaction, resolving with its result on commit.
    const run = (mode, fn) =>
        open().then(
            (db) =>
                new Promise((res, rej) => {
                    const tx = db.transaction(storeName, mode);
                    let out;
                    const req = fn(tx.objectStore(storeName));
                    if (req)
                        req.onsuccess = () => {
                            out = req.result;
                        };
                    tx.oncomplete = () => res(out);
                    tx.onerror = () => rej(tx.error || (req && req.error));
                    tx.onabort = () => rej(tx.error || (req && req.error));
                })
        );

    return {
        getItem: (k) => run("readonly", (s) => s.get(k)).then((v) => (v === undefined ? null : v)),
        setItem: (k, v) => run("readwrite", (s) => s.put(v, k)).then(() => undefined),
        removeItem: (k) => run("readwrite", (s) => s.delete(k)).then(() => undefined),
    };
}
