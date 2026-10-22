import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/achievement-portfolio.js";

const CREATE = "create Simplified onboarding | New users struggled with setup", PREFIX = "achievement", TITLE = "Simplified onboarding";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {
  for (let i = 0; i < 7; i++) assert.match(await f.run(`evidence ${id} | Evidence ${i} | ${"界".repeat(500)}`), /Saved privately/);
}
async function worked(f: ReturnType<typeof createAgentFeatureFixture>) {
  const id = await setup(f);
  await f.run(`action ${id} | Wrote and tested a five-step installation guide`);
  await f.run(`result ${id} | Setup support requests decreased | 12 | requests per month | 20`);
  const e = uid(await f.run(`evidence ${id} | Support summary | Recorded 20 requests before and 12 after`), "evidence");
  await f.run(`collaborators ${id} | Maya reviewed the guide`);
  return { id, e };
}
test("worked measurement remains exact, personal/team attribution separate, full edits and removal", async () => {
  const f = createAgentFeatureFixture(feature), { id, e } = await worked(f);
  const report = await f.run(`story ${id}`); assert.match(report, /20 → 12 requests per month/); assert.match(report, /Decrease: 8 requests per month/); assert.match(report, /40% using denominator \|20\|/); assert.match(report, /Maya reviewed the guide/); assert.match(report, /not proof of causation/);
  assert.match(await f.run(`bullets ${id}`), /Personal action/);
  for (const [field, val] of [["title", "Review evidence"], ["challenge", "Different challenge"], ["action", "Personal action"], ["result", "Reported result"], ["collaborators", "Team support"], ["privacy", "Internal only"], ["metric.value", "12.00"], ["metric.unit", "requests per month"], ["metric.baseline", "0"]]) assert.match(await f.run(`edit ${id} | ${field} | ${val}`), /Saved privately/);
  assert.match(await f.run(`story ${id}`), /Percentage unknown: zero baseline/);
  await f.run(`evidence-edit ${id} ${e} | Summary \\| corrected | Exact \\| text with \\\\ slash`);
  assert.equal((await state(f)).records[0].evidence[0].text, "Exact | text with \\ slash");
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  assert.match(await f.run(`evidence-remove ${id} ${e} nope`), /confirm/);
  await f.run(`evidence-remove ${id} ${e} confirm`);
  for (const field of ["title", "challenge", "action", "result", "collaborators", "privacy", "metric.value", "metric.unit", "metric.baseline"]) assert.match(await f.run(`clear ${id} ${field} confirm`), /Saved privately/);
  assert.match(await f.run(`story ${id}`), /Missing: challenge, personal action, result, evidence/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("finite optional rewrite cannot invent facts, alter attribution or omit evidence", async () => {
  let mode = "valid";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input, instructions }) => {
    assert.ok(Buffer.byteLength(input) <= 16000); assert.ok(Buffer.byteLength(instructions) <= 4000);
    const r = JSON.parse(input).record;
    const good = { layout: "action-first", evidenceIds: r.evidence.map((e: any) => e.id) };
    if (mode === "valid") return JSON.stringify(good);
    if (mode === "extra") return JSON.stringify({ ...good, prose: "I alone caused a 99% decrease and Maya did nothing" });
    if (mode === "unknown") return JSON.stringify({ ...good, evidenceIds: ["invented"] });
    if (mode === "enum") return JSON.stringify({ ...good, layout: ["action-first"] });
    return "x".repeat(4001);
  } } });
  const { id } = await worked(f), original = f.backend.data.get(f.key("state"));
  const result = await f.run(`polish ${id} | resume`); assert.match(result, /Unsaved resume structural rewrite/); assert.match(result, /20 → 12 requests per month/); assert.match(result, /Maya reviewed the guide/); assert.ok(result.length <= 3500); assert.equal(f.backend.data.get(f.key("state")), original);
  for (mode of ["extra", "unknown", "enum", "oversize"]) assert.match(await f.run(`polish ${id} | review`), /invalid or oversized/);
  assert.equal(f.calls.generate, 5); assert.equal(f.calls.readContext, 0); assert.equal(f.calls.search, 0);
});
test("impossible complete assistance, bad audience or missing evidence spends zero calls", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  await f.run(`polish ${id} | resume`); await f.run(`polish ${id} | bogus`); assert.equal(f.calls.generate, 0);
  await f.run(`action ${id} | Action`); await f.run(`edit ${id} | result | Result`); await populate(f, id);
  assert.match(await f.run(`polish ${id} | review`), /cannot fit.*no model call/); assert.equal(f.calls.generate, 0);
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
});
test("late generation cannot survive an edit, deletion or abort; provider diagnostics stay private", async () => {
  for (const change of ["edit", "delete", "abort", "error"]) {
    const gate = deferred<string>(), started = deferred<void>(); let out = "";
    const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => { out = JSON.stringify({ layout: "result-first", evidenceIds: JSON.parse(input).record.evidence.map((e: any) => e.id) }); started.resolve(); return gate.promise; } } });
    const { id } = await worked(f), abort = new AbortController(), pending = f.run(`polish ${id} | review`, { signal: abort.signal }); await started.promise;
    if (change === "edit") await f.run(`edit ${id} | title | New`);
    if (change === "delete") await f.run(`delete ${id} confirm`);
    if (change === "abort") abort.abort();
    if (change === "error") gate.reject(new Error("FAKE_SECRET_provider")); else gate.resolve(out);
    if (change === "abort") { await assert.rejects(pending, /abort/i); continue; }
    const reply = await pending; assert.doesNotMatch(reply, /FAKE_SECRET|Unsaved review structural rewrite/);
    if (change === "edit") assert.match(reply, /changed/);
    if (change === "delete") assert.equal((await state(f)).records.length, 0);
    assert.equal(f.calls.generate, 1);
  }
});
test("caps, malformed metrics, saturated content and legacy removal retain exact accepted bytes", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  for (let i = 0; i < 8; i++) assert.match(await f.run(`evidence ${id} | Label | ${"界".repeat(500)}`), /Saved privately/);
  assert.match(await f.run(`evidence ${id} | Extra | Text`), /Maximum 8/);
  const original = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`result ${id} | Result | 1e3 | requests | 20`), /plain decimal/);
  assert.equal(f.backend.data.get(f.key("state")), original);
  const second = await setup(f);
  assert.match(await f.run(`evidence ${second} | Limit | ${"x".repeat(501)}`), /too long/);
  let full = false;
  for (let i = 0; i < 8; i++) { const reply = await f.run(`evidence ${second} | L | ${"界".repeat(500)}`); full ||= /quota/.test(reply); }
  for (const rid of [id, second]) for (const field of ["action", "result", "challenge", "collaborators", "privacy"]) { const reply = await f.run(`edit ${rid} | ${field} | ${"界".repeat(333)}`); full ||= /quota/.test(reply); }
  assert.ok(full); assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) <= 32768);
  for (const rid of [id, second]) assert.deepEqual(JSON.parse(await reconstruct(f, rid)), JSON.parse(await f.run(`export ${rid}`)));
  const legacy = await state(f); for (let i = 0; i < 3; i++) legacy.records.push({ ...structuredClone(legacy.records[0]), id: `achievement-${randomUUID()}` });
  f.backend.data.set(f.key("state"), JSON.stringify(legacy)); assert.ok(Buffer.byteLength(JSON.stringify(legacy)) > 49152);
  const e = legacy.records[0].evidence[0].id; assert.match(await f.run(`evidence-remove ${id} ${e} confirm`), /Saved privately/); assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) > 49152);
  const g = createAgentFeatureFixture(feature); for (let i = 0; i < 20; i++) await setup(g); assert.match(await g.run(CREATE), /Maximum 20/); assert.match(await g.run("list 2"), /11–20 of 20/);
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

for (const role of [
  { name: 'root', prefix: 'achievement', corrupt: (r: any, bad: unknown) => { r.id = bad; } },
  { name: 'evidence', prefix: 'evidence', corrupt: (r: any, bad: unknown) => { r.evidence[0].id = bad; } },
] as const) test(`strict generated ID role ${role.name} preserves raw state across reads, edits and service commands`, async () => {
  const f = createAgentFeatureFixture(feature);
  const { id } = await worked(f);
  const original = f.backend.data.get(f.key("state"))!;
  assert.equal(JSON.parse(await f.run(`export ${id}`)).record.id, id);
  const uuid = randomUUID(), valid = `${role.prefix}-${uuid}`;
  const wrongRole = role.prefix === PREFIX ? "evidence" : PREFIX;
  for (const bad of [`wrongprefix-${uuid}`, `${wrongRole}-${uuid}`, `${role.prefix}${"x".repeat(100)}-${uuid}`, `${valid}a`, valid.slice(0, -1), [valid], { id: valid }, 42, null]) {
    const corrupted = JSON.parse(original); role.corrupt(corrupted.records[0], bad);
    const raw = ` \n${JSON.stringify(corrupted, null, 1)}\t `; f.backend.data.set(f.key("state"), raw);
    const calls = { ...f.calls }, writes = f.backend.calls.compareSets;
    for (const command of ["list", `show ${id}`, `export ${id}`, `edit ${id} | title | Forbidden`, `delete ${id} confirm`, `story ${id}`, `polish ${id} | review`]) {
      assert.match(await f.run(command), /preserved|read safely/i, `${role.name}: ${command}`);
      assert.equal(f.backend.data.get(f.key("state")), raw);
      assert.equal(f.backend.calls.compareSets, writes); assert.deepEqual(f.calls, calls);
    }
  }
  f.backend.data.set(f.key("state"), original);
  assert.match(await f.run(`edit ${id} | title | Valid again`), /Saved privately/);
  assert.match(await f.run(`delete ${id} confirm`), /Deleted privately/);
});
