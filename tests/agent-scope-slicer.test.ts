import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/scope-slicer.js";
import { createAgentFeatureFixture } from "./helpers/agent-feature-fixture.js";
const idFrom = (reply: string, prefix: string) => { const id = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`))?.[0]; assert.ok(id, reply); return id; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
async function allPages(f: ReturnType<typeof createAgentFeatureFixture>, command: string) {
  const first = await f.run(command), pages = Number(first.match(/Page 1\/(\d+)/)![1]); let all = first;
  assert.ok(first.length <= 3500);
  for (let p = 2; p <= pages; p++) { const reply = await f.run(`${command} ${p}`); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed()); all += reply; }
  return all;
}

test("documented workflow keeps mandatory closure, exposes cuts, and supports complete edit/selection/removal", async () => {
  const f = createAgentFeatureFixture(feature), scope = idFrom(await f.run(feature.example!.split("scope-slicer ")[1]), "scope");
  const install = idFrom(await f.run(`item ${scope} add Install guide | must | 90 | A clean install succeeds`), "item");
  const shots = idFrom(await f.run(`item ${scope} add Screenshots | could | 60 | Three accurate screenshots`), "item");
  await f.run(`requires ${scope} ${shots} | ${install}`);
  let report = await allPages(f, `slice ${scope}`);
  assert.match(report, /Required core fits: 90 of 180/); assert.match(report, /included 2; deferred 0; used 150; remaining 30/);
  assert.match(report, /incremental cost 60 minutes for 1 new item/);
  const before = f.backend.data.get(f.key("state"));
  report = await allPages(f, `what-if ${scope} | 100`);
  assert.match(report, /included 1; deferred 1; used 90; remaining 10/); assert.match(report, /60 incremental minutes including prerequisites exceeds remaining 10/);
  assert.equal(f.backend.data.get(f.key("state")), before);
  await f.run(`select ${scope} ${shots}`);
  assert.match(await allPages(f, `what-if ${scope} | 100`), /Infeasible: required core 150 exceeds budget 100 by 50/);
  await f.run(`unselect ${scope} ${shots} confirm`);
  await f.run(`item ${scope} edit ${shots} | Updated shots | should | 40 | Two accurate screenshots`);
  await f.run(`edit ${scope} | Guide v2 | 130`); assert.match(await allPages(f, `slice ${scope}`), /used 130; remaining 0/);
  assert.match(await f.run(`item ${scope} remove ${install} confirm`), /Remove prerequisite edges first/);
  await f.run(`unrequire ${scope} ${shots} | ${install} confirm`); await f.run(`item ${scope} remove ${install} confirm`);
  assert.equal((await record(f, scope)).items[0].acceptance, "Two accurate screenshots");
  await f.run(`delete ${scope} confirm`); assert.match(await f.run(`show ${scope}`), /not found/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("transitive/shared prerequisites count once and a must is never quietly deferred", async () => {
  const f = createAgentFeatureFixture(feature), scope = idFrom(await f.run("create Closure | 140"), "scope");
  const base = idFrom(await f.run(`item ${scope} add Foundation | could | 30 | Base ready`), "item");
  const middle = idFrom(await f.run(`item ${scope} add Middle | should | 20 | Middle ready`), "item");
  const first = idFrom(await f.run(`item ${scope} add First outcome | must | 50 | First accepted`), "item");
  const second = idFrom(await f.run(`item ${scope} add Second outcome | must | 40 | Second accepted`), "item");
  await f.run(`requires ${scope} ${middle} | ${base}`); await f.run(`requires ${scope} ${first} | ${middle}`); await f.run(`requires ${scope} ${second} | ${base}`);
  let report = await allPages(f, `slice ${scope}`); assert.match(report, /Required core fits: 140 of 140/); assert.match(report, /Required 4 item/);
  assert.ok(report.indexOf(`${base} · required prerequisite`) < report.indexOf(`${first} · must`));
  report = await allPages(f, `what-if ${scope} | 100`); assert.match(report, /Infeasible: required core 140 exceeds budget 100 by 40/); assert.match(report, /included 4; deferred 0; used 140; over budget 40/);
  assert.ok(report.includes(`${first} · must`) && report.includes(`${second} · must`));
  const before = await record(f, scope); await f.run(`unselect ${scope} ${first} confirm`);
  assert.equal((await record(f, scope)).items.find((i: { id: string }) => i.id === first).priority, "must");
  assert.deepEqual(before.items, (await record(f, scope)).items);
});

test("optional priority/entered-order heuristic uses full incremental prerequisite cost", async () => {
  const f = createAgentFeatureFixture(feature), scope = idFrom(await f.run("create Heuristic | 75"), "scope");
  const base = idFrom(await f.run(`item ${scope} add Shared base | could | 20 | Base`), "item");
  const cheap = idFrom(await f.run(`item ${scope} add Early could | could | 20 | Cheap`), "item");
  const should = idFrom(await f.run(`item ${scope} add Later should | should | 30 | Better`), "item");
  const next = idFrom(await f.run(`item ${scope} add Next should | should | 30 | Next`), "item");
  await f.run(`requires ${scope} ${should} | ${base}`); await f.run(`requires ${scope} ${next} | ${base}`);
  const report = await allPages(f, `slice ${scope}`);
  assert.ok(report.includes(`${should}: included by should priority and entered order; incremental cost 50 minutes for 2 new item(s)`));
  assert.ok(report.includes(`${next}: deferred; 30 incremental minutes including prerequisites exceeds remaining 25`));
  assert.ok(report.includes(`${cheap}: included by could priority and entered order; incremental cost 20`));
  assert.match(report, /used 70; remaining 5/); assert.match(report, /No must or explicitly selected items declared/);
});

test("cycles, missing prerequisites, invalid priorities/effort and blank acceptance are refused atomically", async () => {
  const f = createAgentFeatureFixture(feature), scope = idFrom(await f.run("create DAG | 100"), "scope");
  const a = idFrom(await f.run(`item ${scope} add A | must | 10 | A accepted`), "item"), b = idFrom(await f.run(`item ${scope} add B | could | 10 | B accepted`), "item");
  await f.run(`requires ${scope} ${b} | ${a}`); const before = f.backend.data.get(f.key("state"));
  const cycle = await f.run(`requires ${scope} ${a} | ${b}`); assert.match(cycle, /Cycle:/); assert.ok(cycle.includes(a) && cycle.includes(b));
  for (const cmd of [`requires ${scope} ${a} | ${a}`, `requires ${scope} ${a} | item-00000000-0000-0000-0000-000000000000`, `item ${scope} add X | maybe | 10 | X`, `item ${scope} edit ${a} | X | must | 0 | X`, `item ${scope} add X | must | 10 | `, `what-if ${scope} | NaN`]) {
    assert.ok(!(await f.run(cmd)).includes("Saved privately")); assert.equal(f.backend.data.get(f.key("state")), before);
  }
  assert.match(await allPages(f, `what-if ${scope} | 0`), /Infeasible: required core 10 exceeds budget 0/);
});

test("maximum roots/items/edges and complete final acceptance are retrievable without clipping", async () => {
  const f = createAgentFeatureFixture(feature); let scope = "";
  for (let i = 0; i < 8; i++) scope = idFrom(await f.run(`create Scope ${i} | 80640`), "scope");
  assert.ok((await f.run("list")).includes(scope)); assert.match(await f.run("create Extra | 1"), /Maximum 8/);
  const nodes: string[] = [];
  for (let i = 0; i < 24; i++) nodes.push(idFrom(await f.run(`item ${scope} add ${i} 漢😀 <@UOTHER> | could | 1 | ${i} ${"漢😀é\"".repeat(30)}`), "item"));
  let edges = 0;
  for (let i = 1; i < 24 && edges < 60; i++) for (let j = 0; j < i && edges < 60; j++, edges++) assert.match(await f.run(`requires ${scope} ${nodes[i]} | ${nodes[j]}`), /Saved privately/);
  assert.match(await f.run(`requires ${scope} ${nodes[23]} | ${nodes[0]}`), /Maximum 60/);
  assert.match(await f.run(`item ${scope} add Extra | could | 1 | X`), /Maximum 24/);
  assert.ok((await allPages(f, `slice ${scope}`)).includes(nodes[23])); assert.ok((await allPages(f, `show ${scope}`)).includes(nodes[23]));
  const last = (await record(f, scope)).items[23]; assert.equal(last.acceptance, `23 ${"漢😀é\"".repeat(30)}`);
  assert.ok(Buffer.byteLength(await f.run(`export ${scope}`)) <= 24576);
});

test("Unicode quota admission reserves every selection toggle; wrong-type priority state is preserved", async () => {
  const f = createAgentFeatureFixture(feature), roots: string[] = [];
  for (let i = 0; i < 8; i++) roots.push(idFrom(await f.run(`create Scope ${i} | 10080`), "scope"));
  let refused = false; const accepted: [string, string][] = [];
  for (const scope of roots) for (let i = 0; i < 24 && !refused; i++) {
    const before = f.backend.data.get(f.key("state")), reply = await f.run(`item ${scope} add ${"漢😀\"".repeat(45)} | could | 1 | ${"😀é".repeat(40)}`);
    if (reply.includes("quota")) { refused = true; assert.equal(f.backend.data.get(f.key("state")), before); } else accepted.push([scope, idFrom(reply, "item")]);
  }
  assert.ok(refused);
  for (const [scope, item] of accepted) { assert.match(await f.run(`select ${scope} ${item}`), /explicitly required/); assert.match(await f.run(`unselect ${scope} ${item} confirm`), /selection removed/); }
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
  const state = JSON.parse(f.backend.data.get(f.key("state"))!); state.records[0].items[0].priority = ["must"];
  f.backend.data.set(f.key("state"), JSON.stringify(state)); const raw = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`delete ${roots[0]} confirm`), /could not be read safely/); assert.equal(f.backend.data.get(f.key("state")), raw);
});
