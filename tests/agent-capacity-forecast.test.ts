import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/capacity-forecast.js";
import { createAgentFeatureFixture } from "./helpers/agent-feature-fixture.js";
const idFrom = (reply: string, prefix: string) => { const id = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`))?.[0]; assert.ok(id, reply); return id; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
async function allPages(f: ReturnType<typeof createAgentFeatureFixture>, command: string) {
  const first = await f.run(command), pages = Number(first.match(/Page 1\/(\d+)/)![1]); let all = first;
  assert.ok(first.length <= 3500);
  for (let page = 2; page <= pages; page++) { const reply = await f.run(`${command} ${page}`); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed()); all += reply; }
  return all;
}

test("documented forecast and full edit/remove workflow independently allocate low/high scenarios", async () => {
  const f = createAgentFeatureFixture(feature), id = idFrom(await f.run(feature.example!.split("capacity-forecast ")[1]), "forecast");
  assert.match(await f.run(`forecast ${id}`), /Unknown capacity weeks: 1, 2/);
  await f.run(`capacity ${id} | 1 | 600`); await f.run(`capacity ${id} | 2 | 600`);
  const child = idFrom(await f.run(`package ${id} add Documentation | 500 | 900 | 1 | 2`), "package");
  const report = await allPages(f, `forecast ${id}`);
  assert.match(report, /Low allocations \[500, 0\]; high \[600, 300\]/); assert.match(report, /Known-window overflow: low 0, high 0/);
  const before = f.backend.data.get(f.key("state")), whatif = await allPages(f, `what-if ${id} capacity | 2 | 100`);
  assert.match(whatif, /Overflow comparison low\/high: 0\/0 → 0\/200/); assert.equal(f.backend.data.get(f.key("state")), before);
  await f.run(`package ${id} edit ${child} | Revised documentation | 700 | 1000 | 1 | 2`);
  await f.run(`edit ${id} | December delivery | 2026-11-30 | 3`);
  assert.deepEqual((await record(f, id)).capacity, [600, 600, null]);
  await f.run(`capacity ${id} | 3 | 400`);
  assert.match(await f.run(`edit ${id} | Shorter | 2026-11-30 | 2`), /remove supplied capacity/);
  await f.run(`capacity-clear ${id} 3 confirm`); await f.run(`edit ${id} | Shorter | 2026-11-30 | 2`);
  await f.run(`package ${id} remove ${child} confirm`); assert.deepEqual((await record(f, id)).packages, []);
  await f.run(`delete ${id} confirm`); assert.match(await f.run(`show ${id}`), /not found/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("unknown capacity is unassessed, explicit zero gives overflow, and finish windows never borrow later weeks", async () => {
  const f = createAgentFeatureFixture(feature), id = idFrom(await f.run("create Unknown | 2026-11-02 | 2"), "forecast");
  await f.run(`capacity ${id} | 2 | 600`);
  await f.run(`package ${id} add Due first week | 100 | 300 | 1 | 1`);
  let report = await allPages(f, `forecast ${id}`);
  assert.match(report, /Known-window overflow: low 0, high 0/); assert.match(report, /Unassessed remainder with unknown eligible capacity: low 100, high 300/);
  assert.match(report, /capacity unknown; load unassessed/);
  await f.run(`capacity ${id} | 1 | 0`); report = await allPages(f, `forecast ${id}`);
  assert.match(report, /Known-window overflow: low 100, high 300/); assert.match(report, /Week 2 .*load low\/high 0\/0/);
  assert.match(report, /Finish-window result: low 100 overflow minutes; high 300 overflow minutes/);
});

test("stable earliest-first package order is disclosed and input refusals preserve exact state", async () => {
  const f = createAgentFeatureFixture(feature), id = idFrom(await f.run("create Order | 2026-11-02 | 2"), "forecast");
  await f.run(`capacity ${id} | 1 | 100`); await f.run(`capacity ${id} | 2 | 100`);
  await f.run(`package ${id} add Flexible first | 100 | 100 | 1 | 2`);
  await f.run(`package ${id} add Tight second | 100 | 100 | 1 | 1`);
  assert.match(await allPages(f, `forecast ${id}`), /Known-window overflow: low 100, high 100/);
  const before = f.backend.data.get(f.key("state"));
  for (const cmd of ["create Bad | 2026-11-03 | 2", "create Bad | 2026-02-30 | 2", `package ${id} add Bad | 900 | 500 | 1 | 2`, `package ${id} add Bad | 1 | 2 | 2 | 1`, `capacity ${id} | 1 | Infinity`, `capacity ${id} | 3 | 10`, `package ${id} remove foreign confirm`]) {
    const reply = await f.run(cmd); assert.ok(!reply.includes("Saved privately"), reply); assert.equal(f.backend.data.get(f.key("state")), before);
  }
  assert.match(await f.run(`forecast ${id} 0`), /Page must be an integer/);
});

test("all eight roots, eight civil weeks and 24 packages remain retrievable through final report/detail pages", async () => {
  const f = createAgentFeatureFixture(feature); let id = "", child = "";
  for (let i = 0; i < 8; i++) id = idFrom(await f.run(`create Board ${i} | 2026-10-26 | 8`), "forecast");
  assert.ok((await f.run("list")).includes(id)); assert.match(await f.run("create Extra | 2026-11-02 | 2"), /Maximum 8/);
  for (let i = 1; i <= 8; i++) await f.run(`capacity ${id} | ${i} | 10`);
  for (let i = 0; i < 24; i++) child = idFrom(await f.run(`package ${id} add ${i} 漢😀 <@UOTHER> & tail | 1 | 2 | 1 | 8`), "package");
  assert.match(await f.run(`package ${id} add excess | 1 | 2 | 1 | 2`), /Maximum 24/);
  const details = await allPages(f, `show ${id}`), report = await allPages(f, `forecast ${id}`);
  assert.ok(details.includes(child)); assert.ok(report.includes(child)); assert.match(report, /Week 8 \(2026-12-14–2026-12-20\)/);
  assert.ok(!details.includes("&amp;")); assert.ok(Buffer.byteLength(await f.run(`export ${id}`)) <= 24576);
  const before = f.backend.data.get(f.key("state")); await allPages(f, `what-if ${id} capacity | 8 | 0`); assert.equal(f.backend.data.get(f.key("state")), before);
});

test("Unicode content quotas and invalid persisted windows preserve records and allow quota recovery", async () => {
  const f = createAgentFeatureFixture(feature), roots: string[] = [];
  for (let i = 0; i < 8; i++) roots.push(idFrom(await f.run(`create ${i} ${"😀".repeat(30)} | 2026-11-02 | 2`), "forecast"));
  let refused = false;
  for (const id of roots) for (let n = 0; n < 24 && !refused; n++) {
    const before = f.backend.data.get(f.key("state")), reply = await f.run(`package ${id} add ${"漢😀\"".repeat(45)} | 1 | 2 | 1 | 2`);
    if (reply.includes("quota")) { refused = true; assert.equal(f.backend.data.get(f.key("state")), before); } else idFrom(reply, "package");
  }
  assert.ok(refused); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 32768);
  await f.run(`delete ${roots[0]} confirm`); assert.match(await f.run(`capacity ${roots[1]} | 1 | 10`), /Saved privately/);
  const state = JSON.parse(f.backend.data.get(f.key("state"))!); state.records[0].packages[0].latest = 9;
  f.backend.data.set(f.key("state"), JSON.stringify(state)); const corrupt = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`delete ${roots[1]} confirm`), /could not be read safely/); assert.equal(f.backend.data.get(f.key("state")), corrupt);
});
