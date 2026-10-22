import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/assumption-tests.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const observation = (s: string) => { const m = s.match(/Observation: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
test("catalog workflow locks criterion, evaluates, and retains original result through revision", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.replace("/nobo-help agent assumption-tests ", "")));
  await f.run(`method ${id} | Show the form to ten volunteers and count completions`); await f.run(`lock ${id}`);
  await f.run(`observe ${id} | 2026-10-23 | 6 | 40 | Six completed`); const reply = await f.run(`evaluate ${id}`); assert.match(reply, /Criterion met for this test/); assert.match(reply, /Effort 40\/60/);
  const original = (await record(f, id)).versions[0]; await f.run(`revise ${id} | Follow-up with a different audience`); const saved = await record(f, id); assert.deepEqual(saved.versions[0], original); assert.equal(saved.versions[1].lockedAt, null); assert.equal(saved.versions[1].observations.length, 0);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("insufficient samples, mean boundary arithmetic, exceeded effort and locked edits", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Belief | count | at-most | 0.15 | 2 | 0.3"));
  await assert.rejects(f.run(`observe ${id} | 2026-10-23 | 0.1 | 0.1 | -`), /Lock/); await assert.rejects(f.run(`lock ${id}`), /procedure/);
  await f.run(`method ${id} | Measure twice`); await f.run(`lock ${id}`); await f.run(`observe ${id} | 2026-10-23 | 0.1 | 0.1 | -`); assert.match(await f.run(`evaluate ${id}`), /Insufficient observations/);
  const obs = observation(await f.run(`observe ${id} | 2026-10-24 | 0.2 | 0.2 | -`)); assert.match(await f.run(`evaluate ${id}`), /Criterion met/); assert.match(await f.run(`evaluate ${id}`), /within entered cap/);
  await f.run(`observe-edit ${id} | ${obs} | 2026-10-24 | 0.2 | 0.3 | Correction`); assert.equal((await record(f, id)).versions[0].result, null); assert.match(await f.run(`evaluate ${id}`), /EXCEEDED effort cap/);
  const original = (await record(f, id)).versions[0]; await f.run(`edit ${id} threshold 0.2`); const saved = await record(f, id); assert.deepEqual(saved.versions[0], original); assert.equal(saved.versions[1].threshold, 0.2); assert.equal(saved.versions[1].lockedAt, null);
});
test("three retained designs are bounded; edits/removals and original evidence stay visible", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create A | count | at-least | 1 | 1 | 10"));
  await f.run(`method ${id} | Count`); await f.run(`lock ${id}`); await f.run(`revise ${id} | Follow-up`); await f.run(`edit ${id} belief B`); await f.run(`remove ${id} revisionReason confirm`); await f.run(`lock ${id}`); await f.run(`edit ${id} threshold 2`); await f.run(`lock ${id}`);
  await assert.rejects(f.run(`revise ${id} | Fourth`), /Three retained/); const obs = observation(await f.run(`observe ${id} | 2026-10-23 | 3 | 4 | A note`));
  await f.run(`remove ${id} note ${obs} confirm`); assert.equal((await record(f, id)).versions[2].observations[0].note, null); await f.run(`remove ${id} observation ${obs} confirm`); assert.match(await f.run(`evaluate ${id}`), /Insufficient/);
  await f.run(`delete ${id} confirm`); await assert.rejects(f.run(`show ${id}`), /not found/);
});
test("malformed commands and inconsistent evaluations leave serialized bytes untouched", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create A | count | at-least | 1 | 1 | 10")); await f.run(`method ${id} | Count`); await f.run(`lock ${id}`); await f.run(`evaluate ${id}`); const before = f.backend.data.get(f.key("state"));
  for (const c of [`observe ${id} | 2026-02-29 | 1 | 1 | -`, `observe ${id} | 2026-10-23 | 1e3 | 1 | -`, `observe ${id} | 2026-10-23 | 1 | -1 | -`, `edit ${id} direction larger`, "create A | count | at-least | 1 | 21 | 10"]) await assert.rejects(f.run(c));
  assert.equal(f.backend.data.get(f.key("state")), before); const corrupt = JSON.parse(before!); corrupt.records[0].versions[0].result.criterion = "met"; f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`delete ${id} confirm`), /does not match/); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("12th root and 20th observation are retrievable; Unicode optional notes and completion fit", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(root(await f.run(`create Belief ${i} | count | at-least | 1 | 1 | 100`)));
  await assert.rejects(f.run("create Too many | count | at-least | 1 | 1 | 10")); const lists = (await f.run("list 1")) + (await f.run("list 2")); for (const id of ids) assert.ok(lists.includes(id));
  const id = ids[11]; await f.run(`method ${id} | ${"文".repeat(250)}`); await f.run(`lock ${id}`); const obs: string[] = [];
  for (let i = 0; i < 20; i++) obs.push(observation(await f.run(`observe ${id} | 2026-10-23 | ${i} | 1 | ${"界".repeat(85)}`)));
  await assert.rejects(f.run(`observe ${id} | 2026-10-23 | 1 | 1 | -`)); assert.match(await f.run(`evaluate ${id}`), /mean 9.5/);
  const out = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(out) <= 24576); assert.equal(JSON.parse(out).record.versions[0].observations.length, 20);
  let cmd = `show ${id}`, all = "", count = 0; while (cmd) { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); all += reply; const next = reply.match(/\/nobo-help agent assumption-tests (show [^\n]+)/); cmd = next?.[1] ?? ""; assert.ok(++count < 30); }
  for (const oid of obs) assert.ok(all.includes(oid)); assert.ok(all.includes("界".repeat(85))); assert.ok(count > 1); await f.run(`delete ${id} confirm`);
});
test("near quota reservations allow minimum numeric sample completion for every admitted design", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 12; i++) { try { const id = root(await f.run(`create ${"文".repeat(35)}${i} | count | at-least | 1 | 20 | 100`)); ids.push(id); await f.run(`method ${id} | ${"界".repeat(250)}`); } catch { break; } }
  assert.ok(ids.length >= 5); let completed = 0;
  for (const id of ids) { const r = await record(f, id); if (!r.versions[0].method) continue; await f.run(`lock ${id}`); for (let j = 0; j < 20; j++) await f.run(`observe ${id} | 2026-10-23 | -999999.999 | 999999.999 | -`); assert.match(await f.run(`evaluate ${id}`), /Criterion not met/); completed++; }
  assert.ok(completed >= 5); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
});
test("concurrent locked design wins against stale criterion update", async () => {
  let armed = false; const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) { if (!armed || !key.endsWith(":state") || !previous) return; armed = false; const s = JSON.parse(previous); s.records[0].revision++; s.records[0].versions[0].lockedAt = "2026-10-22T15:00:00.000Z"; backend.data.set(key, JSON.stringify(s)); } });
  const f = createAgentFeatureFixture(feature, { backend }), id = root(await f.run("create A | count | at-least | 5 | 1 | 10")); await f.run(`method ${id} | Count`); armed = true;
  await assert.rejects(f.run(`edit ${id} threshold 1`), /changed/); const r = await record(f, id); assert.equal(r.versions[0].threshold, 5); assert.equal(r.versions.length, 1); assert.equal(backend.calls.conflicts, 1);
});
