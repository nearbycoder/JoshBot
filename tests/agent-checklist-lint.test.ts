import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/checklist-lint.js";
import metadata from "../lib/agent-features/checklist-lint.metadata.js";
const CREATE = "create Publish a guide | Applies to the public documentation site", PREFIX = "review", TITLE = "Publish a guide";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {for(let i=0;i<8;i++)assert.match(await f.run(`step ${id} add ${"界".repeat(100)}${i} | ${"v".repeat(200)} | ${"s".repeat(100)}`),/Saved privately/);}
test("worked lint example gives exact spans and order guidance; move and all edits repair it",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),a=uid(await f.run(`step ${id} add Check the page | none | Stop if links fail`),"step"),b=uid(await f.run(`step ${id} add Open each example link | Every link resolves to the expected page | none`),"step");
 await f.run(`requires ${id} ${a} | ${b}`);let out=await f.run(`audit ${id}`);assert.match(out,/vague-action · action\[0,5\): "Check"/);assert.match(out,/missing-verification/);assert.match(out,/prerequisite-after-dependent/);
 await f.run(`move ${id} ${b} | 1`);out=await f.run(`audit ${id}`);assert.doesNotMatch(out,/· prerequisite-after-dependent/);
 await f.run(`step ${id} edit ${a} | action | Publish the page`);await f.run(`step ${id} edit ${a} | verification | Page returns HTTP 200`);await f.run(`step ${id} edit ${a} | stopCondition | Stop if build fails`);
 assert.match(await f.run(`audit ${id}`),/0 rule finding/);
 await f.run(`edit ${id} | applicability | Public site only`);await f.run(`edit ${id} | title | Edited`);
 await f.run(`step ${id} clear ${a} stopCondition confirm`);await f.run(`requires-remove ${id} ${a} ${b} confirm`);
 await f.run(`requires ${id} ${a} | ${b}`);await f.run(`step ${id} remove ${b} confirm`);assert.deepEqual((await state(f)).records[0].steps[0].prerequisites,[]);
 await f.run(`clear ${id} applicability confirm`);assert.match(await f.run(`audit ${id}`),/Applicability: missing/);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("exact normalization, finite word list and bounded cyclic graph oracle",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),ids=[];
 for(const action of ["Open café"," OPEN   CAFÉ ","Recheck handles reviews","Ensure links"]){ids.push(uid(await f.run(`step ${id} add ${action} | Verified | none`),"step"));}
 let out=await f.run(`audit ${id}`);assert.equal(out.match(/· duplicate-action/g)?.length,1);assert.equal(out.match(/· vague-action/g)?.length,1);assert.match(out,/action\[0,6\): "Ensure"/);
 await f.run(`requires ${id} ${ids[0]} | ${ids[1]}`);await f.run(`requires ${id} ${ids[1]} | ${ids[2]}`);await f.run(`requires ${id} ${ids[2]} | ${ids[0]}`);
 out=await f.run(`audit ${id}`);assert.equal(out.match(/· dependency-cycle/g)?.length,3);
 await f.run(`requires-remove ${id} ${ids[2]} ${ids[0]} confirm`);assert.doesNotMatch(await f.run(`audit ${id}`),/· dependency-cycle/);
 const before=f.backend.data.get(f.key("state"));await f.run(`requires ${id} ${ids[0]} | step-${randomUUID()}`);assert.equal(f.backend.data.get(f.key("state")),before);
});
test("maximum step/reference counts, final order and complete emitted retrieval",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),ids=[];
 for(let i=0;i<30;i++)ids.push(uid(await f.run(`step ${id} add Open ${i} | Result ${i} | none`),"step"));
 assert.match(await f.run(`step ${id} add overflow | none | none`),/Maximum 30/);
 for(let i=0;i<30;i++)for(let j=1;j<=2;j++)assert.match(await f.run(`requires ${id} ${ids[i]} | ${ids[(i+j)%30]}`),/Saved privately/);
 assert.match(await f.run(`requires ${id} ${ids[0]} | ${ids[3]}`),/Maximum 60/);
 await f.run(`move ${id} ${ids[29]} | 1`);assert.equal((await state(f)).records[0].steps[0].id,ids[29]);
 assert.deepEqual(JSON.parse(await reconstruct(f,id)),JSON.parse(await f.run(`export ${id}`)));
});
test("legacy aggregate deletion, schema rejection and admission remain strict",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f);await populate(f,id);const s=await state(f);
 for(let i=1;i<12;i++)s.records.push({...structuredClone(s.records[0]),id:`review-${randomUUID()}`});const raw=JSON.stringify(s);assert.ok(Buffer.byteLength(raw)>49152);f.backend.data.set(f.key("state"),raw);
 assert.match(await f.run(`step ${id} clear ${s.records[0].steps[0].id} verification confirm`),/quota/);assert.equal(f.backend.data.get(f.key("state")),raw);
 for(const r of s.records)assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
 for(const change of [(r:any)=>r.steps[0].prerequisites.push(`step-${randomUUID()}`),(r:any)=>r.steps[0].done=true,(r:any)=>r.steps[0].action=["Open"]]){const record=structuredClone(s.records[0]);change(record);const bad=JSON.stringify({version:1,records:[record]});f.backend.data.set(f.key("state"),bad);assert.match(await f.run(`delete ${id} confirm`),/preserved/);assert.equal(f.backend.data.get(f.key("state")),bad);}
});
test("static help and no late mutation after cancelled deferred get",async()=>{
 assert.equal(feature.help,metadata.help);assert.equal(await feature.execute("help",{} as never),metadata.help);assert.ok(metadata.help.length<=3500);
 let armed=false;const gate=deferred<void>(),seen=deferred<void>(),backend=createMemoryAgentBackend({async beforeGet(){if(armed){seen.resolve();await gate.promise;}}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f),c=new AbortController(),before=backend.calls.writes;
 armed=true;const p=f.run(`edit ${id} | title | Late`,{signal:c.signal});await seen.promise;c.abort();await assert.rejects(p,/abort/i);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(backend.calls.writes,before);
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
  for (const corrupt of [JSON.stringify({ version: 1, records: [{ ...JSON.parse(original).records[0], id: `unexpectedprefix-${randomUUID()}` }] }), 'null', '{broken', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ ...JSON.parse(original).records[0], revision: "1" }] })]) {
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
  assert.match(await f.run(`requires ${id} ${s.records[0].steps[0].id} | ${s.records[0].steps[1].id}`), /Revision limit/);
  const other = await setup(f); assert.match(await f.run(`edit ${other} | title | Unrelated record remains editable`), /Saved privately/);
  const before = await f.run(`show ${id}`), continuation = /Next: (\/nobo-help agent [^\n]+)/.exec(before)?.[1]; assert.ok(continuation, before);
  assert.match(await f.run(`edit ${id} | title | Refuse`), /Revision limit/);
  const reply = await f.run(`clear ${id} title confirm`); assert.match(reply, /Saved privately/);
  assert.equal((await state(f)).records[0].revision, 999999999);
  assert.match(await f.run(continuation.slice(route.length)), /stale continuation/i);
  assert.match(await f.run(`delete ${id} confirm`), /Deleted privately/);
  assert.equal((await state(f)).records.length, 1);
  assert.match(await f.run(`delete ${other} confirm`), /Deleted privately/);
  assert.equal((await state(f)).records.length, 0);
});
