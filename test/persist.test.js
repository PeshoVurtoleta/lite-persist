import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { signal, batch } from '@zakkster/lite-signal';
import { persist } from '../Persist.js';

// ── A Storage mock that counts operations. ───────────────────────────────────
function makeStorage() {
    const map = new Map();
    let writes = 0, removes = 0;
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { writes++; map.set(k, String(v)); },
        removeItem: (k) => { removes++; map.delete(k); },
        get writes() { return writes; },
        get removes() { return removes; },
        _map: map,
    };
}

// ── Minimal window so cross-tab tests can dispatch real `storage` events. ────
function installWindow() {
    const handlers = new Set();
    globalThis.window = {
        addEventListener: (type, fn) => { if (type === 'storage') handlers.add(fn); },
        removeEventListener: (type, fn) => { if (type === 'storage') handlers.delete(fn); },
    };
    return { dispatch: (e) => { for (const h of handlers) h(e); }, size: () => handlers.size };
}
afterEach(() => { delete globalThis.window; });

const MS = 10;
const settle = () => sleep(MS + 15);

test('boot read restores the stored value synchronously', () => {
    const st = makeStorage();
    st.setItem('volume', '75');
    const vol = signal(100);
    persist(vol, 'volume', { storage: st, debounce: MS });
    assert.equal(vol(), 75);
});

test('absent key leaves the signal untouched', () => {
    const st = makeStorage();
    const s = signal('default');
    persist(s, 'missing', { storage: st });
    assert.equal(s(), 'default');
});

test('corrupt stored data warns but does not throw or mutate', () => {
    const st = makeStorage();
    st.setItem('bad', '{not json');
    const s = signal('safe');
    assert.doesNotThrow(() => persist(s, 'bad', { storage: st }));
    assert.equal(s(), 'safe');
});

test('coalesces a burst into a single write with the last value', async () => {
    const st = makeStorage();
    const s = signal('initial');
    persist(s, 'k', { storage: st, debounce: MS });
    s.set('a'); s.set('b'); s.set('c');
    assert.equal(st.writes, 0, 'no write during the burst');
    await settle();
    assert.equal(st.writes, 1, 'exactly one write after the window');
    assert.equal(st._map.get('k'), '"c"');
});

test('debounce 0 coalesces via microtask', async () => {
    const st = makeStorage();
    const s = signal(0);
    persist(s, 'k', { storage: st, debounce: 0 });
    for (let i = 0; i < 1000; i++) s.set(i);
    assert.equal(st.writes, 0);
    await sleep(0); await sleep(0);
    assert.equal(st.writes, 1);
    assert.equal(st._map.get('k'), '999');
});

test('undefined maps to item eviction', async () => {
    const st = makeStorage();
    st.setItem('token', '"xyz"');
    const token = signal('xyz');
    persist(token, 'token', { storage: st, debounce: MS });
    token.set(undefined);
    await settle();
    assert.equal(st.removes, 1);
    assert.equal(st._map.has('token'), false);
});

test('a batch settles to a single write', async () => {
    const st = makeStorage();
    const score = signal(0);
    persist(score, 'hi', { storage: st, debounce: MS });
    batch(() => { score.set(10); score.set(20); score.set(30); });
    await settle();
    assert.equal(st.writes, 1);
    assert.equal(st._map.get('hi'), '30');
});

test('dispose discards the pending write by default', async () => {
    const st = makeStorage();
    const cfg = signal('on');
    const dispose = persist(cfg, 'cfg', { storage: st, debounce: MS });
    cfg.set('off');
    dispose();
    await settle();
    assert.equal(st.writes, 0, 'pending value discarded');
});

test('flushOnDispose:true commits the pending write', async () => {
    const st = makeStorage();
    const cfg = signal('on');
    const dispose = persist(cfg, 'cfg', { storage: st, debounce: MS, flushOnDispose: true });
    cfg.set('off');
    dispose();
    assert.equal(st._map.get('cfg'), '"off"');
    await settle();
    assert.equal(st.writes, 1);
});

test('dispose is idempotent', () => {
    const st = makeStorage();
    const dispose = persist(signal(1), 'k', { storage: st });
    dispose();
    assert.doesNotThrow(() => { dispose(); dispose(); });
});

test('honours custom serialize / deserialize', async () => {
    const st = makeStorage();
    st.setItem('p', 'A|B');
    const s = signal(null);
    persist(s, 'p', {
        storage: st, debounce: MS,
        serialize: (v) => v.join('|'),
        deserialize: (str) => str.split('|'),
    });
    assert.deepEqual(s(), ['A', 'B']);
    s.set(['X', 'Y', 'Z']);
    await settle();
    assert.equal(st._map.get('p'), 'X|Y|Z');
});

test('re-setting an equal primitive does not write again', async () => {
    const st = makeStorage();
    const s = signal('keep');
    persist(s, 'k', { storage: st, debounce: MS });
    s.set('changed');
    await settle();
    assert.equal(st.writes, 1);
    s.set('changed');
    await settle();
    assert.equal(st.writes, 1, 'no redundant write');
});

test('cross-tab: an inbound storage event updates the signal', () => {
    const win = installWindow();
    const st = makeStorage();
    const s = signal('local');
    persist(s, 'shared', { storage: st });
    win.dispatch({ key: 'shared', newValue: '"remote"', storageArea: st });
    assert.equal(s(), 'remote');
});

test('cross-tab: an object value does NOT echo back to storage', async () => {
    const win = installWindow();
    const st = makeStorage();
    const s = signal({ hp: 100 });
    persist(s, 'state', { storage: st, debounce: MS });
    const before = st.writes;
    win.dispatch({ key: 'state', newValue: '{"hp":50}', storageArea: st });
    assert.deepEqual(s(), { hp: 50 });
    await settle();
    assert.equal(st.writes, before, 'inbound value must not be written back out');
});

test('cross-tab: listener is removed on dispose', () => {
    const win = installWindow();
    const st = makeStorage();
    const dispose = persist(signal(0), 'k', { storage: st });
    assert.equal(win.size(), 1);
    dispose();
    assert.equal(win.size(), 0);
});

test('no storage available -> inert disposer, no throw', () => {
    const s = signal(1);
    let dispose;
    assert.doesNotThrow(() => { dispose = persist(s, 'k'); });
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose());
});

test('zero-allocation hot path (requires --expose-gc)', { skip: typeof global.gc !== 'function' ? 'run with --expose-gc' : false }, () => {
    const st = makeStorage();
    const s = signal(0);
    const dispose = persist(s, 'k', { storage: st, debounce: 1e9 });
    for (let i = 0; i < 30_000; i++) s.set(i);
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100_000; i++) s.set(i);
    global.gc(); global.gc();
    const grewKB = (process.memoryUsage().heapUsed - before) / 1024;
    assert.equal(st.writes, 0, 'burst is fully coalesced');
    assert.ok(grewKB < 256, `hot path grew ${grewKB.toFixed(1)} KB over 100k mutations (expected < 256)`);
    dispose();
});
