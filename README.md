# @zakkster/lite-persist

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-persist.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-persist)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-persist?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-persist)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-persist?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-persist)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-persist?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-persist)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-persist/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**Reactive `localStorage` for [lite-signal](https://www.npmjs.com/package/@zakkster/lite-signal), without the write storm.**

Bind a signal to a storage key in one line. It reads on boot, writes on change -- but a *burst* of changes collapses into a **single** write after a quiet window. The mutation hot path stays allocation-free, so you can persist a value that updates every frame without touching the disk every frame.

```js
import { signal } from '@zakkster/lite-signal';
import { persist } from '@zakkster/lite-persist';

const volume = signal(80);
persist(volume, 'settings.volume');   // restored on boot, saved on change

volume.set(81);   // ...
volume.set(82);   // ...  three synchronous writes to the signal
volume.set(83);   // ...  -> ONE write to localStorage, 50 ms later, value 83
```

That's the whole API surface for the common case. Everything below is detail.

> **Measured** (Node v23, `npm run bench`): a burst of **100,000** signal mutations inside one window produces **0** storage writes during the burst and **1** at settle -- versus **100,000** for write-on-every-change. The hot path grows **8 bytes total across 100k mutations** (~0.00008 B each — essentially nothing), and absorbs **~4.6 million mutations/sec**.

---

## Contents

- [Why](#why) - [Install](#install) - [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Cross-tab sync](#cross-tab-sync)
- [API reference](#api-reference)
- [Benchmarks](#benchmarks)
- [Testing (for clients & QA)](#testing-for-clients--qa)
- [Running the demo](#running-the-demo)
- [Edge cases & guarantees](#edge-cases--guarantees)
- [FAQ](#faq) - [License](#license)

---

## Why

Persisting reactive state to `localStorage` looks trivial, and the first version you write is:

```js
// The code you write first, and regret later
effect(() => {
  localStorage.setItem('state', JSON.stringify(myState()));
});
```

This fires `setItem` on **every** change. `localStorage` is synchronous and main-thread -- each call serializes, crosses into the DOM, and may hit disk. Wire it to anything that changes quickly (a slider drag, a text field, a HUD value, an autosave) and you get a **write storm**: dozens of synchronous disk writes per second, plus a fresh JSON string allocated each time, feeding the garbage collector mid-interaction.

`@zakkster/lite-persist` puts a **coalescing barrier** between the signal and storage. Rapid changes are absorbed; only the *settled* value is written, once.

```mermaid
flowchart LR
    subgraph N["Naive: effect + setItem"]
        direction TB
        N1["sig.set() ×N"] --> N2["serialize ×N"] --> N3["setItem ×N<br/>sync DOM / disk"] --> N4["N JSON strings<br/>-> GC pressure"]
    end
    subgraph P["lite-persist"]
        direction TB
        P1["sig.set() ×N"] --> P2["debounce<br/>coalesce (0 alloc)"] --> P3["serialize ×1"] --> P4["setItem ×1<br/>after quiet window"]
    end
```

### What this is *not*

- **Not a state manager.** It persists a signal you already have; it doesn't create or own your state.
- **Not a sync engine.** Cross-tab mirroring is best-effort last-write-wins over the `storage` event, not a CRDT. For conflict resolution or cross-device sync, reach for `@zakkster/lite-channel`.

Both former caveats are gone as of **1.1**: storage adapters may now be asynchronous (an `idbStorage()` IndexedDB adapter ships in the box), and versioned schema **migrations** are first-class (`version` + `migrate`).

---

## Install

```bash
npm i @zakkster/lite-persist
```

ESM-only. Ships TypeScript definitions. `@zakkster/lite-signal` is a **peer dependency** -- you already have it, and this keeps everything on a single reactive graph. `@zakkster/lite-debounce` is pulled in automatically.

```js
import { persist } from '@zakkster/lite-persist';
```

---

## Quick start

```js
import { signal } from '@zakkster/lite-signal';
import { persist } from '@zakkster/lite-persist';

// A signal of any JSON-serializable value.
const prefs = signal({ theme: 'dark', volume: 80 });

// Bind it. Returns a disposer.
const stop = persist(prefs, 'app.prefs', {
  debounce: 50,          // coalesce window (ms). 0 = microtask.
  syncTabs: true,        // mirror across browser tabs
  storage: localStorage, // or sessionStorage, or a custom adapter
});

prefs.set({ theme: 'light', volume: 80 });  // saved 50 ms later
prefs.update?.(p => ({ ...p, volume: 90 })); // if your signal exposes update()

// On teardown:
stop();
```

`sessionStorage` instead of `localStorage`:

```js
persist(draft, 'editor.draft', { storage: sessionStorage });
```

Setting a signal to `undefined` **removes** the key:

```js
const token = signal(loadToken());
persist(token, 'auth.token');
token.set(undefined);   // -> localStorage.removeItem('auth.token')
```

---

## How it works

The core insight: `debounce(sig, ms)` from `@zakkster/lite-debounce` is a **reactive combinator**, not a callback wrapper. It returns a read-only derived value that mirrors the source signal, trailing-debounced. We simply `watch` that derived value and write on each settled change.

```mermaid
sequenceDiagram
    participant App
    participant Sig as signal
    participant Deb as debounce(sig, ms)
    participant W as watch
    participant St as Storage

    Note over App,St: boot
    App->>St: getItem(key)
    St-->>App: stored string | null
    App->>Sig: set(deserialize(stored))

    Note over App,St: steady state
    loop burst inside window
        App->>Sig: set(v)
        Sig->>Deb: change (0 alloc)
        Note over Deb: coalesce -- arm timer once
    end
    Note over Deb: quiet window elapses
    Deb->>W: settled value
    W->>St: setItem(key, serialize(v))  <- once
```

1. **Boot read is synchronous.** The stored value is restored into your signal before `persist()` returns, so first paint sees the persisted state -- no flash of defaults.
2. **Writes are coalesced.** Each `sig.set()` only nudges a sliding-timestamp timer (zero allocation per change). The serialize + `setItem` happens once, after the window goes quiet.
3. **Writes are de-duplicated by value.** A settled value equal to what's already stored is skipped -- including the freshly-deserialized object arriving from another tab, which is what stops cross-tab sync from echoing.

---

## Cross-tab sync

With `syncTabs: true` (the default), a write in one tab updates the bound signal in every other tab via the native `storage` event:

```mermaid
flowchart LR
    A["Tab A<br/>sig.set(v)"] -->|debounced| S[("localStorage")]
    S -->|storage event| B["Tab B<br/>sig.set(v)"]
    B -.->|value dedupe:<br/>no write-back| S
```

The subtle part is the dashed arrow. When Tab B receives the event it sets its own signal, which would normally schedule a *write back* to storage -- and for object values (where `Object.is` never matches two equal-but-distinct references) that would ping-pong between tabs forever. lite-persist primes its value-level dedupe with the incoming string, so the echoed write is recognized and dropped. This is covered by a dedicated test.

> Cross-tab sync only works with real Web Storage (`localStorage` / `sessionStorage`), because only those emit `storage` events. Custom adapters sync on boot but not live.

---

## API reference

### `persist(sig, key, options?) -> PersistHandle`

| Arg | Type | Description |
|---|---|---|
| `sig` | `Signal<T>` | The signal to track. Read on boot, watched thereafter. |
| `key` | `string` | Storage key. |
| `options` | `PersistOptions<T>` | Optional. See below. |

Returns a **`PersistHandle`** -- an idempotent `() => void` disposer (stops watching, removes the cross-tab listener, and if `flushOnDispose` commits the pending value) carrying two extras:

- **`handle.flush()`** -- commit the current signal value immediately, outside the quiet window. A trailing debounced emission of the same value is deduped to a no-op.
- **`handle.ready`** -- a `Promise<void>` that resolves once the boot read has been applied. Resolves immediately for synchronous backends; for async adapters it resolves *after* the read, so you can await first paint.

### `PersistOptions<T>`

| Option | Type | Default | Description |
|---|---|---|---|
| `storage` | `StorageLike \| AsyncStorageLike` | `localStorage` | Any object with `getItem` / `setItem` / `removeItem`. Methods may return Promises (e.g. `idbStorage()`). |
| `debounce` | `number` | `50` | Coalesce window in ms. `0` flushes on the next microtask. |
| `syncTabs` | `boolean` | `true` | Mirror changes across tabs via the `storage` event. Web Storage only. |
| `flushOnDispose` | `boolean` | `false` | If `true`, commit a value still inside the window when `dispose()` is called. |
| `serialize` | `(value: T) => string` | `JSON.stringify` | Value encoder. |
| `deserialize` | `(str: string) => T` | `JSON.parse` | Value decoder. |
| `encode` | `(plain: string) => string` | identity | Post-serialize transform on the stored string (encryption / compression hook). |
| `decode` | `(stored: string) => string` | identity | Inverse of `encode`, applied before `deserialize`. |
| `version` | `number` | -- | Schema version. When set, values are stored in a `{ __v, data }` envelope and `migrate` runs on a version mismatch. |
| `migrate` | `(data, fromVersion) => T` | identity | Upgrade a value from an older version. Legacy unversioned data is presented as `fromVersion` 0. |
| `partialize` | `(state: T) => any` | identity | Project the value to the subset that should be persisted (allowlist). |
| `merge` | `(restored, current) => T` | replace / shallow-merge | Combine restored data with the current value on boot and cross-tab updates. With `partialize`, defaults to a shallow merge so non-persisted fields survive. |
| `onError` | `(error, context) => void` | `console.warn` | Error sink. Receives the error and a short context tag. |

`StorageLike` is the synchronous three-method shape; `AsyncStorageLike` is the same with `Promise`-returning methods:

```ts
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

#### A note on `flushOnDispose`

By default, `dispose()` **discards** a write still inside the quiet window (it cancels the underlying debounce timer). This matches "tear it down and stop touching storage." If instead you want the last value saved on unmount -- common for editors and settings panels -- pass `flushOnDispose: true`, or call `handle.flush()` at the moment you choose:

```js
const stop = persist(draft, 'editor.draft', { debounce: 1000, flushOnDispose: true });
// ...user types, then navigates away within the 1s window...
stop();   // the latest draft is committed synchronously before teardown
```

### Schema migrations

Pass a `version` and a `migrate` function. Values are stored inside a `{ __v, data }` envelope; on boot, if the stored `__v` differs from the current `version`, `migrate(data, fromVersion)` runs and the upgraded form is re-persisted immediately. Data written before versioning was enabled is presented as `fromVersion` 0.

```js
persist(settings, 'app.settings', {
  version: 3,
  migrate: (data, from) => {
    if (from < 2) data = { ...data, theme: data.darkMode ? 'dark' : 'light' };
    if (from < 3) data = { ...data, volume: data.volume ?? 80 };
    return data;
  },
});
```

### Selective persistence (allowlist)

`partialize` projects the value to the subset worth saving. The default `merge` then layers the restored subset back over the signal's current value on boot, so transient or sensitive fields (kept out of storage) survive a reload.

```js
const session = signal({ user, prefs, draftReply, csrfToken });
persist(session, 'session', {
  partialize: (s) => ({ user: s.user, prefs: s.prefs }), // draftReply + csrfToken never hit disk
});
```

### Encryption / compression hook

`encode` runs after `serialize`; `decode` runs before `deserialize`. Any reversible string transform works -- encrypt, compress, base64, sign.

```js
persist(vault, 'vault', {
  encode: (plain) => encrypt(plain, key),
  decode: (cipher) => decrypt(cipher, key),
});
```

### `idbStorage(options?) -> AsyncStorageLike`

An IndexedDB-backed adapter for payloads past the ~5 MB Web Storage ceiling.

| Option | Type | Default | Description |
|---|---|---|---|
| `db` | `string` | `"lite-persist"` | Database name. |
| `store` | `string` | `"kv"` | Object-store name. |
| `indexedDB` | `IDBFactory` | global | Factory override for tests / non-global environments. |

```js
import { persist, idbStorage } from '@zakkster/lite-persist';

const big = signal(loadDefaults());
const stop = persist(big, 'workspace', { storage: idbStorage(), syncTabs: false });
await stop.ready;   // reads are async -- the signal is restored once this resolves
```

Because IndexedDB writes emit no `storage` event, `syncTabs` does not apply to an async adapter; pair with `@zakkster/lite-channel` if you need cross-tab coordination.

### Behavior summary

| You do | Result |
|---|---|
| `persist(sig, key)` with a stored value (sync backend) | `sig` is set to the stored value synchronously |
| `persist(sig, key, { storage: idbStorage() })` | `sig` is restored after `handle.ready` resolves |
| `sig.set(x)` × N inside the window | one `setItem(key, serialize(latest))` after the window |
| `sig.set(undefined)` | `removeItem(key)` |
| set a value equal to what's stored | no write |
| `handle.flush()` | current value committed immediately, deduped |
| stored `__v` < current `version` on boot | `migrate` runs; upgraded envelope re-persisted |
| with `partialize` set | only the projected subset is written; the rest is merged back on boot |
| another tab writes `key` | `sig` updates; no echo write-back |
| `dispose()` | stops syncing; pending write discarded (or flushed, if opted in) |

---

## Benchmarks

```bash
npm run bench          # node --expose-gc bench/bench.js
```

Measured on Node v22 (`--expose-gc` required for heap numbers). Re-run on your hardware -- the ratios are what matter.

| Metric | Naive (write-on-change) | **lite-persist** |
|---|---:|---:|
| Storage writes for a 100k-mutation burst | 100,000 | **1** |
| Heap growth on the mutation hot path (100k sets) | one JSON string per set | **8 B total** (~0.00008 B/set) |
| Mutations absorbed per second | bound by `setItem` cost | **~4,600,000** |

```mermaid
%%{init: {"theme":"dark"}}%%
xychart-beta
    title "Storage writes for a 100,000-mutation burst -- lower is better (log scale)"
    x-axis ["naive (per change)", "lite-persist"]
    y-axis "writes (log)" 1 --> 100000
    bar [100000, 1]
```

The point isn't micro-throughput -- it's that the work that's *expensive* (serialize + synchronous DOM/disk write) happens **once per quiet window** instead of once per change, while the work that's *cheap and frequent* (the signal mutation itself) stays allocation-free.

---

## Testing (for clients & QA)

Two levels of verification.

### 1. Unit tests -- "does it do what it says?"

```bash
npm test            # node --test
npm run test:gc     # node --expose-gc --test   (enables the allocation test)
```

A clean run reports **17 passed, 0 failed**, exit code 0. Coverage:

| Group | What's checked |
|---|---|
| Boot read | restores a stored value synchronously; absent key leaves the signal untouched; corrupt JSON warns without throwing |
| Coalescing | a burst of writes settles to **one** `setItem` with the latest value; `debounce: 0` coalesces via microtask; a `batch()` settles once |
| Eviction | `set(undefined)` calls `removeItem` |
| Dispose | pending write discarded by default; `flushOnDispose: true` commits it; `flush()` commits on demand; dispose is idempotent; cross-tab listener removed |
| Codecs | custom `serialize` / `deserialize` and `encode` / `decode` round-trip on boot and on write |
| Migrations | older `__v` triggers `migrate`; upgraded envelope re-persisted; legacy unversioned data is `fromVersion` 0 |
| Projection | `partialize` writes only the allowlisted subset; `merge` restores non-persisted fields on boot |
| Async backends | `idbStorage()` and Promise adapters restore after `ready`; writes land asynchronously |
| De-dupe | re-setting an equal value writes nothing |
| Cross-tab | inbound `storage` event updates the signal; an **object** value does **not** echo back to storage |
| Environment | missing storage (Worker/SSR) -> inert disposer, never throws |
| Zero-GC | 100,000 mutations inside one window grow the heap **< 256 KB** (`--expose-gc`) |

### 2. Benchmark -- "does it perform as claimed?"

```bash
npm run bench
```

Prints the coalescing ratio, hot-path allocation, and absorbed throughput, and writes `bench/bench-results.json`. The pass signal is the numbers: a 100k-mutation burst should produce **1** storage write and **well under 256 KB** of heap growth.

### `npm run` reference

| Command | Does |
|---|---|
| `npm test` | Run the 17-test suite |
| `npm run test:gc` | Same, with `--expose-gc` (activates the allocation test) |
| `npm run bench` | Benchmark; writes `bench/bench-results.json` |
| `npm run verify` | `test:gc` + `bench` -- the full CI-style check |

---

## Running the demo

```
example/index.html
```

No build step, no server. Uses an import map to load `@zakkster/lite-signal`, `@zakkster/lite-debounce`, and the local `Persist.js` straight from a CDN + relative path.

It shows the value proposition live: type into a field bound to a persisted signal and watch two counters -- **signal writes** (every keystroke) versus **storage writes** (once you pause). Open the same page in a second tab to see cross-tab sync with no echo. A "naive vs coalesced" toggle makes the write-storm difference visible in real time.

---

## Edge cases & guarantees

Behaviours the test suite pins down:

- **Boot is synchronous.** The persisted value is in the signal before `persist()` returns -- no flash of default state on first render.
- **`undefined` means "remove".** Setting the signal to `undefined` evicts the key rather than storing the string `"undefined"`.
- **Equal values don't write.** De-dupe is by serialized string, so it's identity-independent: re-emitting an equal object is a no-op, and a cross-tab echo is recognized and dropped.
- **Dispose is idempotent.** Calling the returned disposer twice (or after teardown) is safe.
- **Corrupt or unserializable data never crashes.** Boot-read parse failures, serialize failures, async-write rejections, and cross-tab parse failures are caught and routed to `onError` (default `console.warn`); your app keeps running.
- **No storage, no problem.** In a Worker or SSR pass with no `localStorage` and no adapter, `persist()` returns an inert disposer and warns once -- calling code doesn't have to branch on environment.
- **Single reactive graph.** Because `@zakkster/lite-signal` is a peer dependency, lite-persist watches *your* signals on *your* registry -- there is never a second copy of the reactive runtime.

---

## FAQ

**Why debounce by default? I want every change saved.**
Set `debounce: 0`. Changes then coalesce on the next microtask instead of after a timer -- still one write per synchronous burst, but with minimal latency. A true write-on-every-change has no upside over this and reintroduces the write storm.

**Does it lose the last change if I dispose mid-window?**
By default, yes -- `dispose()` discards a pending write. Pass `flushOnDispose: true` to commit it first. See [the note above](#a-note-on-flushondispose).

**Can I version / migrate my stored schema?**
Yes -- pass `version` and `migrate`. Values are wrapped in a `{ __v, data }` envelope; when the stored version is older, `migrate(data, fromVersion)` upgrades it and the new form is re-persisted automatically. Data written before you adopted versioning arrives as `fromVersion` 0. (For a one-off transform without versioning, `deserialize` still works too.)

**Does it work with `sessionStorage`?**
Yes. Pass `{ storage: sessionStorage }`. Cross-tab sync still works for same-origin tabs that share the session where applicable; `localStorage` is the usual choice for durable cross-tab state.

**Can I use IndexedDB / a server?**
Not directly -- those are async, and this targets the synchronous Web Storage contract. Wrap an async backend behind a small synchronous cache that satisfies `getItem/setItem/removeItem`, and persist that.

**Does it run in a Web Worker or during SSR?**
It won't throw. With no storage available it returns an inert disposer. Provide a custom `storage` adapter if you want persistence in those environments.

**How big is it?**
A single small file with no runtime dependencies of its own beyond `@zakkster/lite-debounce`. See the bundle-size badge above.

---

## License

MIT (c) Zahary Shinikchiev
