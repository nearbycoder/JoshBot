import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/learning-transfer.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const create = async (f: ReturnType<typeof createAgentFeatureFixture>) => (await f.run("create Use smaller PRs | Workshop notes | Keep each change focused on one purpose")).match(/[\da-f-]{36}/)![0];
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
const prepare = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => { await f.run(`apply ${id} | Next bug fix | Split refactor from behavior`); await f.run(`predict ${id} | Reviewer can assess each PR in one sitting`); };

test("catalog learning loop stays planned until reported, retains evidence, and marks changed plans stale", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  assert.match(await f.run(`review ${id}`), /planned/);
  await assert.rejects(f.run(`observe ${id} | It worked`), /Complete/);
  await prepare(f, id); await f.run(`observe ${id} | Reviewer completed both reviews without clarification`);
  assert.match(await f.run(`review ${id}`), /tried/); await f.run(`reflect ${id} | Keep split; add dependency note`);
  assert.match(await f.run(`review ${id}`), /reviewed/);
  await f.run(`edit ${id} action | Bundle all changes`);
  const review = await f.run(`review ${id}`); assert.match(review, /planned/); assert.match(review, /STALE/); assert.match(review, /without clarification/);
  await assert.rejects(f.run(`reflect ${id} | Pretend unchanged`), /Observe the current/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("all accepted fields, observation dates and reflection have edit and removal paths", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f); await prepare(f, id);
  await f.run(`observe ${id} | Report`); const oid = (await record(f, id)).observations[0].id;
  await f.run(`reflect ${id} | Adjustment`);
  await f.run(`observation ${id} edit ${oid} | 2024-02-29 | Corrected report`);
  assert.match(await f.run(`review ${id}`), /STALE/);
  for (const field of ["lesson", "sourceLabel", "sourceExcerpt", "opportunity", "action", "prediction"]) {
    await f.run(`edit ${id} ${field} | literal \\| <@UOTHER> & C:\\\\notes`);
    assert.equal((await record(f, id))[field], "literal | <@UOTHER> & C:\\notes");
    await f.run(`clear ${id} ${field} confirm`); assert.equal((await record(f, id))[field], "");
  }
  await f.run(`clear ${id} reflection confirm`); await f.run(`observation ${id} remove ${oid} confirm`);
  assert.equal((await record(f, id)).observations.length, 0);
  await f.run(`delete ${id}`); assert.ok(await record(f, id)); await f.run(`delete ${id} confirm`); assert.match(await f.run("list"), /No saved/);
});
test("assessment CAS retries reject changed work, while unrelated applications can change", async () => {
  let target = "", conflict = false;
  const backend = createMemoryAgentBackend({ beforeCompareSet: (key, previous) => { if (conflict && previous) { conflict = false; const s = JSON.parse(previous); const a = s.records.find((a: { id: string }) => a.id === target); a.action = "Concurrent action"; a.revision++; a.planRevision++; backend.data.set(key, JSON.stringify(s)); } } });
  const f = createAgentFeatureFixture(feature, { backend }), first = await create(f), second = await create(f); await prepare(f, first); await prepare(f, second);
  target = first; conflict = true; await assert.rejects(f.run(`observe ${first} | Obsolete evidence`), /changed/); assert.equal((await record(f, first)).observations.length, 0);
  await f.run(`observe ${first} | Current report`); target = first; conflict = true; await assert.rejects(f.run(`reflect ${first} | Obsolete reflection`), /changed/);
  target = second; conflict = true; await f.run(`observe ${first} | Independent report`); assert.equal((await record(f, first)).observations.length, 2); assert.equal((await record(f, second)).action, "Concurrent action");
  assert.equal(backend.calls.conflicts, 3);
});
test("invalid state is never reset; raw corrupt bytes survive even attempted deletion", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f), good = f.backend.data.get(f.key("state"))!;
  for (const bad of ["{", "null", '{"version":2,"records":[]}', good.replace('"planRevision":1', '"planRevision":0'), good.replace('"records":', '"extra":true,"records":')]) {
    f.backend.data.set(f.key("state"), bad); await assert.rejects(f.run(`delete ${id} confirm`)); assert.equal(f.backend.data.get(f.key("state")), bad); assert.ok((await f.run("help")).length <= 3500);
  }
  // Shared store currently conflates stored JSON null with absence on reads. Mutation still validates raw null.
  f.backend.data.set(f.key("state"), "null"); await assert.rejects(f.run("create A | B | C")); assert.equal(f.backend.data.get(f.key("state")), "null");
});
test("field boundaries, civil dates, owner isolation and exact export", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  await f.run(`edit ${id} sourceExcerpt | ${"漢".repeat(600)}`); const before = f.backend.data.get(f.key("state"));
  await assert.rejects(f.run(`edit ${id} sourceExcerpt | ${"漢".repeat(601)}`)); assert.equal(f.backend.data.get(f.key("state")), before);
  await prepare(f, id); await f.run(`observe ${id} | Evidence`); const oid = (await record(f, id)).observations[0].id;
  await assert.rejects(f.run(`observation ${id} edit ${oid} | 2026-02-29 | Invalid`));
  for (const owner of [{ teamId: "TOTHER", userId: f.owner.userId }, { teamId: f.owner.teamId, userId: "UOTHER" }]) await assert.rejects(f.run(`show ${id}`, { owner }), /not found/);
  assert.equal((await record(f, id)).sourceExcerpt, "漢".repeat(600));
});
test("Unicode saturation reserves every remaining observation and reflection; pages recover all fields", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 20; i++) { try { ids.push(await create(f)); } catch (e) { assert.match(String(e), /quota/); break; } }
  assert.ok(ids.length > 1 && ids.length < 20);
  for (const id of ids) {
    await f.run(`apply ${id} | ${'"'.repeat(180)} | ${'"'.repeat(300)}`); await f.run(`predict ${id} | ${'"'.repeat(240)}`);
    for (let i = 0; i < 5; i++) await f.run(`observe ${id} | ${'"'.repeat(240)}`);
    await f.run(`reflect ${id} | ${'"'.repeat(240)}`);
    await assert.rejects(f.run(`observe ${id} | sixth`), /Five/);
    const out = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(out) <= 24576);
    let cmd = `show ${id}`, all = "", pages = 0;
    do { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed()); all += reply; cmd = /Next: \/nobo-help agent learning-transfer (.*)/.exec(reply)?.[1] ?? ""; assert.ok(++pages < 20); } while (cmd);
    for (const o of (await record(f, id)).observations) assert.ok(all.includes(o.id));
  }
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
  for (const id of ids) await f.run(`delete ${id} confirm`);
});
