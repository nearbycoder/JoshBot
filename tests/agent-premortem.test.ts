import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/premortem.js";
import { createAgentFeatureFixture, deferred } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const risk = (s: string) => { const m = s.match(/Risk: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
test("catalog workflow distinguishes original and residual ordinal priority", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.replace("/nobo-help agent premortem ", "")));
  const rid = risk(await f.run(`risk ${id} add Setup consumes session | 3 | 4`));
  await f.run(`trigger ${id} ${rid} | Two pilot users need more than ten minutes`);
  await f.run(`mitigate ${id} ${rid} | Send setup sheet | Me`);
  assert.match(await f.run(`review ${id}`), /ordinal priority 12/); assert.doesNotMatch(await f.run(`review ${id}`), /12%/);
  await f.run(`residual ${id} ${rid} | 2 | 3 | Pilot completed`);
  const r = await record(f, id); assert.equal(r.risks[0].likelihood, 3); assert.equal(r.risks[0].residual.likelihood, 2);
  assert.match(await f.run(`review ${id}`), /Residual ordinal priority 6.*change -6/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("low risks retain missing controls; edits and confirmed removals are complete", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Launch | Exercise completed")), rid = risk(await f.run(`risk ${id} add Minor delay | 1 | 1`));
  assert.match(await f.run(`review ${id}`), /Trigger: MISSING/); assert.match(await f.run(`review ${id}`), /Mitigation: MISSING/);
  await f.run(`risk ${id} edit ${rid} Longer delay | 2 | 2`); await f.run(`edit ${id} outcome Everyone tries it`);
  await f.run(`mitigate ${id} ${rid} | Practice | Team label`); await f.run(`residual ${id} ${rid} | 1 | 2 | Practice observed`);
  await assert.rejects(f.run(`risk ${id} edit ${rid} Rewritten | 1 | 1`), /frozen/);
  await f.run(`status ${id} ${rid} monitoring`); await f.run(`remove ${id} ${rid} mitigation confirm`); await f.run(`remove ${id} ${rid} residual confirm`);
  await f.run(`risk ${id} edit ${rid} Correction | 1 | 2`); await f.run(`remove ${id} ${rid} risk confirm`); assert.equal((await record(f, id)).risks.length, 0);
  await f.run(`delete ${id} confirm`); await assert.rejects(f.run(`show ${id}`), /not found/);
});
test("refused inputs and malformed saved data preserve bytes", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create A | B")), rid = risk(await f.run(`risk ${id} add Fail | 2 | 3`)); const before = f.backend.data.get(f.key("state"));
  for (const command of [`risk ${id} add Fail | 0 | 3`, `risk ${id} add Fail | 2 | 3 | extra`, `residual ${id} ${rid} | 1 | 1 | `, `status ${id} ${rid} verified`, "create bad\\q | B"]) await assert.rejects(f.run(command));
  assert.equal(f.backend.data.get(f.key("state")), before);
  const corrupt = JSON.parse(before!); corrupt.records[0].risks[0].likelihood = 0; f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const raw = f.backend.data.get(f.key("state"));
  await assert.rejects(f.run(`delete ${id} confirm`), /Invalid saved/); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("12 plans, 20 risks, complete paginated fields and Unicode residual completion", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(root(await f.run(`create Plan ${i} | Outcome`)));
  await assert.rejects(f.run("create Overflow | Outcome")); const lists = (await f.run("list 1")) + (await f.run("list 2")); for (const id of ids) assert.ok(lists.includes(id));
  const id = ids[11], risks: string[] = []; for (let i = 0; i < 20; i++) risks.push(risk(await f.run(`risk ${id} add ${"文".repeat(150)} ${i} | 3 | 4`)));
  await assert.rejects(f.run(`risk ${id} add Overflow | 1 | 1`));
  for (const rid of risks) await f.run(`residual ${id} ${rid} | 2 | 3 | ${"界".repeat(85)}`);
  const out = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(out) <= 24576); assert.equal(JSON.parse(out).record.risks.length, 20);
  let cmd = `show ${id}`, pages = "", count = 0;
  while (cmd) { const page = await f.run(cmd); assert.ok(page.length <= 3500); pages += page; count++; const next = page.match(/\/nobo-help agent premortem (show [^\n]+)/); cmd = next?.[1] ?? ""; assert.ok(count < 30); }
  for (const rid of risks) assert.ok(pages.includes(rid)); assert.ok(pages.includes("界".repeat(85))); assert.ok(count > 1);
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152); await f.run(`delete ${id} confirm`);
});
test("suggestions are explicit, bounded and unsaved; stale deletion wins", async () => {
  const pending = deferred<string>(), started = deferred<void>();
  const f = createAgentFeatureFixture(feature, { services: { generate: async () => { started.resolve(); return pending.promise; } } });
  const id = root(await f.run("create Launch | Complete exercise")); const request = f.run(`suggest ${id}`); await started.promise; await f.run(`delete ${id} confirm`); pending.resolve('["Setup may take longer than expected"]'); await assert.rejects(request, /not found/); assert.equal(f.calls.generate, 1); assert.equal((await f.store().read<any>("state"))!.records.length, 0);
  const fake = createAgentFeatureFixture(feature, { services: { generate: async () => '["Timing may slip"]' } }); const second = root(await fake.run("create A | B")), before = fake.backend.data.get(fake.key("state")); assert.match(await fake.run(`suggest ${second}`), /Unsaved hypothetical/); assert.equal(fake.backend.data.get(fake.key("state")), before);
  const failed = createAgentFeatureFixture(feature); const third = root(await failed.run("create A | B")); assert.match(await failed.run(`suggest ${third}`), /Assistance unavailable/); assert.equal(failed.calls.generate, 1);
});
