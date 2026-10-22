import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/context-batch.js";
import { createAgentFeatureFixture } from "./helpers/agent-feature-fixture.js";

const idFrom = (reply: string, prefix: string) => {
  const id = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`))?.[0]; assert.ok(id, reply); return id;
};
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;

test("documented workflow amortizes setup, records only explicit completion, and supports every edit/removal", async () => {
  const f = createAgentFeatureFixture(feature);
  const board = idFrom(await f.run(feature.example!.split("context-batch ")[1]), "board");
  const setup = idFrom(await f.run(`setup ${board} | expense portal | 8`), "setup");
  const hotel = idFrom(await f.run(`action ${board} add File hotel receipt | 10 | expense portal | laptop | home`), "action");
  const train = idFrom(await f.run(`action ${board} add File train receipt | 5 | expense portal | laptop | home`), "action");
  const batch = await f.run(`batch ${board} | home | laptop`);
  assert.match(batch, /15 action \+ 8 setup = 23 minutes/); assert.match(batch, /remaining 37/); assert.match(batch, /Setup savings 8/);
  assert.equal((await record(f, board)).actions[0].status, "pending");
  await f.run(`complete ${board} ${hotel}`);
  assert.match(await f.run(`batch ${board}`), /used 13/);
  assert.match(await f.run(`batch ${board}`), /user-reported completed/);
  await f.run(`reopen ${board} ${hotel}`);
  await f.run(`setup-edit ${board} ${setup} | portal v2 | 4`);
  assert.equal((await record(f, board)).actions[0].setupKey, "portal v2");
  await f.run(`action ${board} edit ${train} | File rail receipt | 6 | portal v2 | laptop | home`);
  await f.run(`edit ${board} | Short admin session | 20`);
  assert.match(await f.run(`batch ${board}`), /used 20; remaining 0/);
  assert.match(await f.run(`setup-remove ${board} ${setup} confirm`), /used by an action/);
  await f.run(`action ${board} remove ${hotel} confirm`); await f.run(`action ${board} remove ${train} confirm`);
  await f.run(`setup-remove ${board} ${setup} confirm`); await f.run(`context-clear ${board} confirm`);
  assert.deepEqual((await record(f, board)).setups, []);
  assert.equal((await record(f, board)).context, null);
  assert.match(await f.run(`delete ${board}`), /Delete .* and all/);
  await f.run(`delete ${board} confirm`); assert.match(await f.run(`show ${board}`), /not found/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("greedy grouping skips oversized work, discloses missing setup/tools/location, and never invents availability", async () => {
  const f = createAgentFeatureFixture(feature), board = idFrom(await f.run("create Errands | 20"), "board");
  await f.run(`setup ${board} | portal | 8`);
  const large = idFrom(await f.run(`action ${board} add Too large | 30 | portal | laptop | home`), "action");
  const small = idFrom(await f.run(`action ${board} add Small task | 5 | portal | laptop | home`), "action");
  await f.run(`action ${board} add Buy stamp | 2 | - | wallet | post office`);
  await f.run(`action ${board} add Unknown setup | 1 | mystery | - | -`);
  assert.match(await f.run(`batch ${board}`), /Set available context first/);
  const result = await f.run(`batch ${board} | home | laptop`);
  assert.match(result, /used 13/); assert.ok(result.includes(large)); assert.ok(result.includes(small));
  assert.match(result, /missing tools: wallet/); assert.match(result, /needs location post office/); assert.match(result, /unknown setup cost: mystery/);
});

test("maximum board and action pages recover final IDs and complete Unicode fields without double escaping", async () => {
  const f = createAgentFeatureFixture(feature); let board = "";
  for (let i = 0; i < 12; i++) board = idFrom(await f.run(`create Board ${i} | 10080`), "board");
  assert.ok((await f.run("list 2")).includes(board));
  assert.match(await f.run("create Excess | 60"), /Maximum 12/);
  let child = "";
  for (let i = 0; i < 40; i++) child = idFrom(await f.run(`action ${board} add ${i} 漢😀 <@UOTHER> & é | 1 | - | - | -`), "action");
  assert.match(await f.run(`action ${board} add extra | 1 | - | - | -`), /Maximum 40/);
  const exported = await f.run(`export ${board}`); assert.ok(Buffer.byteLength(exported) <= 24576);
  const first = await f.run(`show ${board}`), pages = Number(first.match(/Page 1\/(\d+)/)![1]);
  let all = "";
  for (let page = 1; page <= pages; page++) { const result = await f.run(`show ${board} ${page}`); assert.ok(result.length <= 3500); assert.ok(result.isWellFormed()); all += result; }
  assert.ok(all.includes(child)); assert.ok(all.includes("漢😀 <@UOTHER> & é")); assert.ok(!all.includes("&amp;"));
  await f.run(`batch ${board} | - | -`);
  const reportFirst = await f.run(`batch ${board}`), reportPages = Number(reportFirst.match(/Page 1\/(\d+)/)![1]);
  let reports = "";
  for (let p = 1; p <= reportPages; p++) { const result = await f.run(`batch ${board} ${p}`); assert.ok(result.length <= 3500); reports += result; }
  assert.ok(reports.includes(child)); assert.ok(!(await f.run(`batch ${board} ${reportPages}`)).includes(`batch ${board} ${reportPages + 1}`));
});

test("Unicode content admission reserves completion and preserves rejected edits and malformed data", async () => {
  const f = createAgentFeatureFixture(feature), boards: string[] = [];
  for (let n = 0; n < 12; n++) boards.push(idFrom(await f.run(`create ${n} ${"😀".repeat(30)} | 600`), "board"));
  const accepted: [string, string][] = [];
  let refused = false;
  for (const board of boards) {
    for (let i = 0; i < 40 && !refused; i++) {
      const before = f.backend.data.get(f.key("state"));
      const reply = await f.run(`action ${board} add ${"漢😀\"".repeat(45)} | 1 | - | - | -`);
      if (reply.includes("quota")) { assert.equal(f.backend.data.get(f.key("state")), before); refused = true; }
      else accepted.push([board, idFrom(reply, "action")]);
    }
  }
  assert.ok(refused); assert.ok(accepted.length > 20);
  for (const [board, action] of accepted) assert.match(await f.run(`complete ${board} ${action}`), /user-reported completed/);
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
  const before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`edit ${boards[0]} | bad | NaN`), /integer/); assert.equal(f.backend.data.get(f.key("state")), before);
  const corrupt = JSON.parse(before!); corrupt.records[0].actions[0].minutes = "5";
  f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const raw = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`delete ${boards[0]} confirm`), /could not be read safely/); assert.equal(f.backend.data.get(f.key("state")), raw);
  assert.equal(await f.run("help"), feature.help);
});

test("pipe escapes are retained exactly and extra input does not mutate", async () => {
  const f = createAgentFeatureFixture(feature), board = idFrom(await f.run(String.raw`create Admin \| work \\ home | 60`), "board");
  assert.equal((await record(f, board)).title, String.raw`Admin | work \ home`);
  const before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`edit ${board} | title | 10 | extra`), /pipe-separated/);
  assert.match(await f.run(`action ${board} add task | 5 | - | laptop,laptop | home`), /distinct/);
  assert.equal(f.backend.data.get(f.key("state")), before);
});
