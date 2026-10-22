import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/skill-matrix.js";

const CREATE = "create Backend role", PREFIX = "matrix", TITLE = "Backend role";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {
  for (let i = 0; i < 4; i++) {
    const k = uid(await f.run(`skill ${id} add Skill ${i} | 3 | Can explain tradeoffs`), "skill");
    await f.run(`evidence ${id} ${k} | 2026-10-20 | ${"界".repeat(300)}`);
  }
}
test("private skill gaps, explicit rubrics, exact dated examples and full lifecycle", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  const k = uid(await f.run(`skill ${id} add Database design | 3 | Can explain schema and migration tradeoffs`), "skill");
  const unknown = uid(await f.run(`skill ${id} add Operations | 0 | No demonstrated example yet`), "skill");
  assert.match(await f.run(`gaps ${id}`), /self unknown; gap unknown/);
  await f.run(`self-rate ${id} ${k} | 2`);
  assert.match(await f.run(`gaps ${id}`), /self 2; gap 1; unsubstantiated/);
  const eid = uid(await f.run(`evidence ${id} ${k} | 2026-10-20 | Designed a small migration with rollback notes`), "example");
  await f.run(`review ${id} ${k} | Keep level 2 until a larger design is reviewed`);
  const report = await f.run(`gaps ${id}`); assert.match(report, /2 civil days old/); assert.match(report, /gap 1/); assert.ok(report.indexOf(k) < report.indexOf(unknown));
  await f.run(`rubric ${id} ${k} | 2 | Applies with support`);
  assert.equal((await state(f)).records[0].skills[0].self, "");
  await f.run(`self-rate ${id} ${k} | 0`); assert.match(await f.run(`gaps ${id}`), /self 0; gap 3/);
  await f.run(`assessment-remove ${id} ${k} self confirm`);
  await f.run(`review ${id} ${k} | Reflect`); await f.run(`assessment-remove ${id} ${k} reflection confirm`);
  await f.run(`skill ${id} edit ${k} | name | Schema design`); await f.run(`skill ${id} edit ${k} | target | 4`);
  await f.run(`evidence-edit ${id} ${k} ${eid} | 2026-10-21 | Revised example`);
  await f.run(`rubric-remove ${id} ${k} 4 confirm`);
  assert.match(await f.run(`self-rate ${id} ${k} | 4`), /Define every rubric/);
  await f.run(`rubric ${id} ${k} | 4 | Can guide others`);
  await f.run(`skill ${id} clear ${k} name confirm`);
  assert.match(await f.run(`evidence-remove ${id} ${k} ${eid} nope`), /confirm/);
  await f.run(`evidence-remove ${id} ${k} ${eid} confirm`);
  await f.run(`skill ${id} remove ${unknown} confirm`);
  await f.run(`edit ${id} | title | Backend \\| systems`);
  assert.equal(JSON.parse(await reconstruct(f, id)).record.title, "Backend | systems");
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("invalid dates, levels and saved numeric/enumerated types preserve all content", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f), k = uid(await f.run(`skill ${id} add Skill | 3 | Definition`), "skill");
  const before = f.backend.data.get(f.key("state"));
  for (const c of [`self-rate ${id} ${k} | 5`, `self-rate ${id} ${k} | 2e0`, `evidence ${id} ${k} | 2026-02-30 | invalid`, `skill ${id} edit ${k} | missing | value`]) { await f.run(c); assert.equal(f.backend.data.get(f.key("state")), before); }
  for (const bad of [["2"], 2, {}, false]) { const s = JSON.parse(before!); s.records[0].skills[0].self = bad; const raw = JSON.stringify(s); f.backend.data.set(f.key("state"), raw); assert.match(await f.run(`gaps ${id}`), /preserved/); assert.equal(f.backend.data.get(f.key("state")), raw); }
});
test("catalog count caps and UTF-8 limits are enforced without silent clipping", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  for (let i = 0; i < 24; i++) assert.match(await f.run(`skill ${id} add S${i} | 0 | None`), /Saved privately/);
  assert.match(await f.run(`skill ${id} add Overflow | 0 | None`), /Maximum 24/);
  for (let i = 1; i < 10; i++) await setup(f);
  assert.match(await f.run(CREATE), /Maximum 10/);
  const g = createAgentFeatureFixture(feature), gid = await setup(g), k = uid(await g.run(`skill ${gid} add S | 1 | Basic`), "skill");
  for (let i = 0; i < 3; i++) assert.match(await g.run(`evidence ${gid} ${k} | 2026-10-20 | ${"界".repeat(333)}x`), /Saved privately/);
  assert.match(await g.run(`evidence ${gid} ${k} | 2026-10-20 | extra`), /Maximum 3/);
  assert.match(await g.run(`review ${gid} ${k} | ${"界".repeat(107)}`), /too long/);
});
test("saturated admitted Unicode evidence still permits every rating/reflection and complete retrieval", async () => {
  const f = createAgentFeatureFixture(feature); const pairs: [string, string][] = [];
  for (let i = 0; i < 4; i++) {
    const id = await setup(f);
    for (let j = 0; j < 8; j++) { const reply = await f.run(`skill ${id} add S${j} | 3 | Definition`); if (!reply.includes("Saved privately")) break; pairs.push([id, uid(reply, "skill")]); }
  }
  let rejected = false;
  for (const [id, k] of pairs) {
    for (let i = 0; i < 3; i++) { const reply = await f.run(`evidence ${id} ${k} | 2026-10-20 | ${"界".repeat(330)}`); if (!reply.includes("Saved privately")) { assert.match(reply, /quota/); rejected = true; break; } }
    if (rejected) break;
  }
  assert.ok(rejected);
  for (const [id, k] of pairs) { assert.match(await f.run(`self-rate ${id} ${k} | 4`), /Saved privately/); assert.match(await f.run(`review ${id} ${k} | ${esc("\\".repeat(320))}`), /Saved privately/); }
  assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) <= 49152);
  for (const id of new Set(pairs.map(p => p[0]))) assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
});
test("schema-valid over-quota legacy state recovers through exact confirmed child deletion", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f); await populate(f, id);
  const s = await state(f), template = s.records[0];
  for (let i = 1; i < 10; i++) s.records.push({ ...structuredClone(template), id: `matrix-${randomUUID()}` });
  const original = JSON.stringify(s); assert.ok(Buffer.byteLength(original) > 49152); f.backend.data.set(f.key("state"), original);
  assert.match(await f.run(`edit ${id} | title | Ordinary`), /quota/);
  const k = template.skills[0], e = k.evidence[0];
  assert.match(await f.run(`evidence-remove ${id} ${k.id} ${e.id} confirm`), /Saved privately/);
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) < Buffer.byteLength(original));
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) > 49152);
  for (const r of s.records) assert.match(await f.run(`delete ${r.id} confirm`), /Deleted privately/);
});

const route = `/nobo-help agent ${feature.id} `;
const uid = (reply: string, prefix: string) => { const m = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`)); assert.ok(m, reply); return m[0]; };
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
async function state(f: ReturnType<typeof createAgentFeatureFixture>): Promise<any> { return f.store().read("state"); }
async function setup(f: ReturnType<typeof createAgentFeatureFixture>) { return uid(await f.run(CREATE), PREFIX); }
async function reconstruct(f: ReturnType<typeof createAgentFeatureFixture>, id: string): Promise<string> {
  let command = `show ${id}`, body = "";
  for (let i = 0; i < 100; i++) {
    const reply = await f.run(command); assert.ok(reply.length <= 3500, reply.length.toString()); assert.ok(reply.isWellFormed());
    const h = /^.*\nPage \d+\/\d+\n/.exec(reply); assert.ok(h, reply);
    const next = /\nNext: (\/nobo-help agent [^\n]+)$/.exec(reply);
    body += reply.slice(h[0].length, next?.index ?? reply.length);
    if (!next) return body;
    assert.match(next[1], / rev \d+-[a-f0-9]{64}$/);
    command = next[1].slice(route.length);
  }
  assert.fail("Continuation did not terminate.");
}
test("whole-root schema failures preserve bytes; owner and workspace scopes stay isolated", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f), original = f.backend.data.get(f.key("state"))!;
  for (const owner of [{ userId: "UOTHER", teamId: "TFIXTURE" }, { userId: "UFIXTURE", teamId: "TOTHER" }]) {
    assert.match(await f.run(`show ${id}`, { owner }), /not found/i);
    assert.match(await f.run(`delete ${id} confirm`, { owner }), /not found/i);
  }
  for (const corrupt of ['null', '{broken', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ ...JSON.parse(original).records[0], revision: "1" }] })]) {
    f.backend.data.set(f.key("state"), corrupt);
    assert.match(await f.run(`delete ${id} confirm`), /saved data|preserved|read safely/i);
    assert.equal(f.backend.data.get(f.key("state")), corrupt);
  }
  f.backend.data.set(f.key("state"), original);
  assert.equal(JSON.parse(await reconstruct(f, id)).record.id, id);
});
test("backend synchronous, rejected and after-dispatch exceptions never expose diagnostics", async () => {
  for (const operation of ["get-sync", "get-reject", "cas-sync", "cas-reject", "cas-after"]) {
    const backend = createMemoryAgentBackend(), f = createAgentFeatureFixture(feature, { backend });
    const id = await setup(f), oldGet = backend.get, oldCas = backend.compareSet;
    const secret = "FAKE_SECRET_diagnostic_9321";
    if (operation === "get-sync") backend.get = () => { throw new Error(secret); };
    if (operation === "get-reject") backend.get = () => Promise.reject(new Error(secret));
    if (operation === "cas-sync") backend.compareSet = () => { throw new Error(secret); };
    if (operation === "cas-reject") backend.compareSet = () => Promise.reject(new Error(secret));
    if (operation === "cas-after") backend.compareSet = async (...args) => { await oldCas(...args); throw new Error(secret); };
    const reply = await f.run(`edit ${id} | title | Updated`);
    assert.doesNotMatch(reply, new RegExp(secret)); assert.match(reply, /inspect.*before repeating/i);
    backend.get = oldGet; backend.compareSet = oldCas;
    assert.equal((await state(f)).records[0].title, operation === "cas-after" ? "Updated" : TITLE);
  }
});
test("real CAS conflicts retry unrelated records but reject same-target edits and deletion", async () => {
  for (const kind of ["unrelated", "same", "delete"]) {
    let armed = false, key = "", target = "", other = "";
    const backend = createMemoryAgentBackend({ beforeCompareSet(k) {
      if (!armed || k !== key) return; armed = false;
      const s = JSON.parse(backend.data.get(k)!);
      if (kind === "delete") s.records = s.records.filter((r: any) => r.id !== target);
      else s.records.find((r: any) => r.id === (kind === "same" ? target : other)).title = "Concurrent";
      backend.data.set(k, JSON.stringify(s));
    } });
    const f = createAgentFeatureFixture(feature, { backend }); target = await setup(f); other = await setup(f); key = f.key("state"); armed = true;
    const reply = await f.run(`edit ${target} | title | Intended`), s = await state(f);
    assert.equal(backend.calls.conflicts, 1);
    if (kind === "unrelated") { assert.match(reply, /Saved privately/); assert.equal(s.records.find((r: any) => r.id === other).title, "Concurrent"); assert.equal(s.records.find((r: any) => r.id === target).title, "Intended"); }
    else { assert.match(reply, /changed|not found/i); assert.ok(!s.records.some((r: any) => r.title === "Intended")); }
  }
});
test("ceiling refuses writes, permits exact removals and rejects old content-stamped continuation", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f); await populate(f, id);
  const s = await state(f); s.records[0].revision = 999999999; f.backend.data.set(f.key("state"), JSON.stringify(s));
  const before = await f.run(`show ${id}`), continuation = /Next: (\/nobo-help agent [^\n]+)/.exec(before)?.[1]; assert.ok(continuation, before);
  assert.match(await f.run(`edit ${id} | title | Refuse`), /Revision limit/);
  const reply = await f.run(`clear ${id} title confirm`); assert.match(reply, /Saved privately/);
  assert.equal((await state(f)).records[0].revision, 999999999);
  assert.match(await f.run(continuation.slice(route.length)), /stale continuation/i);
  assert.match(await f.run(`delete ${id} confirm`), /Deleted privately/);
  assert.equal((await state(f)).records.length, 0);
});
