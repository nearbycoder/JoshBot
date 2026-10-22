import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/interview-practice.js";

const CREATE = "create Backend interview | 120 | 130", PREFIX = "session", TITLE = "Backend interview";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {
  for (let i = 0; i < 2; i++) { const q = uid(await f.run(`question ${id} add Q${i} | behavioral`), "question"); await f.run(`answer ${id} ${q} | ${"界".repeat(1900)}`); }
}
async function worked(f: ReturnType<typeof createAgentFeatureFixture>) {
  const id = await setup(f), q = uid(await f.run(`question ${id} add Tell me about a difficult tradeoff | behavioral`), "question");
  const a = uid(await f.run(`answer ${id} ${q} | I chose a queue to keep requests responsive and measured latency afterward.`), "attempt"); return { id, q, a };
}
test("exact STAR annotations, approximate timing, distinct revisions and full lifecycle", async () => {
  const f = createAgentFeatureFixture(feature), { id, q, a } = await worked(f);
  await f.run(`annotate ${id} ${a} | action | I chose a queue to keep requests responsive`);
  const review = await f.run(`review ${id} ${a}`); assert.match(review, /12 whitespace-delimited words/); assert.match(review, /5.5 seconds at 130/); assert.match(review, /Missing sections: situation, task, result/); assert.match(review, /result: missing annotation/);
  assert.match(await f.run(`annotate ${id} ${a} | result | reduced request latency`), /exact current answer span/);
  const second = uid(await f.run(`revise ${id} ${a} | In a slow import flow, I added a queue and reduced request latency from five seconds to one.`), "attempt");
  assert.notEqual(a, second); const s = await state(f); assert.equal(s.records[0].questions[0].attempts[0].annotations.length, 1); assert.equal(s.records[0].questions[0].attempts[1].annotations.length, 0);
  assert.match(await f.run(`revise ${id} ${a} | Third`), /Maximum 2/);
  for (const key of ["clarity", "relevance", "evidence"]) await f.run(`rate ${id} ${a} | ${key} | 0`);
  assert.match(await f.run(`review ${id} ${a}`), /clarity 0, relevance 0, evidence 0/);
  await f.run(`rating-remove ${id} ${a} clarity confirm`); await f.run(`annotation-remove ${id} ${a} action confirm`);
  await f.run(`question ${id} edit ${q} | New technical question | technical`);
  assert.match(await f.run(`review ${id} ${a}`), /Question snapshot \(behavioral\): Tell me about a difficult tradeoff/);
  await f.run(`attempt-edit ${id} ${a} | New 😀 answer answer`);
  assert.match(await f.run(`annotate ${id} ${a} | task | answer`), /more than once/);
  assert.match(await f.run(`annotate-span ${id} ${a} | task | 4 | 5`), /Unicode/);
  await f.run(`annotate-span ${id} ${a} | action | 4 | 6`);
  for (const [key, val] of [["title", "Rehearsal"], ["answerSeconds", "60"], ["wordsPerMinute", "120"]]) await f.run(`edit ${id} | ${key} | ${val}`);
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  await f.run(`clear ${id} answerSeconds confirm`); await f.run(`clear ${id} wordsPerMinute confirm`); assert.match(await f.run(`review ${id} ${a}`), /estimate unknown/);
  await f.run(`attempt-remove ${id} ${second} confirm`); await f.run(`question ${id} remove ${q} confirm`); assert.equal((await state(f)).records[0].questions.length, 0);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("coaching validates exact IDs/quotes/enums and accepts all allowed finite layouts", async () => {
  let mode = "valid", category = "structure", section = "situation";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input, instructions }) => {
    assert.ok(Buffer.byteLength(input) <= 16000); assert.ok(Buffer.byteLength(instructions) <= 4000); const p = JSON.parse(input);
    const out = { questionId: p.questionId, attemptId: p.attempt.id, quote: "I chose a queue", critique: category, followUp: section };
    if (mode === "id") out.attemptId = "foreign"; if (mode === "quote") out.quote = "I saved millions";
    if (mode === "enum") return JSON.stringify({ ...out, critique: ["structure"] });
    if (mode === "extra") return JSON.stringify({ ...out, claim: "Employer will hire you" });
    return JSON.stringify(out);
  } } });
  const { id, a } = await worked(f), old = f.backend.data.get(f.key("state"));
  for (category of ["structure", "specificity", "relevance", "timing"]) for (section of ["situation", "task", "action", "result"]) { const reply = await f.run(`coach ${id} ${a}`); assert.match(reply, /Unsaved practice suggestion/); assert.match(reply, /exact attempt quote: “I chose a queue”/); assert.ok(reply.length <= 3500); }
  for (mode of ["id", "quote", "enum", "extra"]) assert.match(await f.run(`coach ${id} ${a}`), /Invalid coaching output/);
  assert.equal(f.backend.data.get(f.key("state")), old); assert.equal(f.calls.generate, 20);
});
test("generation sees current record stamp after edit/delete/cancel and never exposes provider errors", async () => {
  for (const mode of ["edit", "delete", "abort", "error"]) {
    const started = deferred<void>(), done = deferred<string>(); let output = "";
    const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => { const p = JSON.parse(input); output = JSON.stringify({ questionId: p.questionId, attemptId: p.attempt.id, quote: "I", critique: "structure", followUp: "result" }); started.resolve(); return done.promise; } } });
    const { id, a } = await worked(f), controller = new AbortController(), pending = f.run(`coach ${id} ${a}`, { signal: controller.signal }); await started.promise;
    if (mode === "edit") await f.run(`attempt-edit ${id} ${a} | Changed`); if (mode === "delete") await f.run(`delete ${id} confirm`); if (mode === "abort") controller.abort();
    if (mode === "error") done.reject(new Error("FAKE_SECRET_provider")); else done.resolve(output);
    if (mode === "abort") await assert.rejects(pending, /abort/i); else assert.doesNotMatch(await pending, /FAKE_SECRET|Unsaved practice suggestion/);
    assert.equal(f.calls.generate, 1);
  }
});
test("question/attempt/count and string limits; malformed enums preserve state", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  for (let i = 0; i < 8; i++) { const q = uid(await f.run(`question ${id} add Q${i} | technical`), "question"); for (let j = 0; j < 2; j++) assert.match(await f.run(`answer ${id} ${q} | A${j}`), /Saved privately/); assert.match(await f.run(`answer ${id} ${q} | overflow`), /Maximum 2/); }
  assert.match(await f.run(`question ${id} add overflow | behavioral`), /Maximum 8/);
  const q = (await state(f)).records[0].questions[0].id;
  const before = f.backend.data.get(f.key("state")); assert.match(await f.run(`answer ${id} ${q} | ${"x".repeat(2001)}`), /too long/); assert.equal(f.backend.data.get(f.key("state")), before);
  for (const bad of [["behavioral"], {}, 1]) { const s = JSON.parse(before!); s.records[0].questions[0].type = bad; const raw = JSON.stringify(s); f.backend.data.set(f.key("state"), raw); assert.match(await f.run(`delete ${id} confirm`), /preserved/); assert.equal(f.backend.data.get(f.key("state")), raw); }
  assert.equal(f.calls.generate, 0);
  const g = createAgentFeatureFixture(feature); for (let i = 0; i < 10; i++) await setup(g); assert.match(await g.run(CREATE), /Maximum 10/);
});
test("saturated Unicode attempts retain reserved annotation/rating capacity and full text", async () => {
  const f = createAgentFeatureFixture(feature); const admitted: [string, string][] = []; let rejected = false;
  for (let i = 0; i < 3; i++) {
    const id = await setup(f);
    for (let j = 0; j < 4; j++) { const qr = await f.run(`question ${id} add Question ${j} | behavioral`); if (!qr.includes("Saved privately")) { rejected = true; break; } const q = uid(qr, "question"); const reply = await f.run(`answer ${id} ${q} | ${"界".repeat(1999)}X`); if (!reply.includes("Saved privately")) { assert.match(reply, /quota/); rejected = true; break; } admitted.push([id, uid(reply, "attempt")]); }
  }
  assert.ok(rejected); assert.ok(admitted.length >= 3);
  for (const [id, a] of admitted) { for (const section of ["situation", "task", "action", "result"]) assert.match(await f.run(`annotate-span ${id} ${a} | ${section} | 1999 | 2000`), /Saved privately/); for (const key of ["clarity", "relevance", "evidence"]) assert.match(await f.run(`rate ${id} ${a} | ${key} | 4`), /Saved privately/); }
  assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) <= 49152);
  for (const id of new Set(admitted.map(p => p[0]))) assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  const s = await state(f); while (s.records.length < 8) s.records.push({ ...structuredClone(s.records[0]), id: `session-${randomUUID()}` }); f.backend.data.set(f.key("state"), JSON.stringify(s)); assert.ok(Buffer.byteLength(JSON.stringify(s)) > 49152);
  const [id, a] = admitted[0]; assert.match(await f.run(`annotation-remove ${id} ${a} result confirm`), /Saved privately/); assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) > 49152);
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
  { name: 'root', prefix: 'session', corrupt: (r: any, bad: unknown) => { r.id = bad; } },
  { name: 'question', prefix: 'question', corrupt: (r: any, bad: unknown) => { r.questions[0].id = bad; } },
  { name: 'attempt', prefix: 'attempt', corrupt: (r: any, bad: unknown) => { r.questions[0].attempts[0].id = bad; } },
] as const) test(`strict generated ID role ${role.name} preserves raw state across reads, edits and service commands`, async () => {
  const f = createAgentFeatureFixture(feature);
  const { id, a } = await worked(f);
  const original = f.backend.data.get(f.key("state"))!;
  assert.equal(JSON.parse(await f.run(`export ${id}`)).record.id, id);
  const uuid = randomUUID(), valid = `${role.prefix}-${uuid}`;
  const wrongRole = role.prefix === PREFIX ? "question" : PREFIX;
  for (const bad of [`wrongprefix-${uuid}`, `${wrongRole}-${uuid}`, `${role.prefix}${"x".repeat(100)}-${uuid}`, `${valid}a`, valid.slice(0, -1), [valid], { id: valid }, 42, null]) {
    const corrupted = JSON.parse(original); role.corrupt(corrupted.records[0], bad);
    const raw = ` \n${JSON.stringify(corrupted, null, 1)}\t `; f.backend.data.set(f.key("state"), raw);
    const calls = { ...f.calls }, writes = f.backend.calls.compareSets;
    for (const command of ["list", `show ${id}`, `export ${id}`, `edit ${id} | title | Forbidden`, `delete ${id} confirm`, `review ${id} ${a}`, `coach ${id} ${a}`]) {
      assert.match(await f.run(command), /preserved|read safely/i, `${role.name}: ${command}`);
      assert.equal(f.backend.data.get(f.key("state")), raw);
      assert.equal(f.backend.calls.compareSets, writes); assert.deepEqual(f.calls, calls);
    }
  }
  f.backend.data.set(f.key("state"), original);
  assert.match(await f.run(`edit ${id} | title | Valid again`), /Saved privately/);
  assert.match(await f.run(`delete ${id} confirm`), /Deleted privately/);
});
