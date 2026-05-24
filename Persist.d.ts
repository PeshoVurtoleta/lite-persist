import { Signal } from "@zakkster/lite-signal";

/** Minimal Web Storage shape. localStorage / sessionStorage satisfy it, as do custom adapters. */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface PersistOptions<T> {
    /** Storage backend. Defaults to `localStorage` when available. */
    storage?: StorageLike;
    /** Coalesce window length in milliseconds. `0` uses microtask timing. Defaults to `50`. */
    debounce?: number;
    /**
     * Cross-tab synchronization via the native `storage` event. Only effective
     * with real Web Storage backends; custom adapters do not emit storage
     * events. Defaults to `true`.
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
}

/**
 * Reactively persist a lite-signal to a Storage backend.
 *
 * Reads synchronously on boot, then writes on change — debounced so a burst of
 * `sig.set()` calls collapses into a single storage write. Optionally mirrors
 * changes across browser tabs.
 *
 * @typeParam T  The value type held by the signal.
 * @param sig      Source signal to track and keep in sync.
 * @param key      Storage key.
 * @param options  Backend, timing, sync and codec configuration.
 * @returns An idempotent dispose function that stops watching, removes the
 *          cross-tab listener, and (if `flushOnDispose`) commits the pending value.
 */
export function persist<T>(
    sig: Signal<T>,
    key: string,
    options?: PersistOptions<T>
): () => void;
