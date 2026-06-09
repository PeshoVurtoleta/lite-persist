# Changelog

All notable changes to `@zakkster/lite-persist` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-06-09

Additive release. No breaking changes; pure surface growth on top of 1.0.
Existing 1.0 callers continue to work without modification — every 1.1 feature
is opt-in through an additional `PersistOptions` field.

### Added

- **Asynchronous storage adapters** — `options.storage` may now be either a
  synchronous `StorageLike` (the 1.0 contract) or an `AsyncStorageLike` whose
  `getItem` / `setItem` / `removeItem` return Promises. The library auto-detects
  the shape via thenable-check and routes accordingly; with an async adapter
  the signal is restored after `handle.ready` resolves rather than before
  `persist()` returns.
- **Built-in IndexedDB adapter (`idbStorage`)** — a Promise-based
  `AsyncStorageLike` for payloads past the ~5 MB Web Storage ceiling.
  Single object store, lazy db-open, optional `db` / `store` / `indexedDB`
  factory override (useful for testing or non-global environments). Throws a
  clear error message when no IndexedDB is available and no factory was
  provided. Cross-tab `syncTabs` is inert with IndexedDB (it emits no storage
  event); pair with `@zakkster/lite-channel` for cross-tab coordination.
- **Versioned schema migrations** — `options.version` (a number) opts into a
  `{ __v, data }` storage envelope, and `options.migrate(data, fromVersion)`
  runs on boot whenever the stored version differs. Legacy unversioned data
  is presented as `fromVersion === 0`. Upgrades are re-persisted immediately
  in the new envelope (`write()` self-dedupes, so this is a no-op when the
  shape was already current).
- **Selective persistence (`options.partialize`)** — project the value down
  to the subset that should land in storage (an allowlist). The default
  `merge` switches to shallow-merge-restored-over-current when `partialize`
  is set, so non-persisted fields (ephemeral state, secrets, derived caches)
  survive a reload. Also breaks the cross-tab echo loop, because re-projecting
  the merged value reproduces the stored subset exactly.
- **`options.encode` / `options.decode`** — a post-serialize / pre-deserialize
  string transform. Encryption hooks, compression layers, base64 wrappers,
  HMAC envelopes — anything that takes a string and returns a string. Pairs
  cleanly with `serialize` / `deserialize` if you also want to change the
  value codec.
- **`handle.flush()`** — commit the current signal value immediately, outside
  the quiet window. Self-deduped against the trailing debounced emission so
  a flush + late settle counts as one write. Useful for explicit
  save-on-checkpoint flows that don't want to wait for the window.
- **`handle.ready` Promise** — resolves once the boot read has been applied
  (immediately for sync backends, after the read for async ones; even on
  read failure it still resolves, after `onError` has been called). Lets
  async-backed callers `await handle.ready` before first paint.
- **`options.flushOnDispose`** — when true, dispose commits the value still
  inside the quiet window instead of discarding it. Default `false` (the
  conservative behavior — explicit `flush()` is preferred for save-on-unmount).
- **`options.onError`** — sink for parse / serialize / encode / async-write
  failures, replacing the default `console.warn`. Receives `(error, context)`
  where `context` is a short tag like `"Failed to save"` or
  `"Failed to initialize"`. The app keeps running on every failure path.

### Tested

- **Five-file test suite** (46 deterministic + 2 zero-GC = **48 tests**),
  matching the multi-file convention used across the `@zakkster/lite-*` family:
  - `test/01-core.test.js` — original 15-test suite covering the main API
    surface (boot restore, coalescing, primed dedupe, flush, flushOnDispose,
    `.ready` for sync, version migration, legacy unversioned, partialize +
    merge, encode/decode round-trip, inert SSR path, onError on serialize
    failure, async adapter restore-after-ready, cross-tab event, idbStorage
    end-to-end).
  - `test/02-codecs-errors-dedupe.test.js` (10 tests) — custom
    serialize/deserialize, deserialize-failure-on-boot keeps the initial
    value, decode-failure-on-boot, encode-failure-on-write, consecutive
    identical writes are deduped at the stored-string level,
    `sig.set(undefined)` evicts (removeItem) but only when there's something
    to remove, default merge fully replaces without partialize, custom merge
    function on both boot and cross-tab.
  - `test/03-async-and-dispose.test.js` (12 tests) — async setItem rejection
    routed to onError without breaking subsequent writes, async getItem
    rejection at boot with `.ready` still resolving, async-restore timing
    contract (sig keeps initial value until `.ready`), `dispose()` idempotency,
    `flush()` after `dispose()` is a safe no-op, `flush()` on inert handle is
    a no-op, `debounce: 0` settles on a microtask (no setTimeout), `syncTabs:
    false` suppresses listener installation, no-window environment doesn't
    throw, cross-tab `newValue: null` evicts, cross-tab ignores other keys,
    cross-tab ignores other storage areas.
  - `test/04-idb-edges.test.js` (8 tests) — `idbStorage` throws with a clear
    message when no IDB available, accepts explicit `indexedDB` factory
    override, default `db='lite-persist'` and `store='kv'` names interoperate
    across instances, missing-key get returns `null` (not `undefined`),
    string round-trips byte-for-byte, `removeItem` actually deletes,
    `removeItem` on missing key doesn't throw, db is opened lazily.
  - `test/zero-gc.test.js` (3 tests) — hot-path retention contract: 50k and
    100k `sig.set()` calls inside the quiet window retain < 5 B/set (min of
    3 runs); the coalescing twin test proves 10k mutations settle to exactly
    1 storage write. Auto-skipped without `--expose-gc`.

  Run `npm test` (46 pass + 2 skip) or `npm run test:gc` (**48/48** in
  ~1.7 s).

### Demo

- New "Write pipeline (1.1)" panel in `demo/index.html` showing the full
  read/write transform chain with togglable `partialize` / `version: 2` /
  `encode: base64` toggles and a "Seed legacy v0 data & reboot" button that
  demonstrates the migration round-trip. The actual stored bytes are rendered
  live so the visual effect of each transform layer is visible.
- Demo import map bumped to `@zakkster/lite-signal@1.1.5` (matches peerDep).

## [1.0.0] — 2026-04-XX

Initial release.

### Added

- **`persist(sig, key, options?) → PersistHandle`** — bind a lite-signal to a
  Storage backend. Reads on boot, debounces and coalesces writes on change,
  optionally mirrors across browser tabs via the storage event.
- **Coalescing via `@zakkster/lite-debounce`** — a burst of `sig.set()` calls
  inside the quiet window collapses into exactly one `setItem`, carrying the
  most recent value. Zero allocation on the hot path; the serialize chain and
  the storage write happen once per settled window.
- **Stored-string dedupe** — writes are filtered by their post-serialize
  string, so identity-different but structurally-equal values don't write
  twice, and a cross-tab echo of a value we just wrote ourselves is
  suppressed.
- **Cross-tab sync** (`syncTabs: true`, default) — listens on the `storage`
  event; updates the signal through the merge path without writing back.
  Inert with async or custom adapters (only real Web Storage emits the
  event).
- **`PersistHandle`** — idempotent dispose function. Removes the storage
  listener, stops the watcher, and (with `flushOnDispose: true`) commits a
  value still inside the quiet window.
- **Inert SSR / worker path** — no `localStorage` and no adapter passed
  returns a fully no-op handle (silent, no throw) so calling code never has
  to branch on environment.

### Architectural invariants

- **One settled value → one storage write.** The write path is gated by both
  the debounce window and a `lastSerialized` dedupe.
- **Restored value is NEVER written straight back.** The boot read primes
  `lastSerialized` to the stored string, so the debounced re-emission of the
  restored signal dedupe-skips the would-be echo write.
- **Cross-tab echo loop is broken.** Incoming `storage` events likewise
  prime `lastSerialized` to the inbound string before updating the signal,
  so the debounced re-emission matches and no write goes back out.
