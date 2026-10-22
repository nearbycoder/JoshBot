import assert from "node:assert/strict";
import test from "node:test";
import { createAgentFeatureStore, type AgentStateBackend } from "../lib/agent-features/store.js";
import { runAgentFeature } from "../lib/agent-features/runtime.js";
import type { AgentFeature } from "../lib/agent-features/types.js";
import { createAgentTestContext } from "./agent-feature-test-utils.js";

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
