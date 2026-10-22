import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/decision-journal.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const child = (s: string) => { const m = s.match(/Child: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
test("catalog workflow preserves locked expectations and reports -12 percentage points", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.replace("/nobo-help agent decision-journal ", "")));
  await f.run(`expect ${id} | completion rate | 60 | percent`); await f.run(`lock ${id}`);
  const original = await record(f, id); await f.run(`outcome ${id} | completion rate | 48 | percent | 2026-11-20`);
  assert.match(await f.run(`review ${id}`), /-12 percentage points/); await f.run(`lesson ${id} | Test the audience before changing the form`);
  const saved = await record(f, id); assert.deepEqual(saved.expectations, original.expectations); assert.equal(saved.rationale, original.rationale); assert.equal(saved.lockedAt, "2026-10-22T15:00:00.000Z"); assert.equal(saved.outcomes[0].date, "2026-11-20");
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("hindsight edits and unit mismatch fail; outcome corrections and lessons remain separate", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("record Choice | Why | 2026-11-20")), e = child(await f.run(`expect ${id} | rate | 60 | percent`));
  await f.run(`expect-edit ${id} ${e} | rate | 65 | percent`); await f.run(`edit ${id} rationale Original reasoning`);
  await assert.rejects(f.run(`outcome ${id} | rate | 50 | percent | 2026-11-20`), /Lock/); await f.run(`lock ${id}`);
  const before = f.backend.data.get(f.key("state"));
  for (const c of [`expect-edit ${id} ${e} | rate | 50 | percent`, `edit ${id} rationale Rewritten`, `remove ${id} expectation ${e} confirm`, `outcome ${id} | rate | 50 | fraction | 2026-11-20`]) await assert.rejects(f.run(c));
  assert.equal(f.backend.data.get(f.key("state")), before);
  const o = child(await f.run(`outcome ${id} | rate | 50 | percent | 2026-11-20`)); await f.run(`outcome ${id} | rate | 48 | percent | 2026-11-21`); assert.equal((await record(f, id)).outcomes[0].id, o);
  const l = child(await f.run(`lesson ${id} | Initial reflection`)); await f.run(`lesson-edit ${id} ${l} | Corrected reflection`); await f.run(`remove ${id} lesson ${l} confirm`); await f.run(`remove ${id} outcome ${o} confirm`); assert.match(await f.run(`review ${id}`), /MISSING outcome/);
  await f.run(`delete ${id} confirm`); await assert.rejects(f.run(`show ${id}`), /not found/);
});
test("civil due lists honor request timezone; invalid dates and duplicate metrics preserve bytes", async () => {
  const f = createAgentFeatureFixture(feature, { now: new Date("2026-11-21T01:00:00Z"), timezone: "America/Chicago" });
  const today = root(await f.run("record Today | Why | 2026-11-20")), future = root(await f.run("record Future | Why | 2026-11-21"));
  const due = await f.run("due"); assert.ok(due.includes(today)); assert.ok(!due.includes(future)); assert.match(due, /2026-11-20 \(America\/Chicago\)/);
  await f.run(`expect ${today} | metric | 0 | units`); const before = f.backend.data.get(f.key("state"));
  for (const c of ["record Impossible | Why | 2026-02-29", `expect ${today} | metric | 2 | units`, `expect ${today} | other | 1e3 | units`, `edit ${today} reviewDate 2026-11-31`]) await assert.rejects(f.run(c));
  assert.equal(f.backend.data.get(f.key("state")), before);
  const corrupt = JSON.parse(before!); corrupt.records[0].lockedAt = "bad"; f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`delete ${today} confirm`), /Invalid saved/); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("20th decision, eight outcomes, five Unicode lessons and full retrieval fit", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push(root(await f.run(`record Choice ${i} | ${"文".repeat(200)} | 2026-11-20`)));
  await assert.rejects(f.run("record Overflow | Why | 2026-11-20")); const lists = (await f.run("list 1")) + (await f.run("list 2")); for (const id of ids) assert.ok(lists.includes(id));
  const id = ids[19]; for (let i = 0; i < 8; i++) await f.run(`expect ${id} | metric ${i} | 10 | units`);
  await assert.rejects(f.run(`expect ${id} | ninth | 1 | units`)); await f.run(`lock ${id}`);
  for (let i = 0; i < 5; i++) await f.run(`lesson ${id} | ${"界".repeat(250)} ${i}`);
  await assert.rejects(f.run(`lesson ${id} | sixth`));
  for (let i = 0; i < 8; i++) await f.run(`outcome ${id} | metric ${i} | -999999.999 | units | 2026-11-20`);
  const out = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(out) <= 24576); assert.equal(JSON.parse(out).record.outcomes.length, 8);
  let cmd = `show ${id}`, all = "", count = 0; while (cmd) { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); all += reply; const next = reply.match(/\/nobo-help agent decision-journal (show [^\n]+)/); cmd = next?.[1] ?? ""; assert.ok(++count < 30); }
  for (const o of JSON.parse(out).record.outcomes) assert.ok(all.includes(o.id)); assert.ok(all.includes("界".repeat(250))); assert.ok(count > 1); await f.run(`delete ${id} confirm`);
});
test("near-content quota permits every reserved outcome and lock", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    try { const id = root(await f.run(`record Choice ${i} | ${"界".repeat(250)} | 2026-11-20`)); ids.push(id); for (let j = 0; j < 8; j++) await f.run(`expect ${id} | ${"文".repeat(28)}${j} | 1 | units`); } catch { break; }
  }
  assert.ok(ids.length > 5);
  for (const id of ids) { const r = await record(f, id); if (!r.expectations.length) continue; await f.run(`lock ${id}`); for (const e of r.expectations) await f.run(`outcome ${id} | ${e.metric} | -999999.999 | units | 2026-11-20`); }
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
});
test("CAS lock conflict cannot apply a stale expectation edit", async () => {
  let armed = false; const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) { if (!armed || !key.endsWith(":state") || !previous) return; armed = false; const state = JSON.parse(previous); state.records[0].revision++; state.records[0].lockedAt = "2026-10-22T15:00:00.000Z"; backend.data.set(key, JSON.stringify(state)); } });
  const f = createAgentFeatureFixture(feature, { backend }), id = root(await f.run("record A | B | 2026-11-20")), e = child(await f.run(`expect ${id} | metric | 60 | percent`)); armed = true;
  await assert.rejects(f.run(`expect-edit ${id} ${e} | metric | 48 | percent`), /changed/); assert.equal((await record(f, id)).expectations[0].predictedValue, 60); assert.equal(backend.calls.conflicts, 1);
});
