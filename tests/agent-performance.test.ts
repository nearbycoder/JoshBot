import assert from "node:assert/strict";
import test from "node:test";
import { agentFeatures } from "../lib/agent-features/registry.js";
import { lazyAgentFeature } from "../lib/agent-features/lazy.js";
import { agentAdmissionLimits, DEFAULT_AGENT_ADMISSION } from "../lib/agent-features/admission.js";
import { runAgentFeature } from "../lib/agent-features/runtime.js";
import { handleAgentCommand } from "../lib/agent-features/index.js";
import { createAgentTestContext } from "./agent-feature-test-utils.js";
import type { AgentFeature } from "../lib/agent-features/types.js";

const owner = { teamId: "TPERF", userId: "UPERF" };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const data = new Map<string, string>();
  let writes = 0;
  return { data, get writes() { return writes; }, options: {
    timezone: "UTC", services: createAgentTestContext().services,
    backend: {
      get: async (key: string) => data.get(key) ?? null,
      compareSet: async (key: string, previous: string | null, next: string) => {
        writes++; if ((data.get(key) ?? null) !== previous) return false; data.set(key, next); return true;
      },
    },
  } };
}
const feature: AgentFeature = { id: "performance-test", title: "Test", description: "Test", help: "Test help", execute: async () => "done" };

test("literal catalog help stays in sync with actual modules", async () => {
  for (const metadata of agentFeatures) {
    const { default: loaded } = await import(`../lib/agent-features/${metadata.id}.js`) as { default: AgentFeature };
    for (const key of ["id", "title", "description", "help"] as const) assert.equal(metadata[key], loaded[key], `${metadata.id}.${key} drift`);
  }
});

test("lazy facade exposes metadata without loading and shares only the code import", async () => {
  let loads = 0;
  const delayed = gate<{ default: AgentFeature }>();
  const lazy = lazyAgentFeature(feature, () => { loads++; return delayed.promise; });
  assert.equal(lazy.help, feature.help); assert.equal(loads, 0);
  const a = lazy.execute("run", createAgentTestContext()), b = lazy.execute("run", createAgentTestContext());
  assert.equal(loads, 1); delayed.resolve({ default: feature });
  assert.deepEqual(await Promise.all([a, b]), ["done", "done"]);
  let attempts = 0;
  const retry = lazyAgentFeature(feature, async () => { if (!attempts++) throw new Error("import failed"); return { default: feature }; });
  await assert.rejects(() => retry.execute("run", createAgentTestContext()), /import failed/);
  assert.equal(await retry.execute("run", createAgentTestContext()), "done");
});

test("admission config accepts only positive integer reductions", () => {
  assert.deepEqual(agentAdmissionLimits({}), DEFAULT_AGENT_ADMISSION);
  assert.deepEqual(agentAdmissionLimits({ NOBO_AGENT_MAX_INFLIGHT: "1" }), { global: 1, perUser: 1 });
  for (const value of ["0", "-1", "1.5", "NaN", "100", "", " 2", "02"]) assert.throws(() => agentAdmissionLimits({ NOBO_AGENT_MAX_INFLIGHT: value }), /must be an integer/);
});

test("global overload returns busy before receipt and retries can later execute", async () => {
  const f = fixture(), started = gate<void>(), finish = gate<string>();
  let entered = 0;
  const blocked = { ...feature, execute: async () => { if (++entered === DEFAULT_AGENT_ADMISSION.global) started.resolve(); return finish.promise; } };
  const pending = Array.from({ length: DEFAULT_AGENT_ADMISSION.global }, (_, i) => runAgentFeature(blocked, "run", { ...owner, userId: `UPERF${i}` }, f.options));
  try {
    await started.promise;
    assert.match(await runAgentFeature(feature, "run", { ...owner, requestId: "retry-me" }, f.options), /busy/);
    assert.equal(f.writes, 0); assert.equal(f.data.size, 0);
    assert.match(await handleAgentCommand("inbox help", owner), /capture/);
  } finally { finish.resolve("finished"); await Promise.all(pending); }
  assert.equal(await runAgentFeature(feature, "run", { ...owner, requestId: "retry-me" }, f.options), "done");
  assert.equal(f.data.size, 1);
});

test("cancelled raw services retain user permits until actual settlement", async () => {
  const f = fixture(), started = gate<void>(), finish = gate<string>();
  let calls = 0;
  f.options.services.generate = () => { if (++calls === 2) started.resolve(); return finish.promise; };
  const generating = { ...feature, execute: (_: string, context: Parameters<AgentFeature["execute"]>[1]) => context.services.generate({instructions:"Summarize",input:"synthetic"}) };
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map(controller => runAgentFeature(generating, "run", owner, {...f.options,signal:controller.signal}));
  const rejected = pending.map(p => assert.rejects(p, /abort/i));
  await started.promise; controllers.forEach(c => c.abort()); await Promise.all(rejected);
  assert.match(await runAgentFeature(feature, "run", { ...owner, requestId: "not-poisoned" }, f.options), /busy/);
  assert.equal(f.data.size, 0);
  assert.equal(await runAgentFeature(feature, "run", { ...owner, teamId: "TOTHER" }, f.options), "done", "user cap is workspace-scoped");
  finish.resolve("late"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await runAgentFeature(feature, "run", { ...owner, requestId: "not-poisoned" }, f.options), "done");
});

for (const stage of ["get", "eval", "access"] as const) {
  test(`nested production context ${stage} retains physical work after outer cancellation`, async () => {
    const { createAgentFeatureServices, createProductionContextAdapters } = await import("../lib/agent-features/services.js");
    const f = fixture(), entered = gate<void>(), raw = gate<unknown>();
    let calls = 0;
    const wait = async () => { if (++calls === 2) entered.resolve(); return raw.promise; };
    const backend = { ...f.options.backend, get: stage === "get" ? async () => { await wait(); return null; } : f.options.backend.get };
    const adapters = createProductionContextAdapters({
      redis: async () => ({ eval: async () => { if (stage === "eval") await wait(); return []; } }),
      evaluateAccess: async () => { if (stage === "access") await wait(); return { allowed: true }; },
    });
    const controllers = [new AbortController(), new AbortController()];
    const reading: AgentFeature = { ...feature, execute: async (_, ctx) => {
      await ctx.services.readContext([stage === "get" ? "note" : "reminder"]); return "read";
    } };
    const caller = { ...owner, channelId: "CPERF" };
    const pending = controllers.map(controller => runAgentFeature(reading, "read", caller, {
      ...f.options, backend, signal: controller.signal,
      services: createAgentFeatureServices(backend, caller, controller.signal, { timezone: "UTC", now: new Date() }, adapters),
    }));
    const rejected = pending.map(p => assert.rejects(p, /abort/i));
    await entered.promise; controllers.forEach(c => c.abort()); await Promise.all(rejected);
    assert.match(await runAgentFeature(feature, "run", caller, f.options), /busy/);
    assert.equal(calls, 2); assert.equal(f.data.size, 0);
    raw.resolve(null); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await runAgentFeature(feature, "run", caller, f.options), "done");
  });
}

test("two requests from one user leave capacity for another caller", async () => {
  const f = fixture(), ready = gate<void>(), finish = gate<string>();
  let entered = 0;
  const blocked = { ...feature, execute: () => { if (++entered === 2) ready.resolve(); return finish.promise; } };
  const pending = [1, 2].map(() => runAgentFeature(blocked, "run", owner, f.options));
  try {
    await ready.promise;
    assert.match(await runAgentFeature(feature, "run", owner, f.options), /busy/);
    assert.equal(await runAgentFeature(feature, "run", { ...owner, userId: "UOTHER" }, f.options), "done");
  } finally { finish.resolve("done"); await Promise.all(pending); }
});

test("lower feature budgets reject before upstream calls; invalid budgets before receipts", async () => {
  const f = fixture(); let generations = 0, searches = 0, contexts = 0;
  f.options.services.generate = async () => { generations++; return "text"; };
  f.options.services.search = async () => { searches++; return []; };
  f.options.services.readContext = async () => { contexts++; return []; };
  for (const [resourceBudgets, execute, message] of [
    [{ generations: 0 }, async (_: string, ctx: Parameters<AgentFeature["execute"]>[1]) => ctx.services.generate({ instructions: "test", input: "test" }), /0 generation/],
    [{ searches: 0 }, async (_: string, ctx: Parameters<AgentFeature["execute"]>[1]) => { await ctx.services.search("test"); return "done"; }, /0 web/],
    [{ contextReads: 0 }, async (_: string, ctx: Parameters<AgentFeature["execute"]>[1]) => { await ctx.services.readContext(); return "done"; }, /0 context/],
  ] as const) await assert.rejects(() => runAgentFeature({ ...feature, resourceBudgets, execute }, "run", owner, f.options), message);
  assert.deepEqual([generations, searches, contexts], [0, 0, 0]);
  for (const value of [-1, .5, Infinity, NaN, 9]) await assert.rejects(() => runAgentFeature({ ...feature, resourceBudgets: { generations: value } }, "run", { ...owner, requestId: "invalid-budget" }, f.options), /integer/);
  assert.equal(f.writes, 0);
});

test("one logical state update retains all 32 CAS attempts and read budgets are separate", async () => {
  const f = fixture(); let attempts = 0;
  f.options.backend.compareSet = async (key, _, next) => { if (++attempts < 32) return false; f.data.set(key, next); return true; };
  const result = await runAgentFeature({ ...feature, resourceBudgets: { storeReads: 1, storeUpdates: 1 }, execute: async (_, ctx) => {
    assert.equal(await ctx.store.update("count", 0, count => ({ value: count + 1, result: "saved" })), "saved");
    assert.equal(await ctx.store.read("count"), 1);
    await assert.rejects(() => ctx.store.read("count"), /1 state reads/);
    await assert.rejects(() => ctx.store.update("count", 0, count => ({ value: count + 1, result: "saved" })), /1 state updates/);
    return "done";
  } }, "run", owner, f.options);
  assert.equal(result, "done"); assert.equal(attempts, 32);
  assert.equal(f.data.get("nobo:agents:v1:TPERF:UPERF:performance-test:count"), "1");
});

test("context bounds fail visibly without truncating sources or saving a partial result", async () => {
  const f = fixture();
  const reading: AgentFeature = { ...feature, execute: async (_, ctx) => {
    const items = await ctx.services.readContext();
    return ctx.store.update("state", [], () => ({ value: items, result: "saved" }));
  } };
  const item = { id: "one", kind: "note" as const, title: "source", text: "x" };
  f.options.services.readContext = async () => Array.from({ length: 2_001 }, (_, i) => ({ ...item, id: String(i) }));
  await assert.rejects(() => runAgentFeature(reading, "run", owner, f.options), /complete-read budget/);
  f.options.services.readContext = async () => [{ ...item, metadata: { large: "x".repeat(16 * 1024 * 1024) } }];
  await assert.rejects(() => runAgentFeature(reading, "run", owner, f.options), /No source data was truncated/);
  assert.equal(f.data.size, 0);
});

test("bounded context remains fresh between calls and overlapping reads cannot multiply snapshots", async () => {
  const f = fixture(), finish = gate<void>();
  let calls = 0;
  f.options.services.readContext = async () => { calls++; await finish.promise; return [{ id: "note", kind: "note", title: "note", text: String(calls) }]; };
  const result = runAgentFeature({ ...feature, execute: async (_, ctx) => {
    const first = ctx.services.readContext();
    await assert.rejects(() => ctx.services.readContext(), /sequentially/);
    finish.resolve(); assert.equal((await first)[0].text, "1");
    assert.equal((await ctx.services.readContext())[0].text, "2", "no stale request-local cache");
    return "fresh";
  } }, "run", owner, f.options);
  assert.equal(await result, "fresh"); assert.equal(calls, 2);
});

test("production Exa transport receives and acts on the original abort signal", async (t) => {
  const { createAgentFeatureServices } = await import("../lib/agent-features/services.js");
  const f = fixture(), controller = new AbortController(), entered = gate<void>();
  const previous = process.env.EXA_API_KEY; process.env.EXA_API_KEY = "offline-test-key";
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal; assert.ok(signal);
    entered.resolve();
    return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true }));
  });
  try {
    const services = createAgentFeatureServices(f.options.backend, owner, controller.signal, { now: new Date(), timezone: "UTC" });
    const pending = services.search("offline cancellation test");
    const rejected = assert.rejects(pending, /abort/i);
    await entered.promise; controller.abort(); await rejected;
    assert.equal(cancelled, true);
  } finally { if (previous === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = previous; }
});

test("real adapters serve all 1500 supported records; oversized combined sources fail and narrower reads recover", async (t) => {
  const { eventId } = await import("../lib/agent-features/calendar/ics.js");
  const { createAgentFeatureServices, createProductionContextAdapters } = await import("../lib/agent-features/services.js");
  const { measureAgentContext } = await import("../lib/agent-features/budgets.js");
  const f = fixture(), now = new Date("2026-10-22T12:00:00.000Z"), at = now.toISOString();
  const caller = { ...owner, channelId: "CPERF" };
  const seed = (textLength: number) => {
    for (const tool of ["notes", "goals", "habits", "journal", "bookmarks"]) f.data.set(`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:${tool}`, JSON.stringify({entries:Array.from({length:100},(_,i)=>({id:`item-${i}`,title:`Atlas ${i}`,body:"x".repeat(textLength),updatedAt:at,data:{}}))}));
    for (const [prefix, field] of [["follow-ups:record:","task"],["schedules:job:","task"],["monitors:job:","query"],["channel-digests:subscription:","focus"]]) {
      for(let i=0;i<200;i++) f.data.set(`${prefix}record-${i}`,JSON.stringify({id:`record-${i}`,channel:caller.channelId,ownerUserId:caller.userId,createdByUserId:caller.userId,createdAt:at,kind:"daily",frequency:"daily",hour:9,minute:0,timezone:"UTC",[field]:"x".repeat(textLength)}));
    }
  };
  seed(1_000);
  f.data.set(`nobo:agents:v1:${owner.teamId}:${owner.userId}:calendar:calendar-v1`,JSON.stringify({version:1,revision:1,pending:null,events:Array.from({length:100},(_,i)=>({id:eventId(`event-${i}`),uid:`event-${i}`,title:`Meeting ${i}`,location:"Office",busy:true,allDay:false,updatedAt:at,startAt:at,endAt:"2026-10-22T13:00:00.000Z",timezone:"UTC"}))}));
  f.data.set(`nobo:agents:v1:${owner.teamId}:${owner.userId}:memory-review:cards`,JSON.stringify({version:1,cards:Array.from({length:100},(_,i)=>{
    const claim={fact:`Atlas memory ${i}`,source:"My confirmation",expiresOn:null,confidence:null};
    return {...claim,id:`mr_00000000-0000-4000-8000-${String(i).padStart(12,"0")}`,subject:`subject${i}`,key:"key",confirmedAt:at,capturedAt:at,updatedAt:at,revision:2,origin:{kind:"user"},history:[{...claim,confirmedAt:null,revision:1,action:"capture",at},{...claim,confirmedAt:at,revision:2,action:"confirm",at}]};
  })}));
  const adapters=createProductionContextAdapters({redis:async()=>({eval:async()=>Array.from({length:200},(_,i)=>`record-${i}`)}),evaluateAccess:async()=>({allowed:true})});
  const services=createAgentFeatureServices(f.options.backend,caller,new AbortController().signal,{now,timezone:"UTC"},adapters);
  const observed: { count: number; bytes: number; kinds: Record<string,number> }[]=[];
  const read: AgentFeature={...feature,execute:async(command,ctx)=>{
    const items=await ctx.services.readContext(command==="all"?undefined:[command as "note"|"reminder"]);
    observed.push({count:items.length,bytes:measureAgentContext(items),kinds:items.reduce((counts,item)=>({...counts,[item.kind]:(counts[item.kind]??0)+1}),{} as Record<string,number>)});
    return String(items.length);
  }};
  const settings={...f.options,services,now};
  assert.equal(await runAgentFeature(read,"all",caller,settings),"1500");
  assert.equal(Object.keys(observed[0].kinds).length,11);
  seed(12_000);
  await assert.rejects(()=>runAgentFeature(read,"all",caller,settings),/complete-read budget/);
  assert.equal(await runAgentFeature(read,"note",caller,settings),"100");
  assert.equal(await runAgentFeature(read,"reminder",caller,settings),"200");
  assert.equal(f.writes,0,"source reads and quota failures never mutate persisted sources");
  t.diagnostic(JSON.stringify({adapterMaxima:observed}));
});
