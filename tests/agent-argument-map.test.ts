import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/argument-map.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const child = (s: string) => { const m = s.match(/(?:Node|Edge): ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const rec = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
async function all(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) { let out = "", n = 0; do { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); out += reply; cmd = reply.match(/Next: \/nobo-help agent argument-map ([^\n]+)/)?.[1] ?? ""; assert.ok(++n < 100); } while (cmd); return out; }
test("catalog graph reports unsupported reasons and unanswered objections; evidence/rebuttal address gaps", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.split("argument-map ")[1])), r = (await rec(f, id)).rootId;
  const reason = child(await f.run(`node ${id} add reason | Fewer fields reduce initial effort`)), objection = child(await f.run(`node ${id} add objection | Required information may be missing`));
  await f.run(`link ${id} ${reason} | supports | ${r}`); await f.run(`link ${id} ${objection} | challenges | ${reason}`); const a = await f.run(`audit ${id}`); assert.match(a, new RegExp(`UNSUPPORTED LEAF ${reason}`)); assert.match(a, new RegExp(`UNANSWERED OBJECTION ${objection}`));
  const evidence = child(await f.run(`node ${id} add evidence | 8 users completed the short form`)), rebuttal = child(await f.run(`node ${id} add rebuttal | Request extra details after signup`)); await f.run(`label ${id} ${evidence} | Pilot notes; not verified`); await f.run(`link ${id} ${evidence} | evidences | ${reason}`); await f.run(`link ${id} ${rebuttal} | rebuts | ${objection}`);
  const reviewed = await f.run(`audit ${id}`); assert.doesNotMatch(reviewed, /UNANSWERED OBJECTION/); assert.ok(!reviewed.includes(`UNSUPPORTED LEAF ${reason}`)); assert.match(reviewed, /Evidence labels do not establish truth/); assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("typed edges, cycles, duplicates, self-links and incompatible node edits reject atomically", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Position")), r = (await rec(f, id)).rootId, a = child(await f.run(`node ${id} add reason | A`)), b = child(await f.run(`node ${id} add reason | B`));
  await f.run(`link ${id} ${a} | supports | ${r}`); await f.run(`link ${id} ${b} | supports | ${a}`); const raw = f.backend.data.get(f.key("state"));
  for (const cmd of [`link ${id} ${a} | supports | ${b}`, `link ${id} ${a} | supports | ${a}`, `link ${id} ${a} | supports | ${r}`, `link ${id} ${a} | rebuts | ${r}`, `node ${id} edit ${a} | evidence | New type`, `node ${id} edit ${r} | reason | Root type`]) await assert.rejects(f.run(cmd));
  assert.equal(f.backend.data.get(f.key("state")), raw); await assert.rejects(f.run(`link ${id} ${a} | supports | ${b}`), /Cycle rejected.*circular dependence/);
});
test("shared diamond and disconnected branches retain every node and edge exactly once in traversal", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Position")), r = (await rec(f, id)).rootId;
  const a = child(await f.run(`node ${id} add reason | Left branch`)), b = child(await f.run(`node ${id} add reason | Right branch`)), c = child(await f.run(`node ${id} add evidence | Shared evidence`)), d = child(await f.run(`node ${id} add objection | Disconnected objection`));
  for (const [from, relation, to] of [[a, "supports", r], [b, "supports", r], [c, "evidences", a], [c, "evidences", b]]) await f.run(`link ${id} ${from} | ${relation} | ${to}`);
  const output = await all(f, `view ${id}`); assert.equal(output.split("Shared evidence").length - 1, 1); assert.match(output, /shared reference/); assert.match(output, /Disconnected from position/); assert.ok(output.includes(d)); for (const e of (await rec(f, id)).edges) assert.equal(output.split(`Edge ${e.id}`).length - 1, 1);
});
test("all user fields edit/remove, node deletion reports affected edges and preserves peers", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Position")), r = (await rec(f, id)).rootId;
  const a = child(await f.run(`node ${id} add reason | Old`)), e = child(await f.run(`node ${id} add evidence | Evidence`)); const link = child(await f.run(`link ${id} ${a} | supports | ${r}`)); await f.run(`node ${id} edit ${a} | reason | Corrected`); await f.run(`position ${id} | Better position`);
  await f.run(`link-edit ${id} ${link} | ${e} | evidences | ${a}`); await f.run(`label ${id} ${e} | Supplied label`); await f.run(`label ${id} ${e} | Corrected label`); await assert.rejects(f.run(`node ${id} edit ${e} | reason | Changed`), /Remove the evidence label/);
  await f.run(`remove ${id} label ${e} confirm`); assert.match(await f.run(`remove ${id} node ${a} confirm`), /1 attached edges/); const saved = await rec(f, id); assert.ok(saved.nodes.some((n: any) => n.id === e)); assert.equal(saved.edges.length, 0); await f.run(`node ${id} edit ${e} | reason | Changed`);
  const other = child(await f.run(`link ${id} ${e} | supports | ${r}`)); await f.run(`remove ${id} edge ${other} confirm`); await assert.rejects(f.run(`remove ${id} node ${r} confirm`), /root position/); await f.run(`delete ${id}`); assert.ok(await rec(f, id)); await f.run(`delete ${id} confirm`); await assert.rejects(f.run(`show ${id}`), /not found/);
});
test("32-node/64-edge DAG has bounded complete views/exports; Unicode remains exact", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(`create ${esc('<@UOTHER> & "\\| 😀')}`)), r = (await rec(f, id)).rootId, nodes = [r];
  for (let i = 1; i < 32; i++) nodes.push(child(await f.run(`node ${id} add reason | Reason ${i} ${"文".repeat(20)}`)));
  let n = 0; outer: for (let from = 31; from >= 1; from--) for (let to = 0; to < from; to++) { await f.run(`link ${id} ${nodes[from]} | supports | ${nodes[to]}`); if (++n === 64) break outer; }
  await assert.rejects(f.run(`node ${id} add reason | Overflow`)); await assert.rejects(f.run(`link ${id} ${nodes[1]} | supports | ${r}`)); const exp = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(exp) <= 24576); assert.equal(JSON.parse(exp).record.edges.length, 64);
  const shown = await all(f, `show ${id}`), viewed = await all(f, `view ${id}`); assert.ok(shown.includes("<@UOTHER> &")); assert.ok(!shown.includes("&amp;")); for (const nid of nodes) assert.ok(viewed.includes(nid)); await all(f, `audit ${id}`);
});
test("quota rejects new content without eviction; corruption and foreign owners preserve state", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 10; i++) { try { const id = root(await f.run(`create Position ${i}`)); ids.push(id); for (let j = 0; j < 20; j++) await f.run(`node ${id} add reason | ${"界".repeat(195)}${j}`); } catch { break; } }
  assert.ok(ids.length >= 2); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 32768); await f.run(`delete ${ids.at(-1)} confirm`); await assert.rejects(f.run(`show ${ids[0]}`, { owner: { teamId: "TOTHER", userId: "UOTHER" } }), /not found/);
  const bad = JSON.parse(f.backend.data.get(f.key("state"))!); bad.records[0].nodes[0].kind = "evidence"; f.backend.data.set(f.key("state"), JSON.stringify(bad)); const before = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`delete ${ids[0]} confirm`)); assert.equal(f.backend.data.get(f.key("state")), before);
});
test("CAS node deletion wins over an older edge edit and cannot resurrect children", async () => {
  let armed = false; const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) { if (!armed || !previous || !key.endsWith(":state")) return; armed = false; const s = JSON.parse(previous); s.records[0].nodes = s.records[0].nodes.slice(0, 1); s.records[0].edges = []; s.records[0].revision++; backend.data.set(key, JSON.stringify(s)); } });
  const f = createAgentFeatureFixture(feature, { backend }), id = root(await f.run("create Position")), r = (await rec(f, id)).rootId, a = child(await f.run(`node ${id} add reason | Reason`)); armed = true; await assert.rejects(f.run(`link ${id} ${a} | supports | ${r}`), /changed/); assert.equal((await rec(f, id)).nodes.length, 1); assert.equal((await rec(f, id)).edges.length, 0); assert.equal(backend.calls.conflicts, 1);
});
