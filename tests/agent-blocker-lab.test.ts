import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/blocker-lab.js";
import { createAgentFeatureFixture, deferred } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const child = (s: string) => { const m = s.match(/Child: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
test("catalog workflow chooses an actual saved diagnostic test and never infers causation", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.replace("/nobo-help agent blocker-lab ", "")));
  await f.run(`observation ${id} add I restarted the outline three times`);
  const h = child(await f.run(`hypothesis ${id} add Audience is unclear`)), t = child(await f.run(`test ${id} ${h} | Ask reader to choose one audience | Reader selects one audience | 10`));
  const expensive = child(await f.run(`test ${id} ${h} | Rewrite whole draft | Reader accepts it | 60`));
  assert.match(await f.run(`next ${id}`), new RegExp(`test ${t}: 10 minutes`)); await f.run(`result ${id} ${t} | supports | Reader selected beginners`);
  const review = await f.run(`review ${id}`); assert.match(review, /Observation.*I restarted/); assert.match(review, /Hypothesis \(guess\).*Audience/); assert.match(review, /1 supports/);
  assert.equal((await record(f, id)).status, "open"); assert.ok((await f.run(`next ${id}`)).includes(expensive));
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("evidence and dependency/decision paths stay distinct and cycles terminate", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("open Draft | Understand delay"));
  const o = child(await f.run(`observation ${id} add Draft is late`)), a = child(await f.run(`hypothesis ${id} add Waiting on source`)), b = child(await f.run(`hypothesis ${id} add Need audience decision`));
  const e = child(await f.run(`link ${id} ${o} | ${a} | evidence | Does timing support this guess?`));
  const d = child(await f.run(`link ${id} ${a} | ${b} | dependency | What input is missing?`)); await f.run(`link ${id} ${b} | ${a} | dependency | Is this a circular dependency?`); await f.run(`link ${id} ${a} | ${b} | decision | Who can choose?`);
  const paths = await f.run(`paths ${id} ${a}`); assert.match(paths, /dependency paths/); assert.match(paths, /decision paths/); assert.match(paths, /already visited/); assert.ok(!paths.includes(e)); assert.ok(paths.includes(d));
  assert.match(await f.run(`review ${id}`), /Unanswered/); await assert.rejects(f.run(`remove ${id} hypothesis ${a} confirm`), /linked/);
  await assert.rejects(f.run(`link ${id} ${a} | ${b} | evidence | Wrong source type`), /Invalid saved/);
});
test("edits, removals, strict escapes and explicit statuses work without hidden retention", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(String.raw`open Draft \| outline | C:\\notes`)), h = child(await f.run(`hypothesis ${id} add Audience`));
  const t = child(await f.run(`test ${id} ${h} | Ask | Answer | 0`)); await f.run(`result ${id} ${t} | inconclusive | No answer`);
  await assert.rejects(f.run(`hypothesis ${id} edit ${h} New guess`), /Remove/); await f.run(`remove ${id} result ${t} confirm`); await f.run(`test-edit ${id} ${t} | ${h} | Ask again | Clear answer | 2`);
  await f.run(`hypothesis ${id} edit ${h} Better guess`); await f.run(`status ${id} paused`); assert.match(await f.run(`next ${id}`), /no diagnostic action/);
  await f.run(`remove ${id} test ${t} confirm`); await f.run(`remove ${id} hypothesis ${h} confirm`); assert.match(await f.run(`next ${id}`), /status .* open/); await f.run(`status ${id} open`); assert.match(await f.run(`next ${id}`), /hypothesis .* add/);
  const r = await record(f, id); assert.equal(r.title, "Draft | outline"); assert.equal(r.problem, "C:\\notes"); await f.run(`delete ${id} confirm`); await assert.rejects(f.run(`show ${id}`), /not found/);
});
test("malformed input and saved links are refused byte-for-byte", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("open A | B")), h = child(await f.run(`hypothesis ${id} add Guess`)); const before = f.backend.data.get(f.key("state"));
  for (const c of [`test ${id} ${h} | A | B | -1`, `test ${id} ${h} | A | B | 1e2`, `link ${id} ${h} | ${h} | dependency | cycle`, "open A\\q | B"]) await assert.rejects(f.run(c));
  assert.equal(f.backend.data.get(f.key("state")), before); const corrupt = JSON.parse(before!); corrupt.records[0].hypotheses.push(corrupt.records[0].hypotheses[0]); f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`delete ${id} confirm`), /Duplicate/); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("last root and child, complete export and Unicode lifecycle fit accepted bounds", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(root(await f.run(`open Case ${i} | Problem`)));
  await assert.rejects(f.run("open Overflow | Problem")); const lists = (await f.run("list 1")) + (await f.run("list 2")); for (const id of ids) assert.ok(lists.includes(id));
  const id = ids[11], h = child(await f.run(`hypothesis ${id} add ${"文".repeat(200)}`)), tests: string[] = [];
  for (let i = 0; i < 19; i++) tests.push(child(await f.run(`test ${id} ${h} | ${"界".repeat(100)} | Expected ${i} | ${i}`)));
  await assert.rejects(f.run(`observation ${id} add Overflow`)); for (const t of tests) await f.run(`result ${id} ${t} | inconclusive | ${"語".repeat(85)}`);
  const out = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(out) <= 24576); assert.equal(JSON.parse(out).record.tests.length, 19);
  let cmd = `show ${id}`, all = "", n = 0; while (cmd) { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); all += reply; const m = reply.match(/\/nobo-help agent blocker-lab (show [^\n]+)/); cmd = m?.[1] ?? ""; assert.ok(++n < 30); }
  for (const t of tests) assert.ok(all.includes(t)); assert.ok(all.includes("語".repeat(85))); assert.ok(n > 1); await f.run(`status ${id} closed`); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152); await f.run(`delete ${id} confirm`);
});
test("one optional suggestion discards stale output after edit; failures preserve deterministic route", async () => {
  const result = deferred<string>(), started = deferred<void>(); const f = createAgentFeatureFixture(feature, { services: { generate: async () => { started.resolve(); return result.promise; } } });
  const id = root(await f.run("open Draft | Delay")); const pending = f.run(`suggest ${id}`); await started.promise; await f.run(`edit ${id} problem Different delay`); result.resolve('["Could the audience be unclear?"]'); await assert.rejects(pending, /changed/); assert.equal(f.calls.generate, 1); assert.equal((await record(f, id)).problem, "Different delay");
  const g = createAgentFeatureFixture(feature), other = root(await g.run("open A | B")); const before = g.backend.data.get(g.key("state")); assert.match(await g.run(`suggest ${other}`), /Assistance unavailable/); assert.equal(g.backend.data.get(g.key("state")), before);
  const invalid = createAgentFeatureFixture(feature, { services: { generate: async () => JSON.stringify(Array(6).fill("Guess")) } }); const third = root(await invalid.run("open A | B")); assert.match(await invalid.run(`suggest ${third}`), /Assistance unavailable/); assert.equal(invalid.calls.generate, 1);
});
