import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/deadline-backplan.js";
import { createAgentFeatureFixture } from "./helpers/agent-feature-fixture.js";
const idFrom = (reply: string, prefix: string) => { const id = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`))?.[0]; assert.ok(id, reply); return id; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
async function allPages(f: ReturnType<typeof createAgentFeatureFixture>, command: string) {
  const first = await f.run(command), pages = Number(first.match(/Page 1\/(\d+)/)![1]); let all = first;
  assert.ok(first.length <= 3500);
  for (let p = 2; p <= pages; p++) { const reply = await f.run(`${command} ${p}`); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed()); all += reply; }
  return all;
}

test("documented backward pass includes working duration, following buffers, exclusions and full edit/removal", async () => {
  const f = createAgentFeatureFixture(feature), plan = idFrom(await f.run(feature.example!.split("deadline-backplan ")[1]), "plan");
  const abstract = idFrom(await f.run(`milestone ${plan} add Write abstract | 2 | 0`), "milestone");
  const review = idFrom(await f.run(`milestone ${plan} add Review draft | 1 | 1`), "milestone");
  await f.run(`depends ${plan} ${review} | ${abstract}`); await f.run(`exclude ${plan} | 2026-11-26`);
  let report = await allPages(f, `backplan ${plan}`);
  assert.match(report, /Latest start 2026-12-01; work finish 2026-12-02; ready after buffer 2026-12-02/);
  assert.match(report, /Latest start 2026-12-03; work finish 2026-12-03; ready after buffer 2026-12-04/);
  await f.run(`exclude ${plan} | 2026-12-02`); report = await allPages(f, `backplan ${plan}`);
  assert.match(report, /Latest start 2026-11-30; work finish 2026-12-01/);
  await f.run(`include ${plan} | 2026-12-02 confirm`);
  await f.run(`milestone ${plan} edit ${abstract} | Draft abstract | 1 | 0`);
  await f.run(`edit ${plan} | Revised proposal | 2026-12-06 | mon,tue,wed,thu,fri`);
  assert.match(await allPages(f, `backplan ${plan}`), /Finish requested 2026-12-06; latest working finish 2026-12-04/);
  assert.match(await f.run(`milestone ${plan} remove ${abstract} confirm`), /Remove dependency edges first/);
  await f.run(`undepend ${plan} ${review} | ${abstract} confirm`); await f.run(`milestone ${plan} remove ${abstract} confirm`);
  assert.equal((await record(f, plan)).milestones.length, 1);
  await f.run(`delete ${plan} confirm`); assert.match(await f.run(`show ${plan}`), /not found/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("shared predecessor constrains every successor and forward/backward slack is computed from local today", async () => {
  const f = createAgentFeatureFixture(feature, { now: new Date("2026-11-30T16:00:00Z") }), plan = idFrom(await f.run("create Diamond | 2026-12-04 | mon,tue,wed,thu,fri"), "plan");
  const a = idFrom(await f.run(`milestone ${plan} add Build base | 2 | 0`), "milestone");
  const b = idFrom(await f.run(`milestone ${plan} add Review base | 1 | 1`), "milestone");
  const c = idFrom(await f.run(`milestone ${plan} add Write followup | 3 | 0`), "milestone");
  await f.run(`depends ${plan} ${b} | ${a}`); await f.run(`depends ${plan} ${c} | ${a}`);
  const report = await allPages(f, `backplan ${plan}`);
  assert.match(report, /Deadline feasible/);
  assert.match(report, /Latest start 2026-11-30; work finish 2026-12-01/);
  assert.match(report, /Work 2 working day\(s\); buffer none; slack 0/);
  assert.match(report, /Latest start 2026-12-03; work finish 2026-12-03/);
  assert.match(report, /buffer 1 working day\(s\): 2026-12-04–2026-12-04; slack 1/);
  assert.match(report, /Latest start 2026-12-02; work finish 2026-12-04/);
});

test("cycle paths, self cycles and missing prerequisites reject atomically without changing the plan", async () => {
  const f = createAgentFeatureFixture(feature), plan = idFrom(await f.run("create DAG | 2026-12-04 | mon,tue,wed,thu,fri"), "plan");
  const a = idFrom(await f.run(`milestone ${plan} add A | 1 | 0`), "milestone"), b = idFrom(await f.run(`milestone ${plan} add B | 1 | 0`), "milestone");
  await f.run(`depends ${plan} ${b} | ${a}`); const before = f.backend.data.get(f.key("state"));
  const cycle = await f.run(`depends ${plan} ${a} | ${b}`); assert.match(cycle, /Cycle:/); assert.ok(cycle.includes(a) && cycle.includes(b));
  assert.equal(f.backend.data.get(f.key("state")), before);
  assert.match(await f.run(`depends ${plan} ${a} | ${a}`), /Cycle:/);
  assert.match(await f.run(`depends ${plan} ${a} | milestone-00000000-0000-0000-0000-000000000000`), /Missing prerequisite/);
  assert.match(await f.run(`edit ${plan} | X | 2026-12-04 | mon,mon`), /distinct weekday/);
  assert.match(await f.run(`exclude ${plan} | 2026-02-30`), /real YYYY-MM-DD/);
  assert.match(await f.run(`edit ${plan} | X | 2028-12-04 | mon`), /within 366/);
  assert.equal(f.backend.data.get(f.key("state")), before);
});

test("civil dates survive leap days, DST and local-today boundaries; historical starts and bounded horizon failure stay explicit", async () => {
  const leap = createAgentFeatureFixture(feature, { now: new Date("2024-02-28T15:00:00Z") });
  const lp = idFrom(await leap.run("create Leap | 2024-02-29 | mon,tue,wed,thu,fri"), "plan");
  await leap.run(`milestone ${lp} add Leap work | 2 | 0`);
  assert.match(await allPages(leap, `backplan ${lp}`), /Latest start 2024-02-28; work finish 2024-02-29/);
  const dst = createAgentFeatureFixture(feature, { now: new Date("2026-11-02T00:30:00Z"), timezone: "America/Chicago" });
  const p = idFrom(await dst.run("create DST | 2026-11-02 | mon,tue,wed,thu,fri"), "plan");
  const m = idFrom(await dst.run(`milestone ${p} add Cross weekend | 2 | 0`), "milestone");
  const report = await allPages(dst, `backplan ${p}`);
  assert.match(report, /Today 2026-11-01 \(America\/Chicago\)/); assert.match(report, /Latest start 2026-10-30; work finish 2026-11-02/); assert.match(report, /Deadline at risk/);
  await dst.run(`milestone ${p} edit ${m} | Too much | 366 | 0`);
  assert.match(await allPages(dst, `backplan ${p}`), /Infeasible within the 366-day analysis horizon/);
  assert.equal((await record(dst, p)).milestones[0].durationDays, 366);
});

test("maximum plans/nodes/edges/exclusions and every final detail/report remain bounded and accessible", async () => {
  const f = createAgentFeatureFixture(feature); let plan = "";
  for (let i = 0; i < 8; i++) plan = idFrom(await f.run(`create ${i} | 2026-12-04 | mon,tue,wed,thu,fri`), "plan");
  assert.ok((await f.run("list")).includes(plan));
  const nodes: string[] = [];
  for (let i = 0; i < 20; i++) nodes.push(idFrom(await f.run(`milestone ${plan} add ${i} ${"漢😀\"".repeat(20)} | 1 | 0`), "milestone"));
  let edges = 0;
  for (let i = 1; i < 20 && edges < 60; i++) for (let j = 0; j < i && edges < 60; j++, edges++) assert.match(await f.run(`depends ${plan} ${nodes[i]} | ${nodes[j]}`), /Saved privately/);
  assert.match(await f.run(`depends ${plan} ${nodes[19]} | ${nodes[0]}`), /Maximum 60/);
  for (let day = 1; day <= 30; day++) await f.run(`exclude ${plan} | 2026-10-${String(day).padStart(2, "0")}`);
  assert.match(await f.run(`exclude ${plan} | 2026-10-31`), /Maximum 30/);
  assert.match(await f.run(`milestone ${plan} add Extra | 1 | 0`), /Maximum 20/);
  assert.ok((await allPages(f, `show ${plan}`)).includes(nodes[19])); assert.ok((await allPages(f, `backplan ${plan}`)).includes(nodes[19]));
  assert.ok(Buffer.byteLength(await f.run(`export ${plan}`)) <= 24576);
  const raw = JSON.parse(f.backend.data.get(f.key("state"))!); raw.records[7].milestones[0].predecessors.push(nodes[19]); raw.records[7].milestones[19].predecessors.push(nodes[0]);
  f.backend.data.set(f.key("state"), JSON.stringify(raw)); const before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`delete ${plan} confirm`), /could not be read safely/); assert.equal(f.backend.data.get(f.key("state")), before);
});

test("Unicode admission near quota preserves rejected content and permits complete report and removal", async () => {
  const f = createAgentFeatureFixture(feature), plans: string[] = [];
  for (let i = 0; i < 8; i++) plans.push(idFrom(await f.run(`create ${i} ${"😀".repeat(30)} | 2026-12-04 | mon,tue,wed,thu,fri`), "plan"));
  let refused = false;
  for (const plan of plans) for (let i = 0; i < 20 && !refused; i++) {
    const before = f.backend.data.get(f.key("state")), reply = await f.run(`milestone ${plan} add ${"漢😀\"".repeat(45)} | 1 | 0`);
    if (reply.includes("quota")) { refused = true; assert.equal(f.backend.data.get(f.key("state")), before); } else idFrom(reply, "milestone");
  }
  assert.ok(refused); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 32768);
  await allPages(f, `backplan ${plans[0]}`); await f.run(`delete ${plans[0]} confirm`);
  assert.match(await f.run(`milestone ${plans[7]} add Retry | 1 | 0`), /Saved privately/);
});
