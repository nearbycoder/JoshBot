import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/number-audit.js";
import metadata from "../lib/agent-features/number-audit.metadata.js";
const CREATE = "create Launch metrics", PREFIX = "audit", TITLE = "Launch metrics";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {
  for (let i=0;i<16;i++) assert.match(await f.run(`check ${id} add sum | ${Array(20).fill("1000000000").join(",")} | 0 | 0 | minutes`), /Saved privately/);
}
test("catalog example reconciles -40 percent and 50 minutes, explicit correction and all edits", async () => {
  const f=createAgentFeatureFixture(feature),id=await setup(f);
  const a=uid(await f.run(`check ${id} add percent-change | 20,12 | -40 | 0.01 | percent`),"check");
  const b=uid(await f.run(`check ${id} add sum | 15,25,10 | 55 | 0 | minutes`),"check");
  let out=await f.run(`run ${id}`);assert.match(out,/PASS: result -40/);assert.match(out,/MISMATCH: result 50/);
  await f.run(`correct ${id} ${b} | 50`);out=await f.run(`run ${id}`);assert.equal(out.match(/PASS:/g)?.length,2);
  await f.run(`check ${id} edit ${a} | weighted-average | 10@points:1,20@points:3 | 17.5 | 0 | points`);assert.match(await f.run(`run ${id}`),/PASS: result 17.5/);
  await f.run(`edit ${id} | title | New \\| audit`);assert.equal((await state(f)).records[0].title,"New | audit");
  await f.run(`check ${id} remove ${a} confirm`);await f.run(`check ${id} remove ${b} confirm`);assert.equal((await state(f)).records[0].checks.length,0);
  assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("independent rational truth: signed bases, exact tolerance boundaries, zero and tiny positive",async()=>{
  const f=createAgentFeatureFixture(feature),id=await setup(f);
  for(const [op,values,claim,tol,u,expected] of [
    ["percent-change","-20,-12","-40","0","percent","PASS"],
    ["percent-change","0,12","0","0","percent","UNDEFINED"],
    ["weighted-average","0:2,1:1","0.333333","0.000001","points","PASS"],
    ["weighted-average","0:2,1:1","0.333332","0.000001","points","MISMATCH"],
    ["sum","0.1,0.2","0.3","0","points","PASS"],
    ["sum","-1.000001,0","-1","0.000001","points","PASS"],
    ["weighted-average","0.000001:0.000001,0:1000000000","0","0","points","MISMATCH"],
  ]){
    const c=uid(await f.run(`check ${id} add ${op} | ${values} | ${claim} | ${tol} | ${u}`),"check");
    const out=await f.run(`run ${id}`);assert.match(out,new RegExp(expected));
    if(values.startsWith("0.000001:")){assert.match(out,/nonzero/);assert.doesNotMatch(out,/result (?:≈)?0 /);}
    await f.run(`check ${id} remove ${c} confirm`);
  }
});
test("bad arithmetic, typed enums and unknown persisted fields preserve exact bytes",async()=>{
  const f=createAgentFeatureFixture(feature),id=await setup(f);
  await f.run(`check ${id} add sum | 1 | 1 | 0 | minutes`);const original=f.backend.data.get(f.key("state"))!;
  for(const spec of ["sum | 1@minutes,2@hours | 3 | 0 | minutes","sum | 1e3 | 1 | 0 | minutes","sum | 0.0000001 | 0 | 0 | minutes","weighted-average | 1:0,2:0 | 1 | 0 | points","weighted-average | 1:-1 | 1 | 0 | points","weighted-average | 1:1,2 | 1 | 0 | points","percent-change | 1,2,3 | 1 | 0 | percent","sum | 1000000001 | 1 | 0 | points","sum | 1 | 1 | -1 | points"]){await f.run(`check ${id} add ${spec}`);assert.equal(f.backend.data.get(f.key("state")),original);}
  for(const mutate of [(s:any)=>s.records[0].checks[0].operation=["sum"],(s:any)=>s.records[0].checks[0].operands[0].weight="1",(s:any)=>s.records[0].checks[0].extra=1]){const s=JSON.parse(original);mutate(s);const raw=JSON.stringify(s);f.backend.data.set(f.key("state"),raw);assert.match(await f.run(`delete ${id} confirm`),/preserved/);assert.equal(f.backend.data.get(f.key("state")),raw);}
});
test("count boundaries, exact export, emitted pages and legacy aggregate recovery",async()=>{
  const f=createAgentFeatureFixture(feature),id=await setup(f);await populate(f,id);
  for(let i=16;i<20;i++)assert.match(await f.run(`check ${id} add sum | 1 | 1 | 0 | points`),/Saved privately/);
  assert.match(await f.run(`check ${id} add sum | 1 | 1 | 0 | points`),/Maximum 20/);
  assert.deepEqual(JSON.parse(await reconstruct(f,id)),JSON.parse(await f.run(`export ${id}`)));
  const s=await state(f);for(let i=1;i<12;i++)s.records.push({...structuredClone(s.records[0]),id:`audit-${randomUUID()}`});
  const raw=JSON.stringify(s);assert.ok(Buffer.byteLength(raw)>49152&&Buffer.byteLength(raw)<512000);f.backend.data.set(f.key("state"),raw);
  assert.match(await f.run(`correct ${id} ${s.records[0].checks[0].id} | 2`),/quota/);
  for(const r of s.records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
});
test("help is static and deferred read cancellation performs no late write",async()=>{
  assert.equal(feature.help,metadata.help);assert.ok(metadata.help.length<=3500);
  assert.equal(await feature.execute("help",{} as never),metadata.help);
  let armed=false;const gate=deferred<void>(),seen=deferred<void>();
  const backend=createMemoryAgentBackend({async beforeGet(){if(armed){seen.resolve();await gate.promise;}}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f);
  const before=backend.calls.writes,c=new AbortController();armed=true;const pending=f.run(`edit ${id} | title | Late`,{signal:c.signal});await seen.promise;c.abort();await assert.rejects(pending, /abort/i);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(backend.calls.writes,before);
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
