import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/estimate-calibration.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const id = (reply: string) => { const m = reply.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, reply); return m[1]; };
const exported = async (f: ReturnType<typeof createAgentFeatureFixture>, key: string) => JSON.parse(await f.run(`export ${key}`)).record;

for (const example of [
  { name: "reported tiny ratio", estimate: 10000, actual: 0.001, base: 10000, multiplier: "1e-7", forecast: "0.001" },
  { name: "smallest positive accepted ratio", estimate: 1000000, actual: 0.001, base: 1, multiplier: "1e-9", forecast: "1e-9" },
  { name: "largest accepted ratio and forecast", estimate: 0.001, actual: 1000000, base: 1000000, multiplier: "1000000000", forecast: "1000000000000000" },
  { name: "known zero actual", estimate: 10000, actual: 0, base: 10000, multiplier: "0", forecast: "0" },
]) test(`calibration displays ${example.name} without losing magnitude`, async () => {
  const f = createAgentFeatureFixture(feature);
  for (let i = 0; i < 3; i++) {
    const sample = id(await f.run(`estimate Work ${i} | precision | ${example.estimate}`));
    await f.run(`actual ${sample} | ${example.actual}`);
  }
  const before = f.backend.data.get(f.key("state"));
  const report = await f.run("report precision"), forecast = await f.run(`forecast precision | ${example.base}`);
  assert.ok(report.includes(`ratio: ${example.multiplier}.`), report);
  assert.ok(report.includes(`Preview multiplier: ${example.multiplier} (n=3)`), report);
  assert.ok(forecast.includes(`${example.base} × ${example.multiplier} = ${example.forecast} minutes (n=3)`), forecast);
  assert.equal(Number(example.base) * Number(example.multiplier), Number(example.forecast));
  assert.equal(f.backend.data.get(f.key("state")), before);
});

test("even tiny medians retain zero actuals, use corrections and exclude explicit outliers", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (const actual of [0, 0.001, 0.003, 0.01]) {
    const sample = id(await f.run("estimate Tiny | precision | 1000000")); ids.push(sample);
    await f.run(`actual ${sample} | ${actual}`);
  }
  assert.match(await f.run("report precision"), /ratio: 2e-9/);
  assert.match(await f.run("forecast precision | 1000000"), /1000000 × 2e-9 = 0.002 minutes \(n=4\)/);
  await f.run(`correct ${ids[2]} | 500000 | Correct entered estimate`);
  assert.match(await f.run("report precision"), /ratio: 3.5e-9/);
  assert.match(await f.run("report precision"), /Explicit corrections used: 1/);
  assert.equal((await exported(f, ids[2])).estimatedMinutes, 1000000);
  await f.run(`exclude ${ids[3]} | Different work`);
  assert.match(await f.run("report precision"), /ratio: 1e-9/);
  assert.match(await f.run("forecast precision | 1000000"), /= 0.001 minutes \(n=3\)/);
});

test("rounded reports and formulas disclose approximation and retain the exact entered base", async () => {
  const f = createAgentFeatureFixture(feature);
  for (let i = 0; i < 3; i++) {
    const sample = id(await f.run(`estimate Third ${i} | thirds | 3`)); await f.run(`actual ${sample} | 1`);
  }
  const report = await f.run("report thirds");
  assert.match(report, /ratio: ≈ 0.333333/); assert.match(report, /Preview multiplier: ≈ 0.333333/);
  assert.match(report, /6 significant digits/);
  const forecast = await f.run("forecast thirds | 3");
  assert.match(forecast, /3 × 0.333333 ≈ 1 minutes/);
  assert.doesNotMatch(forecast, /× 0.333333 =/);
  assert.match(forecast, /unrounded median/);
  assert.match(await f.run("forecast thirds | 999999.999"), /999999.999 × 0.333333 ≈ 333333 minutes/);
});

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
