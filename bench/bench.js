// Honest benchmark for @zakkster/lite-persist.
// Run: node --expose-gc bench/bench.js
import { signal } from '@zakkster/lite-signal';
import { persist } from '../Persist.js';
import { writeFileSync } from 'node:fs';

const hasGC = typeof global.gc === 'function';
const heap = () => { if (hasGC) { global.gc(); global.gc(); } return process.memoryUsage().heapUsed; };
const fakeStorage = () => { const m = new Map(); let writes = 0, removes = 0;
  return { getItem: k => m.has(k)?m.get(k):null,
           setItem: (k,v)=>{writes++; m.set(k,String(v));},
           removeItem: k=>{removes++; m.delete(k);},
           get writes(){return writes;}, get removes(){return removes;} }; };

// A naive persister: writes to storage on EVERY change (no coalescing).
function naivePersist(sig, key, storage) {
  let last;
  return sig.subscribe(v => { const s = JSON.stringify(v); if (s!==last){ last=s; storage.setItem(key, s);} });
}

const SETS = 100_000;
const WARMUP = 30_000;

function benchCoalescing() {
  const storage = fakeStorage();
  const s = signal(0);
  persist(s, 'k', { storage, debounce: 1_000_000 }); // window never elapses during burst
  for (let i = 0; i < SETS; i++) s.set(i);
  return { writes: storage.writes };   // expect 0 (still inside window) -> coalesced
}

function benchHotPathAlloc() {
  const storage = fakeStorage();
  const s = signal(0);
  persist(s, 'k', { storage, debounce: 1_000_000 });
  for (let i = 0; i < WARMUP; i++) s.set(i);     // warm the pools
  const before = heap();
  for (let i = 0; i < SETS; i++) s.set(i);        // the measured hot path
  const after = heap();
  return { deltaBytes: after - before, perSet: (after - before) / SETS };
}

function benchNaiveAlloc() {
  const storage = fakeStorage();
  const s = signal(0);
  naivePersist(s, 'k', storage);
  for (let i = 0; i < WARMUP; i++) s.set(i);
  const before = heap();
  for (let i = 0; i < SETS; i++) s.set(i);
  const after = heap();
  return { deltaBytes: after - before, perSet: (after - before) / SETS, writes: storage.writes };
}

function benchThroughput(fn, label) {
  // median of 5 runs
  const times = [];
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a,b)=>a-b);
  return { label, ms: times[2], opsPerSec: SETS / (times[2]/1000) };
}

console.log(`\n@zakkster/lite-persist — benchmark (Node ${process.version}, gc=${hasGC})\n`);

const coal = benchCoalescing();
console.log(`Coalescing:        ${SETS.toLocaleString()} mutations in one window -> ${coal.writes} storage write(s)`);

const hot = benchHotPathAlloc();
console.log(`Hot-path alloc:    ${(hot.deltaBytes/1024).toFixed(1)} KB total over ${SETS.toLocaleString()} sets = ${hot.perSet.toFixed(3)} bytes/mutation`);

const naive = benchNaiveAlloc();
console.log(`Naive (per-set):   ${(naive.deltaBytes/1024/1024).toFixed(2)} MB over ${SETS.toLocaleString()} sets = ${naive.perSet.toFixed(1)} bytes/mutation, ${naive.writes.toLocaleString()} storage writes`);

const tp = benchThroughput(() => { const st=fakeStorage(); const s=signal(0); persist(s,'k',{storage:st,debounce:1e9}); for(let i=0;i<SETS;i++) s.set(i); }, 'persist burst');
console.log(`Throughput:        ${Math.round(tp.opsPerSec).toLocaleString()} mutations/sec absorbed (${tp.ms.toFixed(1)} ms for ${SETS.toLocaleString()})`);

const out = { node: process.version, gc: hasGC, sets: SETS, coalescing: coal, hotPath: hot, naive, throughput: tp, ts: new Date().toISOString() };
writeFileSync(new URL('./bench-results.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`\nWrote bench/bench-results.json\n`);

process.exit(0);
