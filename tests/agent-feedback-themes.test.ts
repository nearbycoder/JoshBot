import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/feedback-themes.js";

const CREATE = "create Quarterly feedback", PREFIX = "feedback", TITLE = "Quarterly feedback";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) { for (let i = 0; i < 8; i++) assert.match(await f.run(`quote ${id} add Peer ${i} | 2026-10-20 | Review | ${"界".repeat(300)}`), /Saved privately/); }
async function worked(f: ReturnType<typeof createAgentFeatureFixture>) {
  const id = await setup(f), q = uid(await f.run(`quote ${id} add Peer A | 2026-10-20 | Review meeting | Include tradeoffs earlier`), "quote"), t = uid(await f.run(`theme ${id} add Decision clarity`), "theme");
  await f.run(`assign ${id} ${q} | ${t}`); return { id, q, t };
}
test("repetition is not consensus; exact duplicates, labels and counterevidence stay visible", async () => {
  const f = createAgentFeatureFixture(feature), { id, q, t } = await worked(f);
  const duplicate = uid(await f.run(`quote ${id} add Peer A | 2026-10-20 | Review meeting | Include tradeoffs earlier`), "quote");
  const separate = uid(await f.run(`quote ${id} add Peer B | 2026-10-21 | Another meeting | Include tradeoffs earlier`), "quote");
  await f.run(`assign ${id} ${duplicate} | ${t}`); await f.run(`assign ${id} ${separate} | ${t}`);
  const e = uid(await f.run(`counterexample ${id} ${t} | The migration note clearly listed tradeoffs`), "counter");
  await f.run(`experiment ${id} ${t} | Put a tradeoff paragraph before the recommendation`);
  const report = await f.run(`themes ${id}`); assert.match(report, /3 retained entries; 1 distinct exact quote texts; 1 duplicate evidence entries/); assert.match(report, /2 separately entered evidence tuples; 2 distinct supplied speaker labels/); assert.match(report, /not verified distinct people/); assert.match(report, /Counterevidence \/ contradictions retained/); assert.match(report, /migration note clearly listed/); assert.match(report, /Coverage: 3\/3/);
  await f.run(`quote ${id} edit ${q} | Peer A corrected | 2026-10-22 | Different context | Exact corrected \\| quote`);
  assert.equal((await state(f)).records[0].quotes[0].themeId, "");
  await f.run(`theme ${id} edit ${t} | Communication clarity`); await f.run(`counterexample-edit ${id} ${t} ${e} | Changed counterexample`);
  await f.run(`experiment ${id} ${t} | Try a shorter summary`); await f.run(`experiment-remove ${id} ${t} confirm`);
  await f.run(`unassign ${id} ${duplicate} confirm`);
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  assert.match(await f.run(`counterexample-remove ${id} ${t} ${e} nope`), /confirm/); await f.run(`counterexample-remove ${id} ${t} ${e} confirm`);
  await f.run(`theme ${id} remove ${t} confirm`); assert.equal((await state(f)).records[0].quotes.length, 3); assert.ok((await state(f)).records[0].quotes.every((q: any) => !q.themeId));
  await f.run(`quote ${id} remove ${q} confirm`); await f.run(`edit ${id} | title | Reassessment`);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("suggestions account for complete unique source IDs, allow all-unassigned, and cannot invent content", async () => {
  let mode = "grouped";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    const ids = JSON.parse(input).quotes.map((q: any) => q.id);
    if (mode === "grouped") return JSON.stringify({ groups: [ids], unassigned: [] });
    if (mode === "unassigned") return JSON.stringify({ groups: [], unassigned: ids });
    if (mode === "duplicate") return JSON.stringify({ groups: [ids], unassigned: [ids[0]] });
    if (mode === "missing") return JSON.stringify({ groups: [], unassigned: [] });
    if (mode === "invented") return JSON.stringify({ groups: [["foreign"]], unassigned: [] });
    if (mode === "empty") return JSON.stringify({ groups: [[]], unassigned: ids });
    return JSON.stringify({ groups: [ids], unassigned: [], label: "Everyone thinks you are unreliable" });
  } } });
  const { id } = await worked(f), before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`suggest-themes ${id}`), /1\/1 quote IDs accounted for exactly once; 1 grouped, 0 unassigned/);
  mode = "unassigned"; assert.match(await f.run(`suggest-themes ${id}`), /0 grouped, 1 unassigned/);
  for (mode of ["duplicate", "missing", "invented", "empty", "extra"]) assert.match(await f.run(`suggest-themes ${id}`), /Invalid grouping output/);
  assert.equal(f.backend.data.get(f.key("state")), before); assert.equal(f.calls.generate, 7);
});
test("assistance rejects impossible full input before calls and invalid/empty commands do not generate", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  assert.match(await f.run(`suggest-themes ${id}`), /at least one quote/); assert.equal(f.calls.generate, 0);
  for (let i = 0; i < 15; i++) assert.match(await f.run(`quote ${id} add Peer | 2026-10-20 | ${"界".repeat(100)} | ${"界".repeat(330)}`), /Saved privately/);
  assert.match(await f.run(`suggest-themes ${id}`), /cannot fit assistance limits/); assert.equal(f.calls.generate, 0);
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
});
test("delayed groupings discard edited/deleted/cancelled sources, and redact provider diagnostics", async () => {
  for (const mode of ["edit", "delete", "abort", "error"]) {
    const started = deferred<void>(), done = deferred<string>(); let output = "";
    const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => { output = JSON.stringify({ groups: [], unassigned: JSON.parse(input).quotes.map((q: any) => q.id) }); started.resolve(); return done.promise; } } });
    const { id, q } = await worked(f), controller = new AbortController(), pending = f.run(`suggest-themes ${id}`, { signal: controller.signal }); await started.promise;
    if (mode === "edit") await f.run(`quote ${id} edit ${q} | Peer | 2026-10-20 | Review | Changed`); if (mode === "delete") await f.run(`delete ${id} confirm`); if (mode === "abort") controller.abort();
    if (mode === "error") done.reject(new Error("FAKE_SECRET_provider")); else done.resolve(output);
    if (mode === "abort") await assert.rejects(pending, /abort/i); else assert.doesNotMatch(await pending, /FAKE_SECRET|Unsaved grouping suggestion/);
    assert.equal(f.calls.generate, 1);
  }
});
test("catalog caps, malformed dates/references, saturated Unicode and experiment reserve", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f), tids: string[] = [], qids: string[] = [];
  for (let i = 0; i < 10; i++) tids.push(uid(await f.run(`theme ${id} add Theme${i}`), "theme"));
  assert.match(await f.run(`theme ${id} add Extra`), /Maximum 10/);
  for (let i = 0; i < 30; i++) qids.push(uid(await f.run(`quote ${id} add Peer | 2026-10-20 | Review | Quote ${i}`), "quote"));
  assert.match(await f.run(`quote ${id} add Peer | 2026-10-20 | Review | Extra`), /Maximum 30/);
  for (let i = 0; i < 3; i++) assert.match(await f.run(`counterexample ${id} ${tids[0]} | Counter ${i}`), /Saved privately/);
  assert.match(await f.run(`counterexample ${id} ${tids[0]} | Extra`), /Maximum 3/);
  let saturated = false;
  for (const q of qids) { const reply = await f.run(`quote ${id} edit ${q} | Peer | 2026-10-20 | Review | ${"界".repeat(333)}x`); if (/quota/.test(reply)) { saturated = true; break; } assert.match(reply, /Saved privately/); }
  assert.ok(saturated);
  for (const q of qids) assert.match(await f.run(`assign ${id} ${q} | ${tids[0]}`), /Saved privately/);
  for (const t of tids) assert.match(await f.run(`experiment ${id} ${t} | ${esc("\\".repeat(320))}`), /Saved privately/);
  assert.ok(Buffer.byteLength(await f.run(`export ${id}`)) <= 24576); assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  const old = f.backend.data.get(f.key("state")); assert.match(await f.run(`quote ${id} edit ${qids[0]} | Peer | 2026-02-30 | Context | Text`), /date/i); assert.equal(f.backend.data.get(f.key("state")), old);
  const s = await state(f); s.records[0].quotes[0].themeId = [tids[0]]; const raw = JSON.stringify(s); f.backend.data.set(f.key("state"), raw); assert.match(await f.run(`delete ${id} confirm`), /preserved/); assert.equal(f.backend.data.get(f.key("state")), raw);
  f.backend.data.set(f.key("state"), old!); const legacy = await state(f); for (let i = 0; i < 3; i++) legacy.records.push({ ...structuredClone(legacy.records[0]), id: `feedback-${randomUUID()}` }); f.backend.data.set(f.key("state"), JSON.stringify(legacy));
  assert.ok(Buffer.byteLength(JSON.stringify(legacy)) > 49152); assert.match(await f.run(`experiment-remove ${id} ${tids[0]} confirm`), /Saved privately/); assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) > 49152);
  const g = createAgentFeatureFixture(feature); for (let i = 0; i < 12; i++) await setup(g); assert.match(await g.run(CREATE), /Maximum 12/); assert.match(await g.run("list 2"), /11–12 of 12/);
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
  { name: 'root', prefix: 'feedback', corrupt: (r: any, bad: unknown) => { r.id = bad; } },
  { name: 'quote', prefix: 'quote', corrupt: (r: any, bad: unknown) => { r.quotes[0].id = bad; } },
  { name: 'theme with coherent reference', prefix: 'theme', corrupt: (r: any, bad: unknown) => { r.themes[0].id = bad; r.quotes[0].themeId = bad; } },
  { name: 'counterexample', prefix: 'counter', corrupt: (r: any, bad: unknown) => { r.themes[0].counterexamples[0].id = bad; } },
  { name: 'theme reference alone', prefix: 'theme', corrupt: (r: any, bad: unknown) => { r.quotes[0].themeId = bad; } },
] as const) test(`strict generated ID role ${role.name} preserves raw state across reads, edits and service commands`, async () => {
  const f = createAgentFeatureFixture(feature);
  const { id, t } = await worked(f); await f.run(`counterexample ${id} ${t} | Contrary evidence`);
  const original = f.backend.data.get(f.key("state"))!;
  assert.equal(JSON.parse(await f.run(`export ${id}`)).record.id, id);
  const uuid = randomUUID(), valid = `${role.prefix}-${uuid}`;
  const wrongRole = role.prefix === PREFIX ? "theme" : PREFIX;
  for (const bad of [`wrongprefix-${uuid}`, `${wrongRole}-${uuid}`, `${role.prefix}${"x".repeat(100)}-${uuid}`, `${valid}a`, valid.slice(0, -1), [valid], { id: valid }, 42, null]) {
    const corrupted = JSON.parse(original); role.corrupt(corrupted.records[0], bad);
    const raw = ` \n${JSON.stringify(corrupted, null, 1)}\t `; f.backend.data.set(f.key("state"), raw);
    const calls = { ...f.calls }, writes = f.backend.calls.compareSets;
    for (const command of ["list", `show ${id}`, `export ${id}`, `edit ${id} | title | Forbidden`, `delete ${id} confirm`, `themes ${id}`, `suggest-themes ${id}`]) {
      assert.match(await f.run(command), /preserved|read safely/i, `${role.name}: ${command}`);
      assert.equal(f.backend.data.get(f.key("state")), raw);
      assert.equal(f.backend.calls.compareSets, writes); assert.deepEqual(f.calls, calls);
    }
  }
  f.backend.data.set(f.key("state"), original);
  assert.match(await f.run(`edit ${id} | title | Valid again`), /Saved privately/);
  assert.match(await f.run(`delete ${id} confirm`), /Deleted privately/);
});
