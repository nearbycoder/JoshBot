import assert from "node:assert/strict";
import test from "node:test";
import { agentStorePrefix, createAgentFeatureStore, type AgentStateBackend } from "../lib/agent-features/store.js";
import { runAgentFeature } from "../lib/agent-features/runtime.js";
import type { AgentFeature } from "../lib/agent-features/types.js";
import { createAgentTestContext } from "./agent-feature-test-utils.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import task from "../lib/agent-features/task-breakdown.js";
import deadline from "../lib/agent-features/deadline-backplan.js";
import capacity from "../lib/agent-features/capacity-forecast.js";
import batch from "../lib/agent-features/context-batch.js";
import scope from "../lib/agent-features/scope-slicer.js";
import blocker from "../lib/agent-features/blocker-lab.js";
import premortem from "../lib/agent-features/premortem.js";
import assumption from "../lib/agent-features/assumption-tests.js";
import decision from "../lib/agent-features/decision-journal.js";
import calibration from "../lib/agent-features/estimate-calibration.js";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tenFeatures = [task, deadline, capacity, batch, scope, blocker, premortem, assumption, decision, calibration];
const assertDiagnosis = (reply: string, feature: AgentFeature) => {
  assert.match(reply, /could not be read safely/); assert.ok(reply.includes(feature.id));
  assert.match(reply, /workspace.*user/); assert.match(reply, /operator/);
  assert.match(reply, /state-recovery\.md/); assert.match(reply, /help/);
  assert.doesNotMatch(reply, /No saved|Next: .*list|Export|remove older|private-secret|nobo:agents|SyntaxError/);
};

for (const feature of tenFeatures) test(`${feature.id}: null and invalid JSON yield scoped recovery, preserve bytes, isolate owners and leave help usable`, async () => {
  const f = createAgentFeatureFixture(feature), create = feature.example!.split(`agent ${feature.id} `)[1];
  assert.match(await f.run("list"), /No saved/);
  assert.equal(f.backend.data.has(f.key("state")), false);
  const other = createAgentFeatureFixture(feature, { backend: f.backend, owner: { teamId: "TOTHER", userId: f.owner.userId } });
  const second = createAgentFeatureFixture(feature, { backend: f.backend, owner: { teamId: f.owner.teamId, userId: "UOTHER" } });
  for (const foreign of [other, second]) assert.match(await foreign.run(create), /Saved privately/);
  const unrelated = [...f.backend.data];
  for (const raw of ["null", " \nnull\t", '{"private-secret":', ""]) {
    f.backend.data.set(f.key("state"), raw);
    for (const command of ["list", create]) {
      const before = { ...f.backend.calls };
      assertDiagnosis(await f.run(command), feature);
      assert.equal(f.backend.calls.gets, before.gets + 1, "diagnosis must not add a preflight read or retry");
      assert.equal(f.backend.calls.compareSets, before.compareSets);
      assert.equal(f.backend.data.get(f.key("state")), raw);
    }
    const before = { ...f.backend.calls };
    assert.equal(await f.run("help"), feature.help); assert.deepEqual(f.backend.calls, before);
    for (const [key, value] of unrelated) assert.equal(f.backend.data.get(key), value);
    for (const foreign of [other, second]) assert.doesNotMatch(await foreign.run("list"), /could not be read safely/);
  }
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("store distinguishes absence, present null and invalid JSON without changing nonnull values", async () => {
  const data = createMemoryAgentBackend(), owner = { teamId: "TTEST", userId: "UTEST" };
  const prefix = agentStorePrefix(owner, "sample"), store = createAgentFeatureStore(data, owner, "sample");
  assert.equal(await store.read("state"), null);
  for (const raw of ["0", "false", '""', "[]", "{}", '{"nested":null}']) {
    data.data.set(prefix + "state", raw); assert.deepEqual(await store.read("state"), JSON.parse(raw));
  }
  for (const [raw, reason] of [["null", "stored-null"], [" \nnull\t", "stored-null"], ['{"private-secret":', "invalid-json"], ["", "invalid-json"]]) {
    data.data.set(prefix + "state", raw); let transformed = false;
    for (const invoke of [() => store.read("state"), () => store.update("state", {}, () => { transformed = true; return { value: {}, result: true }; })]) {
      await assert.rejects(invoke, { name: "AgentStateCorruptionError", reason, scope: { ...owner, featureId: "sample", key: "state" } });
    }
    assert.equal(transformed, false); assert.equal(data.data.get(prefix + "state"), raw);
  }
  assert.equal(data.calls.compareSets, 0);
  const before = data.calls.gets;
  await assert.rejects(store.read("../state"), /storage key/);
  assert.throws(() => createAgentFeatureStore(data, { ...owner, teamId: "T:OTHER" }, "sample"), /signed Slack/);
  assert.throws(() => createAgentFeatureStore(data, owner, "sample:state"), /agent ID/);
  assert.equal(data.calls.gets, before);
});

test("runtime retains a swallowed diagnosis, blocks later store/service work, and is invocation-local", async () => {
  const data = createMemoryAgentBackend(); let recovered: unknown;
  const feature: AgentFeature = { id: "caught-state", title: "Caught", description: "Test", help: "Caught help",
    async execute(_command, context) {
      try { await context.store.read("state"); } catch (error) { recovered = error; }
      for (const work of [
        () => context.store.read("another-key"),
        () => context.store.update("another-key", 0, () => ({ value: 1, result: true })),
        () => context.services.generate({ instructions: "No call", input: "No call" }),
        () => context.services.search("No call"),
        () => context.services.readContext(),
      ]) { try { await work(); assert.fail("Work should stop after corrupt state"); } catch (error) { assert.equal(error, recovered); } }
      return "No saved records; use list";
    },
  };
  const f = createAgentFeatureFixture(feature, { backend: data }); data.data.set(f.key("state"), "null");
  assertDiagnosis(await f.run("run"), feature);
  assert.equal(data.calls.gets, 1); assert.equal(data.calls.compareSets, 0);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  // A separately invoked valid reader is unaffected; no global cache of the failure.
  const valid = createAgentFeatureFixture({ ...feature, execute: async (_command, ctx) => String(await ctx.store.read("state")) }, { backend: data });
  data.data.set(f.key("state"), "42"); assert.equal(await valid.run("read"), "42");
});

test("a CAS retry that encounters null stops before another transform or write", async () => {
  let armed = true, transforms = 0;
  const data = createMemoryAgentBackend({ beforeCompareSet(key) { if (armed) { armed = false; data.data.set(key, "null"); } } });
  const feature: AgentFeature = { id: "retry-state", title: "Retry", description: "Test", help: "Help",
    execute: (_command, ctx) => ctx.store.update("state", 0, n => { transforms++; return { value: n + 1, result: "Saved" }; }),
  };
  const f = createAgentFeatureFixture(feature, { backend: data });
  assertDiagnosis(await f.run("run"), feature);
  assert.equal(transforms, 1); assert.equal(data.calls.conflicts, 1); assert.equal(data.calls.gets, 2); assert.equal(data.calls.compareSets, 1);
  assert.equal(data.data.get(f.key("state")), "null");
});

test("corruption observed while another update reads prevents its later transform and CAS", { timeout: 5_000 }, async () => {
  const entered = deferred<void>(), release = deferred<void>(); let transforms = 0;
  const data = createMemoryAgentBackend({ beforeGet: async key => { if (key.endsWith(":other")) { entered.resolve(); await release.promise; } } });
  const feature: AgentFeature = { id: "overlapping-state", title: "Overlap", description: "Test", help: "Help",
    async execute(_command, ctx) {
      const pending = ctx.store.update("other", 0, n => { transforms++; return { value: n + 1, result: "Saved" }; });
      await entered.promise;
      try { await assert.rejects(ctx.store.read("state"), { name: "AgentStateCorruptionError" }); }
      finally { release.resolve(); }
      await assert.rejects(pending, { name: "AgentStateCorruptionError" });
      return "No saved records";
    },
  };
  const f = createAgentFeatureFixture(feature, { backend: data }); data.data.set(f.key("state"), "null");
  assertDiagnosis(await f.run("run"), feature);
  assert.equal(transforms, 0); assert.equal(data.calls.compareSets, 0); assert.equal(data.calls.gets, 2);
  assert.equal(data.data.get(f.key("state")), "null"); assert.equal(data.data.has(f.key("other")), false);
});

test("corrupt-state replies finalize receipts without replay or leaking raw bytes", async () => {
  const f = createAgentFeatureFixture(task); f.backend.data.set(f.key("state"), '{"private-secret":');
  assertDiagnosis(await f.run("list", { requestId: "corrupt-request" }), task);
  const before = { ...f.backend.calls };
  assert.match(await f.run("list", { requestId: "corrupt-request" }), /already received/);
  assert.equal(f.backend.calls.gets, before.gets);
  const receipts = [...f.backend.data].filter(([key]) => key.includes("agent-requests"));
  assert.equal(receipts.length, 1); assert.equal(receipts[0][1], '{"state":"finished"}');
  assert.doesNotMatch(JSON.stringify(receipts), /private-secret|corrupt-request/);
  assert.equal(f.backend.data.get(f.key("state")), '{"private-secret":');
});

test("cancellation still wins over a caught corruption error and suppresses receipt finalization", async () => {
  const abort = new AbortController();
  const feature: AgentFeature = { id: "cancel-state", title: "Cancel", description: "Test", help: "Help",
    async execute(_command, ctx) { try { await ctx.store.read("state"); } catch { abort.abort(); } return "Ignored"; },
  };
  const f = createAgentFeatureFixture(feature); f.backend.data.set(f.key("state"), "null");
  await assert.rejects(f.run("run", { signal: abort.signal, requestId: "abort-receipt" }), /abort/i);
  assert.equal(f.backend.calls.compareSets, 1);
  assert.equal(f.backend.data.get(f.key("state")), "null");
});

test("an isolated operator backup and single exact-value CAS refuse a winning valid replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-null-backup-"));
  try {
    const entered = deferred<void>(), release = deferred<void>(); let armed = false;
    const data = createMemoryAgentBackend({ beforeCompareSet: async () => { if (armed) { armed = false; entered.resolve(); await release.promise; } } });
    const f = createAgentFeatureFixture(task, { backend: data }), key = agentStorePrefix(f.owner, task.id) + "state";
    const unrelated = agentStorePrefix({ ...f.owner, userId: "UOTHER" }, task.id) + "state";
    data.data.set(key, "null"); data.data.set(unrelated, "null");
    const observed = await data.get(key); assert.equal(observed, "null");
    const backup = join(dir, "state.raw"), file = await open(backup, "wx", 0o600);
    try { await file.writeFile(observed!, "utf8"); await file.sync(); } finally { await file.close(); }
    assert.equal(await readFile(backup, "utf8"), observed);
    // This is the runbook's single-key CAS, exercised ONLY in an isolated fake backend.
    const initial = '{"version":1,"records":[]}'; armed = true;
    const pending = data.compareSet(key, observed, initial); await entered.promise;
    const valid = '{"version":1,"records":[],"replacement":"private-secret"}';
    // Any replacement, even a domain-valid empty state, must win over the repair.
    data.data.set(key, initial); release.resolve(); assert.equal(await pending, false);
    assert.equal(data.data.get(key), initial); assert.equal(data.data.get(unrelated), "null");
    for (const replacement of [initial, valid, "false", " null ", "{broken"]) {
      data.data.set(key, replacement); assert.equal(await data.compareSet(key, observed, initial), false);
      assert.equal(data.data.get(key), replacement);
    }
    data.data.delete(key); assert.equal(await data.compareSet(key, observed, initial), false);
    data.data.set(key, "null"); assert.equal(await data.compareSet(key, observed, initial), true);
    assert.match(await f.run(task.example!.split("task-breakdown ")[1]), /Saved privately/);
    assert.equal(await readFile(backup, "utf8"), "null"); assert.equal(data.data.get(unrelated), "null");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function backend() {
  const data = new Map<string, string>();
  const expiries = new Map<string, number>();
  const store: AgentStateBackend = {
    async get(key) { return data.get(key) ?? null; },
    async compareSet(key, previous, next, ttl) {
      if ((data.get(key) ?? null) !== previous) return false;
      data.set(key, next);
      if (ttl) expiries.set(key, ttl);
      return true;
    },
  };
  return { ...store, data, expiries };
}
const owner = { teamId: "TTEST", userId: "UTEST" };
const counter: AgentFeature = {
  id: "counter-test", title: "Counter", description: "Test", help: "Counter help",
  async execute(_command, context) {
    return context.store.update("state", 0, (value) => ({ value: value + 1, result: String(value + 1) }));
  },
};
const options = () => ({ backend: backend(), timezone: "UTC", services: createAgentTestContext().services });

test("agent state isolates workspaces, users, features and keys", async () => {
  const data = backend();
  const own = createAgentFeatureStore(data, owner, "one");
  await own.update("state", [], () => ({ value: ["private"], result: true }));
  for (const scoped of [
    createAgentFeatureStore(data, { ...owner, teamId: "TOTHER" }, "one"),
    createAgentFeatureStore(data, { ...owner, userId: "UOTHER" }, "one"),
    createAgentFeatureStore(data, owner, "two"),
  ]) assert.equal(await scoped.read("state"), null);
  assert.deepEqual(await own.read("state"), ["private"]);
  await assert.rejects(() => own.read("../state"), /storage key/);
  assert.throws(() => createAgentFeatureStore(data, { ...owner, teamId: "T:OTHER" }, "one"), /signed Slack/);
});

test("concurrent agent state updates preserve both writes through CAS retries", async () => {
  const data = backend();
  const first = createAgentFeatureStore(data, owner, "one");
  const second = createAgentFeatureStore(data, owner, "one");
  await Promise.all([first, second].map((store) => store.update("count", 0, (value) => ({ value: value + 1, result: value + 1 }))));
  assert.equal(await first.read("count"), 2);
});

test("agent state rejects oversized and cancelled writes without changing data", async () => {
  const data = backend();
  const abort = new AbortController();
  const scoped = createAgentFeatureStore(data, owner, "one", abort.signal);
  await assert.rejects(() => scoped.update("state", "", () => ({ value: "x".repeat(512_001), result: true })), /storage is full/);
  assert.equal(data.data.size, 0);
  abort.abort();
  await assert.rejects(() => scoped.update("state", "", () => ({ value: "secret", result: true })), /abort/i);
  assert.equal(data.data.size, 0);
});

test("agent state reports contention and leaves persisted input intact", async () => {
  let attempts = 0;
  const scoped = createAgentFeatureStore({ get: async () => "0", compareSet: async () => { attempts++; return false; } }, owner, "one");
  await assert.rejects(() => scoped.update("state", 0, () => ({ value: 1, result: true })), /changed repeatedly/);
  assert.equal(attempts, 32);
  assert.equal(await scoped.read("state"), 0);
});

test("agent help needs no database, source read or inference", async () => {
  const settings = options();
  settings.backend.get = async () => { throw new Error("Unexpected database read"); };
  settings.backend.compareSet = async () => { throw new Error("Unexpected database write"); };
  assert.equal(await runAgentFeature(counter, "help", owner, settings), "Counter help");
  await assert.rejects(() => runAgentFeature(counter, "help", {}, settings), /signed Slack/);
});

test("duplicate requests cannot repeat a mutation and receipts retain no reply or input", async () => {
  const settings = options();
  const request = { ...owner, requestId: "signed-trigger-private" };
  const results = await Promise.all([1, 2].map(() => runAgentFeature(counter, "sensitive user content", request, settings)));
  assert.ok(results.includes("1"));
  assert.ok(results.some((text) => text.includes("already received")));
  assert.equal(await createAgentFeatureStore(settings.backend, owner, counter.id).read("state"), 1);
  const receipts = [...settings.backend.data].filter(([key]) => key.includes("agent-requests"));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0][1], '{"state":"finished"}');
  assert.ok(!JSON.stringify(receipts).includes("sensitive"));
  assert.ok(!JSON.stringify(receipts).includes(request.requestId));
  assert.equal(settings.backend.expiries.get(receipts[0][0]), 86_400);
});

test("model and search budgets bound feature work", async () => {
  const settings = options();
  let calls = 0;
  settings.services.generate = async () => { calls++; return "response"; };
  await assert.rejects(() => runAgentFeature({ ...counter, execute: async (_command, context) => {
    for (let i = 0; i < 9; i++) await context.services.generate({ instructions: "Summarize", input: "Data" });
    return "done";
  } }, "run", owner, settings), /eight generation/);
  assert.equal(calls, 8);
  let searches = 0;
  settings.services.search = async (_query, count) => { searches++; assert.equal(count, 8); return []; };
  await assert.rejects(() => runAgentFeature({ ...counter, execute: async (_command, context) => {
    for (let i = 0; i < 7; i++) await context.services.search("query", 500);
    return "done";
  } }, "run", owner, settings), /six web searches/);
  assert.equal(searches, 6);
});

for (const cancellation of ["explicit abort", "internal deadline"] as const) {
  test(`${cancellation} stops pending request receipt acquisition before feature work`, { timeout: 2_000 }, async (t) => {
    const settings = options();
    const controller = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (received: boolean) => void;
    const deferred = new Promise<boolean>((resolve) => { finish = resolve; });
    let calls = 0;
    let featureCalls = 0;
    settings.backend.compareSet = async () => { calls++; started(); return deferred; };
    if (cancellation === "internal deadline") {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        assert.equal(milliseconds, 120_000);
        return timeout(25);
      });
    }
    // AbortSignal timeout timers are unref'd; keep this test alive to observe it.
    const alive = setTimeout(() => {}, 1_000);
    try {
      const pending = runAgentFeature({ ...counter, execute: async (...args) => {
        featureCalls++;
        return counter.execute(...args);
      } }, "run", { ...owner, requestId: "pending-receipt" }, {
        ...settings, signal: cancellation === "explicit abort" ? controller.signal : undefined,
      });
      await active;
      if (cancellation === "explicit abort") controller.abort();
      await assert.rejects(pending, cancellation === "explicit abort" ? /abort/i : /timeout/i);
      assert.equal(featureCalls, 0);
      finish(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(featureCalls, 0, "late receipt acceptance must not start the feature");
      assert.equal(calls, 1, "cancelled commands must not finalize a late receipt");
      assert.equal(settings.backend.data.size, 0);
    } finally { clearTimeout(alive); finish(true); }
  });
}

test("cancellation after generation prevents a subsequent state write", async () => {
  const settings = options();
  const abort = new AbortController();
  settings.services.generate = async () => { abort.abort(); return "response"; };
  await assert.rejects(() => runAgentFeature({ ...counter, execute: async (_command, context) => {
    const answer = await context.services.generate({ instructions: "Summarize", input: "Data" });
    return context.store.update("state", "", () => ({ value: answer, result: answer }));
  } }, "run", owner, { ...settings, signal: abort.signal }), /abort/i);
  assert.equal(settings.backend.data.size, 0);
});

for (const service of ["generate", "search", "readContext"] as const) {
  test(`cancellation stops waiting for pending ${service} and discards late work`, { timeout: 2_000 }, async () => {
    const settings = options();
    const abort = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => { finish = resolve; });
    if (service === "generate") settings.services.generate = async () => { started(); await deferred; return "late response"; };
    if (service === "search") settings.services.search = async () => { started(); await deferred; return []; };
    if (service === "readContext") settings.services.readContext = async () => { started(); await deferred; return []; };
    const pending = runAgentFeature({ ...counter, execute: async (_command, context) => {
      if (service === "generate") await context.services.generate({ instructions: "Summarize", input: "Source" });
      if (service === "search") await context.services.search("query");
      if (service === "readContext") await context.services.readContext();
      return context.store.update("state", 0, () => ({ value: 1, result: "saved" }));
    } }, "run", owner, { ...settings, signal: abort.signal });
    await active;
    abort.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(settings.backend.data.size, 0);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settings.backend.data.size, 0);
  });
}

test("a timeout signal rejects without waiting for generation to settle", { timeout: 2_000 }, async () => {
  const settings = options();
  let finish!: () => void;
  const deferred = new Promise<string>((resolve) => { finish = () => resolve("late"); });
  settings.services.generate = () => deferred;
  // Keep the event loop alive while the unref'd AbortSignal timer fires.
  const alive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(() => runAgentFeature({ ...counter, execute: async (_command, context) =>
      context.services.generate({ instructions: "Summarize", input: "Source" }),
    }, "run", owner, { ...settings, signal: AbortSignal.timeout(25) }), /timeout/i);
    assert.equal(settings.backend.data.size, 0);
  } finally { clearTimeout(alive); finish(); }
});

test("search results discard credential-bearing and non-web URLs", async () => {
  const settings = options();
  settings.services.search = async () => [
    { title: "Good", url: "https://example.com/report", text: "source" },
    { title: "Credential", url: "https://user:pass@example.com", text: "secret" },
    { title: "Script", url: "javascript:alert(1)", text: "bad" },
  ];
  const result = await runAgentFeature({ ...counter, execute: async (_command, context) => JSON.stringify(await context.services.search("query")) }, "run", owner, settings);
  assert.equal(JSON.parse(result).length, 1);
  assert.match(result, /report/);
});
