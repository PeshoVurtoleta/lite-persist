import { Signal } from "@zakkster/lite-signal";

/** Minimal synchronous Web Storage shape. localStorage / sessionStorage satisfy it, as do custom adapters. */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Asynchronous storage adapter. Methods return Promises (e.g. {@link idbStorage}). */
export interface AsyncStorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface PersistOptions<T> {
    /**
     * Storage backend. Defaults to `localStorage` when available. May be a
     * synchronous Web Storage object or an asynchronous adapter; with an async
     * adapter the signal is restored after {@link PersistHandle.ready} resolves.
     */
    storage?: StorageLike | AsyncStorageLike;
    /** Coalesce window length in milliseconds. `0` uses microtask timing. Defaults to `50`. */
    debounce?: number;
    /**
     * Cross-tab synchronization via the native `storage` event. Only effective
     * with real Web Storage backends; async / custom adapters do not emit
     * storage events. Defaults to `true`.
     */
    syncTabs?: boolean;
    /**
     * When `true`, commit the value still inside the quiet window at `dispose()`
     * time instead of discarding it. Recommended for save-on-unmount flows.
     * Defaults to `false` (dispose cancels the pending write).
     */
    flushOnDispose?: boolean;
    /** Value encoder. Defaults to `JSON.stringify`. */
    serialize?: (value: T) => string;
    /** Value decoder. Defaults to `JSON.parse`. */
    deserialize?: (str: string) => T;
    /**
     * Post-serialize transform applied to the stored string and reversed by
     * {@link PersistOptions.decode} on read. An encryption or compression hook.
     */
    encode?: (plain: string) => string;
    /** Inverse of {@link PersistOptions.encode}, applied before `deserialize`. */
    decode?: (stored: string) => string;
    /**
     * Schema version. When set, values are stored inside a `{ __v, data }`
     * envelope and {@link PersistOptions.migrate} runs whenever the stored
     * version differs from this one.
     */
    version?: number;
    /**
     * Upgrade a value persisted under an older version. Legacy unversioned data
     * is presented as `fromVersion` 0. Defaults to identity.
     */
    migrate?: (data: any, fromVersion: number) => T;
    /**
     * Project the value to the subset that should be persisted (allowlist).
     * Defaults to identity.
     */
    partialize?: (state: T) => any;
    /**
     * Combine the restored value with the signal's current value on boot and on
     * cross-tab updates. Default: replace; when `partialize` is set, shallow-merge
     * the restored subset over the current value so non-persisted fields survive.
     */
    merge?: (restored: any, current: T) => T;
    /**
     * Error sink, replacing the default `console.warn`. Receives the error and a
     * short context tag (e.g. `"Failed to save"`).
     */
    onError?: (error: unknown, context: string) => void;
}

/**
 * Idempotent dispose function returned by {@link persist}, with two extras:
 * `flush()` commits the current signal value immediately (outside the quiet
 * window), and `ready` resolves once the boot read completes -- immediately for
 * synchronous backends, after the read for asynchronous ones.
 */
export type PersistHandle = (() => void) & {
    flush(): void;
    ready: Promise<void>;
};

/**
 * Reactively persist a lite-signal to a Storage backend.
 *
 * Reads on boot, then writes on change -- debounced so a burst of `sig.set()`
 * calls collapses into a single storage write. Optionally mirrors changes across
 * browser tabs, migrates versioned schemas, persists a subset of the value, and
 * transforms the stored string through an encode/decode pair.
 *
 * @typeParam T  The value type held by the signal.
 * @param sig      Source signal to track and keep in sync.
 * @param key      Storage key.
 * @param options  Backend, timing, sync, codec, versioning and projection config.
 * @returns A {@link PersistHandle}.
 */
export function persist<T>(
    sig: Signal<T>,
    key: string,
    options?: PersistOptions<T>
): PersistHandle;

/** Options for {@link idbStorage}. */
export interface IdbStorageOptions {
    /** Database name. Defaults to `"lite-persist"`. */
    db?: string;
    /** Object-store name. Defaults to `"kv"`. */
    store?: string;
    /** IndexedDB factory override for testing or non-global environments. */
    indexedDB?: IDBFactory;
}

/**
 * Promise-based IndexedDB adapter for {@link persist}, for payloads larger than
 * the ~5 MB Web Storage ceiling. Reads are asynchronous, so the signal is
 * restored after the handle's `ready` promise resolves. Cross-tab `syncTabs`
 * does not apply (IndexedDB writes emit no storage event).
 *
 * @throws if no IndexedDB implementation is available.
 */
export function idbStorage(options?: IdbStorageOptions): AsyncStorageLike;
