import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/estimate-calibration.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const id = (reply: string) => { const m = reply.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, reply); return m[1]; };
const exported = async (f: ReturnType<typeof createAgentFeatureFixture>, key: string) => JSON.parse(await f.run(`export ${key}`)).record;

test("catalog workflow computes paired errors and an unsaved 120-minute forecast", async () => {
  const f = createAgentFeatureFixture(feature);
  const a = id(await f.run(feature.example!.replace("/nobo-help agent estimate-calibration ", "")));
  await f.run(`actual ${a} | 90`);
  const b = id(await f.run("estimate Revise article | writing | 30")); await f.run(`actual ${b} | 45`);
  const c = id(await f.run("estimate Outline article | writing | 20")); await f.run(`actual ${c} | 30`);
  const report = await f.run("report writing"); assert.match(report, /Complete, nonexcluded: 3/); assert.match(report, /ratio: 1.5/); assert.match(report, /absolute error: 15 minutes/);
  const before = f.backend.data.get(f.key("state")); assert.match(await f.run("forecast writing | 80"), /= 120 minutes \(n=3\)/); assert.equal(f.backend.data.get(f.key("state")), before);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("zero, exclusions, corrections and insufficient samples retain the frozen original", async () => {
  const f = createAgentFeatureFixture(feature); const a = id(await f.run("estimate A | writing | 10"));
  await f.run(`actual ${a} | 0`); assert.match(await f.run("report writing"), /ratio: 0/); assert.match(await f.run("forecast writing | 10"), /No adjustment/);
  const b = id(await f.run("estimate B | writing | 10")); await f.run(`exclude ${b} | Interrupted`);
  await f.run(`correct ${a} | 20 | Typo in initial entry`); await f.run(`edit ${a} label Revised label`);
  assert.equal((await exported(f, a)).estimatedMinutes, 10); assert.equal((await exported(f, a)).correction.minutes, 20);
  assert.match(await f.run("report writing"), /excluded: 1 \(1 incomplete\)/);
  await f.run(`remove ${a} correction confirm`); await f.run(`remove ${a} actual confirm`); await f.run(`remove ${b} exclusion confirm`);
  assert.match(await f.run("report writing"), /incomplete, nonexcluded: 2/);
  await f.run(`delete ${a} confirm`); await assert.rejects(f.run(`show ${a}`), /not found/);
});

test("malformed inputs and schema cannot alter serialized state", async () => {
  const f = createAgentFeatureFixture(feature); const a = id(await f.run("estimate A | writing | 1"));
  const before = f.backend.data.get(f.key("state"));
  for (const command of ["estimate A | writing | 0", "estimate A | writing | 1e2", `actual ${a} | -1`, `correct ${a} | 2 | `, "estimate bad\\q | x | 2", `edit ${a} estimatedMinutes 5`]) await assert.rejects(f.run(command));
  assert.equal(f.backend.data.get(f.key("state")), before);
  f.backend.data.set(f.key("state"), before!.replace('"actualMinutes":null', '"actualMinutes":0'));
  const corrupt = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`delete ${a} confirm`), /Invalid saved/); assert.equal(f.backend.data.get(f.key("state")), corrupt);
});

test("all 60 samples and the final list page are complete; categories and count are bounded", async () => {
  const f = createAgentFeatureFixture(feature); const ids: string[] = [];
  for (let i = 0; i < 60; i++) ids.push(id(await f.run(`estimate Sample ${i} | category ${i % 12} | 1`)));
  const pages = [1, 2, 3, 4, 5, 6];
  let all = ""; for (const p of pages) { const reply = await f.run(`list ${p}`); assert.ok(reply.length <= 3500); all += reply; }
  for (const key of ids) assert.ok(all.includes(key));
  assert.equal((await exported(f, ids[59])).label, "Sample 59");
  await assert.rejects(f.run("estimate Too many | category 0 | 1"));
  await assert.rejects(f.run(`edit ${ids[0]} category category 13`));
  await f.run(`actual ${ids[59]} | 0`); assert.equal((await exported(f, ids[59])).actualMinutes, 0);
});

test("Unicode admission leaves actual completion space and exact export; stale revision pages fail", async () => {
  const f = createAgentFeatureFixture(feature); const ids: string[] = [];
  for (let i = 0; i < 60; i++) {
    try { const key = id(await f.run(`estimate ${"文".repeat(39)} | work | 60`)); ids.push(key); await f.run(`exclude ${key} | ${"界".repeat(250)}`); } catch { break; }
  }
  assert.ok(ids.length > 15); const before = f.backend.data.get(f.key("state"));
  await assert.rejects(f.run(`exclude ${ids[0]} | ${"x".repeat(769)}`)); assert.equal(f.backend.data.get(f.key("state")), before);
  for (const key of ids) await f.run(`actual ${key} | 999999.999`);
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
  const key = ids[0], record = await exported(f, key), out = await f.run(`export ${key}`); assert.ok(Buffer.byteLength(out) <= 24576); assert.equal(record.excludedReason, "界".repeat(250));
  await assert.rejects(f.run(`show ${key} page 1 rev 1`), /changed/);
  await f.run(`delete ${key} confirm`);
});

test("CAS conflict rejects stale correction while preserving the concurrent edit", async () => {
  let armed = false;
  const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) {
    if (!armed || !key.endsWith(":state") || !previous) return; armed = false;
    const state = JSON.parse(previous); state.records[0].revision++; state.records[0].label = "Concurrent label"; backend.data.set(key, JSON.stringify(state));
  } });
  const f = createAgentFeatureFixture(feature, { backend }); const key = id(await f.run("estimate A | work | 10")); armed = true;
  await assert.rejects(f.run(`correct ${key} | 30 | typo`), /changed/);
  const r = await exported(f, key); assert.equal(r.label, "Concurrent label"); assert.equal(r.correction, null); assert.equal(backend.calls.conflicts, 1);
});
