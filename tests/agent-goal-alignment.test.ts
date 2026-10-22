import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/goal-alignment.js";

import { goals } from "../lib/toolbox/goals.js";
import { runFeature } from "../lib/toolbox/core.js";
import { createAgentFeatureServices, createProductionContextAdapters } from "../lib/agent-features/services.js";
import type { AgentContextItem } from "../lib/agent-features/types.js";
const CREATE = "create November effort", PREFIX = "board", TITLE = "November effort";
const owner = { teamId: "TFIXTURE", userId: "UFIXTURE", channelId: "CFIXTURE" }, now = new Date("2026-10-22T15:00:00.000Z");
const toolboxKey = `nobo:toolbox:v1:${owner.teamId}:${owner.userId}:goals`;
function integrated() {
  const reads: string[] = [], backend = createMemoryAgentBackend({ beforeGet: key => { reads.push(key); } });
  const adapters = createProductionContextAdapters({ redis: async () => { throw new Error("No legacy Redis allowed"); }, evaluateAccess: async () => { throw new Error("No legacy channel source allowed"); } });
  const services = createAgentFeatureServices(backend, owner, new AbortController().signal, { now, timezone: "America/Chicago", featureId: feature.id }, { ...adapters, readCalendar: async () => { throw new Error("No calendar"); }, readApprovedMemory: async () => { throw new Error("No memory"); } });
  const f = createAgentFeatureFixture(feature, { backend, owner, services: { readContext: services.readContext } });
  const tool = (command: string) => runFeature(goals, command, owner, undefined, backend, now);
  const entries = () => JSON.parse(backend.data.get(toolboxKey)!).entries as any[];
  const add = async (title: string) => { const reply = await tool(`create ${title} | 10 | tasks | 2026-10-30`); assert.match(reply, /0\/10 tasks/); const e = entries().find(e => e.title === title); return { raw: e.id as string, source: `toolbox:goals:${e.id}` }; };
  return { f, reads, backend, services, tool, entries, add };
}
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {
  const g = uid(await f.run(`local ${id} | Local goal`), "local");
  for (let i = 0; i < 8; i++) { const a = uid(await f.run(`activity ${id} add Activity${i} | 120`), "activity"); await f.run(`link ${id} ${a} | ${g} | 75 | ${"界".repeat(100)}`); }
}
async function allSourcePages(f: ReturnType<typeof createAgentFeatureFixture>, initial: string) {
  let command = initial, combined = "", pages = 0;
  for (;;) { const before = f.calls.readContext, reply = await f.run(command); assert.equal(f.calls.readContext - before, 1); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed()); assert.match(reply, /s1:[a-f0-9]{64}/); combined += reply; pages++; assert.ok(pages < 100); const next = /\nNext: (\/nobo-help agent [^\n]+)$/.exec(reply); if (!next) return { combined, pages }; assert.match(next[1], / rev \d+-[a-f0-9]{64} source s1:[a-f0-9]{64}/); command = next[1].slice(route.length); }
}
test("actual toolbox→production services/adapters→runtime: 90 aligned/30 unallocated with honest goal semantics", async () => {
  const x = integrated(), { f } = x, open = await x.add("Onboarding target"), done = await x.add("Reached numeric target");
  await x.tool(`progress ${done.raw} | 10 | Numeric current equals target`);
  const id = await setup(f); x.reads.length = 0;
  const discovery = await f.run(`goals ${id}`); assert.match(discovery, /Complete owned-goal discovery: 2\/100/); assert.match(discovery, /Status done; civil deadline 2026-10-30/); assert.match(discovery, /Status open/); assert.equal(x.reads.filter(k => k === toolboxKey).length, 1);
  const before = x.backend.data.get(toolboxKey); assert.match(await f.run(`select ${id} | ${open.source}`), /Saved privately/);
  const a = uid(await f.run(`activity ${id} add Write onboarding guide | 120`), "activity"); await f.run(`link ${id} ${a} | ${open.source} | 75 | Helps new users finish setup`);
  const local = uid(await f.run(`local ${id} | Explicit local outcome`), "local"), savedBeforeOver = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`link ${id} ${a} | ${local} | 26 | Too much`), /exceed 100/); assert.equal(f.backend.data.get(f.key("state")), savedBeforeOver);
  const priorCalls = f.calls.readContext, report = await f.run(`review ${id}`); assert.match(report, /aligned 90; unallocated 30/); assert.match(report, /75% × 120 = 90 minutes/); assert.match(report, /historical/); assert.match(report, /not proof of completion/); assert.equal(f.calls.readContext, priorCalls); assert.equal(x.backend.data.get(toolboxKey), before);
  const s = (await state(f)).records[0].goals[0]; assert.equal(s.snapshot.dueAt, "2026-10-30"); assert.equal(s.snapshot.status, "open"); assert.equal(s.snapshot.metadata.current, 0); assert.equal(s.snapshot.metadata.target, 10); assert.equal(s.snapshot.metadata.completedAt, undefined); assert.deepEqual(s.owner, { teamId: owner.teamId, userId: owner.userId });
  assert.deepEqual(JSON.parse(await reconstruct(f, id)), JSON.parse(await f.run(`export ${id}`)));
  await f.run(`local-edit ${id} ${local} | Changed local label`); await f.run(`activity ${id} edit ${a} | label | Edited activity`); await f.run(`activity ${id} edit ${a} | minutes | 240`); await f.run(`link ${id} ${a} | ${open.source} | 50 | Changed allocation`);
  await f.run(`unlink ${id} ${a} ${open.source} confirm`); await f.run(`activity ${id} clear ${a} label confirm`); await f.run(`activity ${id} remove ${a} confirm`); await f.run(`goal-remove ${id} ${local} confirm`); await f.run(`goal-remove ${id} ${open.source} confirm`);
  assert.deepEqual((await state(f)).records[0].goals, []); assert.equal(x.backend.data.get(toolboxKey), before); assert.equal(f.calls.generate, 0); assert.equal(f.calls.search, 0);
  assert.ok(x.reads.every(k => k === toolboxKey || k.startsWith(`nobo:agents:v1:${owner.teamId}:${owner.userId}:goal-alignment:`)));
});
test("100 real toolbox goals are fully discoverable with source-set continuations, explicit 10 selection", async () => {
  const x = integrated(), refs: string[] = []; for (let i = 0; i < 100; i++) refs.push((await x.add(`Goal ${String(i).padStart(3, "0")}`)).source);
  const id = await setup(x.f), { combined, pages } = await allSourcePages(x.f, `goals ${id}`); assert.ok(pages > 1); for (const ref of refs) assert.ok(combined.includes(ref));
  assert.match(await x.f.run(`source ${id} ${refs[99]}`), /Personal toolbox \/ goals/);
  for (const ref of refs.slice(0, 10)) assert.match(await x.f.run(`select ${id} | ${ref}`), /Saved privately/);
  const prior = x.f.calls.readContext; assert.match(await x.f.run(`select ${id} | ${refs[10]}`), /Maximum 10/); assert.equal(x.f.calls.readContext, prior);
  const first = await x.f.run(`goals ${id}`), next = /\nNext: (\/nobo-help agent [^\n]+)$/.exec(first)![1];
  const entries = x.entries(); entries.reverse(); const rawState = JSON.parse(x.backend.data.get(toolboxKey)!); rawState.entries = entries; x.backend.data.set(toolboxKey, JSON.stringify(rawState));
  assert.doesNotMatch(await x.f.run(next.slice(route.length)), /stale source/);
  await x.tool(`due ${refs[99].slice("toolbox:goals:".length)} | 2026-11-01`);
  assert.match(await x.f.run(next.slice(route.length)), /Goal source set changed/);
  const over = JSON.parse(x.backend.data.get(toolboxKey)!); over.entries.push({ ...structuredClone(over.entries[0]), id: randomUUID() }); x.backend.data.set(toolboxKey, JSON.stringify(over));
  assert.match(await x.f.run(`goals ${id}`), /could not be completed safely/);
});
test("fresh change/replacement/revocation/deletion preserves historical sources and uses one read each", async () => {
  const x = integrated(), g = await x.add("Goal"), id = await setup(x.f); await x.f.run(`select ${id} | ${g.source}`);
  const original = (await state(x.f)).records[0].goals[0]; await x.tool(`progress ${g.raw} | 10 | Recorded target reached`);
  let before = x.f.calls.readContext; await x.f.run(`refresh ${id}`); assert.equal(x.f.calls.readContext - before, 1);
  let saved = (await state(x.f)).records[0].goals[0]; assert.equal(saved.verification, "changed"); assert.equal(saved.snapshot.metadata.current, 0); assert.equal(saved.fingerprint, original.fingerprint); assert.notEqual(saved.latestFingerprint, original.fingerprint);
  assert.match(await x.f.run(`select ${id} | ${g.source}`), /Already selected/);
  before = x.f.calls.readContext; await x.f.run(`replace ${id} | ${g.source} | confirm`); assert.equal(x.f.calls.readContext - before, 1);
  saved = (await state(x.f)).records[0].goals[0]; assert.equal(saved.snapshot.status, "done"); assert.equal(saved.snapshot.metadata.completedAt, undefined);
  const sourceState = JSON.parse(x.backend.data.get(toolboxKey)!); sourceState.entries[0].teamId = "TFOREIGN"; x.backend.data.set(toolboxKey, JSON.stringify(sourceState));
  await x.f.run(`refresh ${id}`); saved = (await state(x.f)).records[0].goals[0]; assert.equal(saved.verification, "absent"); assert.equal(saved.snapshot.metadata.current, 10); assert.equal(saved.latestFingerprint, "");
  assert.match(await x.f.run(`review ${id}`), /not proven deleted everywhere/);
  delete sourceState.entries[0].teamId; x.backend.data.set(toolboxKey, JSON.stringify(sourceState)); await x.f.run(`refresh ${id}`); assert.equal((await state(x.f)).records[0].goals[0].verification, "unchanged");
  await x.tool(`delete ${g.raw} confirm`); await x.f.run(`refresh ${id}`); assert.equal((await state(x.f)).records[0].goals[0].verification, "absent");
  const preserved = x.f.backend.data.get(x.f.key("state")); assert.match(await x.f.run(`replace ${id} | ${g.source} | confirm`), /absent/); assert.equal(x.f.backend.data.get(x.f.key("state")), preserved);
});
test("exact 8000 UTF-8 selected text boundary, source coverage and complete URL/detail retention", async () => {
  const x = integrated(), g = await x.add("Boundary"), id = await setup(x.f);
  // Start with a real toolbox-created goal and exercise the actual adapter. Body is
  // source-owned serialized data; adjust its UTF-8 length, not the consumer shape.
  let raw = JSON.parse(x.backend.data.get(toolboxKey)!); const suffix = "\n" + JSON.stringify(raw.entries[0].data), payloadBytes = 8000 - Buffer.byteLength(suffix);
  raw.entries[0].body = "界".repeat(Math.floor(payloadBytes / 3)) + "x".repeat(payloadBytes % 3); x.backend.data.set(toolboxKey, JSON.stringify(raw));
  assert.match(await x.f.run(`select ${id} | ${g.source}`), /Saved privately/); assert.equal(Buffer.byteLength((await state(x.f)).records[0].goals[0].snapshot.text), 8000);
  assert.deepEqual(JSON.parse(await reconstruct(x.f, id)), JSON.parse(await x.f.run(`export ${id}`)));
  raw.entries[0].body += "x"; x.backend.data.set(toolboxKey, JSON.stringify(raw)); const saved = x.f.backend.data.get(x.f.key("state"));
  assert.match(await x.f.run(`replace ${id} | ${g.source} | confirm`), /8000 UTF-8/); assert.equal(x.f.backend.data.get(x.f.key("state")), saved);
  const actual = (await x.services.readContext(["goal"]))[0]; actual.text = "exact source"; actual.sourceUrl = "https://example.test/a?x=1&y=%7C#frag"; actual.metadata!.textTruncated = true;
  const f = createAgentFeatureFixture(feature, { services: { readContext: async kinds => { assert.deepEqual(kinds, ["goal"]); return [actual]; } } }), board = await setup(f);
  await f.run(`select ${board} | ${g.source}`); assert.match(await f.run(`review ${board}`), /adapter excerpt \(truncated\)/); assert.ok((await reconstruct(f, board)).includes(actual.sourceUrl));
});
test("semantic malformed denominators, enums, due/history and owner provenance preserve whole roots", async () => {
  const x = integrated(), g = await x.add("Malformed checks"), id = await setup(x.f); await x.f.run(`select ${id} | ${g.source}`);
  for (const mutate of [(r: any) => { r.entries[0].data.target = 0; }, (r: any) => { r.entries[0].data.history = [{ at: now.toISOString(), value: -1, note: "negative" }]; }, (r: any) => { r.entries[0].data.due = "2026-02-30"; }]) {
    const original = x.backend.data.get(toolboxKey)!, bad = JSON.parse(original); mutate(bad); x.backend.data.set(toolboxKey, JSON.stringify(bad)); const before = x.backend.data.get(x.f.key("state"));
    assert.doesNotMatch(await x.f.run(`refresh ${id}`), /Saved privately/); assert.equal(x.backend.data.get(x.f.key("state")), before); x.backend.data.set(toolboxKey, original);
  }
  const original = x.f.backend.data.get(x.f.key("state"))!;
  for (const mutate of [(r: any) => { r.records[0].goals[0].snapshot.metadata.target = 0; }, (r: any) => { r.records[0].goals[0].verification = ["captured"]; }, (r: any) => { r.records[0].goals[0].owner.userId = "UFOREIGN"; }]) {
    const bad = JSON.parse(original); mutate(bad); const encoded = JSON.stringify(bad); x.backend.data.set(x.f.key("state"), encoded); assert.match(await x.f.run(`delete ${id} confirm`), /preserved/i); assert.equal(x.backend.data.get(x.f.key("state")), encoded);
  }
});
test("late context edit/delete/abort and source failure do not save stale snapshots", async () => {
  const x = integrated(); await x.add("One goal"); const snapshot = await x.services.readContext(["goal"]);
  for (const mode of ["edit", "delete", "abort", "error"]) {
    const started = deferred<void>(), done = deferred<AgentContextItem[]>();
    const f = createAgentFeatureFixture(feature, { services: { readContext: async () => { started.resolve(); return done.promise; } } }), id = await setup(f), controller = new AbortController(), pending = f.run(`select ${id} | ${snapshot[0].id}`, { signal: controller.signal }); await started.promise;
    if (mode === "edit") await f.run(`edit ${id} | title | Changed`); if (mode === "delete") await f.run(`delete ${id} confirm`); if (mode === "abort") controller.abort();
    if (mode === "error") done.reject(new Error("FAKE_SECRET_context")); else done.resolve(snapshot);
    if (mode === "abort") await assert.rejects(pending, /abort/i); else assert.doesNotMatch(await pending, /FAKE_SECRET|Saved privately/);
    assert.ok((await state(f)).records.every((r: any) => !r.goals.length)); assert.equal(f.calls.readContext, 1);
  }
});
test("max activity/local counts, lifecycle ceiling, capacity and legacy deletion", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f);
  for (let i = 0; i < 10; i++) await f.run(`local ${id} | Local ${i}`); assert.match(await f.run(`local ${id} | Extra`), /Maximum 10/);
  for (let i = 0; i < 30; i++) await f.run(`activity ${id} add Activity${i} | 120`); assert.match(await f.run(`activity ${id} add Extra | 1`), /Maximum 30/);
  const s = await state(f); for (const a of s.records[0].activities) a.shares = s.records[0].goals.map((g: any) => ({ goalId: g.id, percent: 10, reason: "界".repeat(100) }));
  f.backend.data.set(f.key("state"), JSON.stringify(s)); assert.ok(Buffer.byteLength(JSON.stringify(s)) > 49152);
  assert.match(await f.run(`edit ${id} | title | Ordinary`), /quota/);
  assert.match(await f.run(`unlink ${id} ${s.records[0].activities[0].id} ${s.records[0].goals[0].id} confirm`), /Saved privately/); assert.ok(Buffer.byteLength(JSON.stringify(await state(f))) > 49152);
  assert.match(await f.run(`goal-remove ${id} ${s.records[0].goals[0].id} confirm`), /Saved privately/);
  const g = createAgentFeatureFixture(feature); for (let i = 0; i < 10; i++) await setup(g); assert.match(await g.run(CREATE), /Maximum 10/);
  const x = integrated(), source = await x.add("Ceiling refresh"), board = await setup(x.f); await x.f.run(`select ${board} | ${source.source}`); const ceiling = await state(x.f); ceiling.records[0].revision = 999999999; x.f.backend.data.set(x.f.key("state"), JSON.stringify(ceiling));
  assert.match(await x.f.run(`refresh ${board}`), /Revision limit/); assert.match(await x.f.run(`goal-remove ${board} ${source.source} confirm`), /Saved privately/);
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

test("canonical saved source key order is valid; content-bound refresh survives only unrelated CAS changes", async () => {
  const x = integrated(), g = await x.add("Key order"), id = await setup(x.f), other = await setup(x.f); await x.f.run(`select ${id} | ${g.source}`);
  const s = await state(x.f), source = s.records[0].goals[0];
  source.snapshot = Object.fromEntries(Object.entries(source.snapshot).reverse()); source.snapshot.metadata = Object.fromEntries(Object.entries(source.snapshot.metadata).reverse());
  x.backend.data.set(x.f.key("state"), JSON.stringify(s)); assert.equal(JSON.parse(await x.f.run(`export ${id}`)).record.goals[0].id, g.source);
  const cas = x.backend.compareSet;
  for (const mode of ["unrelated", "same", "delete"]) {
    let armed = true;
    x.backend.compareSet = async (key, previous, next, ttl) => {
      if (armed && key === x.f.key("state")) { armed = false; const current = JSON.parse(x.backend.data.get(key)!); if (mode === "delete") current.records = current.records.filter((r: any) => r.id !== id); else current.records.find((r: any) => r.id === (mode === "same" ? id : other)).title = mode; x.backend.data.set(key, JSON.stringify(current)); }
      return cas(key, previous, next, ttl);
    };
    // Change source so the refresh really dispatches CAS even with a fixed clock.
    await x.tool(`target ${g.raw} | ${mode === "unrelated" ? 11 : mode === "same" ? 12 : 13}`);
    const calls = x.f.calls.readContext, reply = await x.f.run(`refresh ${id}`); assert.equal(x.f.calls.readContext - calls, 1);
    if (mode === "unrelated") assert.match(reply, /Saved privately/); else assert.match(reply, /changed|not found/);
  }
  x.backend.compareSet = cas;
  assert.ok(!(await state(x.f)).records.some((r: any) => r.id === id));
});

test("dense identifier-rich legacy details reconstruct without exhausting pagination atoms", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f), gid = uid(await f.run(`local ${id} | Target`), "local");
  const s = await state(f), r = s.records[0], dense = `${gid} `.repeat(7).trim();
  // A schema-valid legacy record above admission/export quotas remains inspectable.
  r.goals = Array.from({ length: 10 }, (_, i) => ({ kind: "local", id: i ? `local-${randomUUID()}` : gid, label: "Target" }));
  r.activities = Array.from({ length: 30 }, () => ({ id: `activity-${randomUUID()}`, label: "Plan", minutes: 100, shares: r.goals.map((g: any) => ({ goalId: g.id, percent: 10, reason: dense })) }));
  f.backend.data.set(f.key("state"), JSON.stringify(s));
  assert.deepEqual(JSON.parse(await reconstruct(f, id)).record, r);
  assert.match(await f.run(`goal-remove ${id} ${gid} confirm`), /Saved privately/);
});
