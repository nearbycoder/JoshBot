import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/process-friction.js";
import metadata from "../lib/agent-features/process-friction.metadata.js";
const CREATE = "create Monthly report | 4", PREFIX = "process", TITLE = "Monthly report";
async function populate(f:ReturnType<typeof createAgentFeatureFixture>,id:string){for(let i=0;i<12;i++)assert.match(await f.run(`step ${id} add ${"界".repeat(45)}${i} | 20 | 60 | Me | ${"理由".repeat(45)}`),/Saved privately/);}
async function setupSteps(f:ReturnType<typeof createAgentFeatureFixture>,id:string){const a=uid(await f.run(`step ${id} add Gather figures | 20 | 60 | Me | Needed for accuracy`),"step"),b=uid(await f.run(`step ${id} add Review figures | 15 | 120 | Reviewer | Required approval`),"step");return [a,b];}
test("worked active/wait/handoff example, baseline-preserving scenario, explicit save and edit/removal",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),[a,b]=await setupSteps(f,id);let out=await f.run(`analyze ${id}`);assert.match(out,/35 active minutes \+ 180 waiting minutes = 215 sequential elapsed/);assert.match(out,/1 handoff/);assert.match(out,/140 active, 720 waiting, 860 elapsed/);assert.match(out,/66.67%/);
 const original=(await state(f)).records[0].steps,token=uid(await f.run(`what-if ${id} ${b} | wait | 30`),"preview");assert.deepEqual((await state(f)).records[0].steps,original);
 const sid=uid(await f.run(`save-scenario ${id} ${token} | Earlier review slot`),"scenario");assert.match(await f.run(`save-scenario ${id} ${token} | Again`),/Stale/);let s=(await state(f)).records[0].scenarios[0];assert.equal(s.before.wait,180000);assert.equal(s.after.wait,90000);assert.equal(s.after.active,35000);
 await f.run(`scenario-name ${id} ${sid} | Renamed`);await f.run(`scenario-clear-name ${id} ${sid} confirm`);await f.run(`scenario-name ${id} ${sid} | Again`);
 await f.run(`step ${id} edit ${a} | active | 10.25`);assert.match(await f.run(`analyze ${id}`),/STALE historical/);
 const p=uid(await f.run(`revise ${id} ${sid} ${a} | owner | Reviewer`),"preview");await f.run(`save-scenario ${id} ${p} | Shared review`);s=(await state(f)).records[0].scenarios[0];assert.equal(s.after.handoffs,0);assert.equal(s.before.active,25250);
 for(const [field,value]of [["label","Gather"],["wait","20"],["ownerLabel","Other"],["requiredReason","Accuracy"]])await f.run(`step ${id} edit ${a} | ${field} | ${value}`);
 await f.run(`move ${id} ${b} | 1`);await f.run(`step ${id} clear ${a} requiredReason confirm`);await f.run(`step ${id} clear ${a} ownerLabel confirm`);await f.run(`step ${id} clear ${a} label confirm`);
 await f.run(`edit ${id} | repetitions | 5`);await f.run(`edit ${id} | title | Updated`);await f.run(`scenario-remove ${id} ${sid} confirm`);await f.run(`step ${id} remove ${a} confirm`);assert.equal((await state(f)).records[0].steps.length,1);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("required removal needs replacement rationale, exact milli-minute arithmetic and historical currentness",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),[a,b]=await setupSteps(f,id),before=f.backend.data.get(f.key('state'));
 assert.match(await f.run(`what-if ${id} ${b} | remove | `),/replacement rationale/);assert.equal(f.backend.data.get(f.key('state')),before);
 let p=uid(await f.run(`what-if ${id} ${b} | remove | Me performs required approval before publishing`),"preview");let sid=uid(await f.run(`save-scenario ${id} ${p} | Paper removal`),"scenario");let s=(await state(f)).records[0].scenarios[0];assert.equal(s.after.active,20000);assert.equal(s.after.wait,60000);assert.equal(s.after.handoffs,0);assert.equal(s.after.stepCount,1);
 const baselineId=s.baselineId;await f.run(`step ${id} edit ${a} | wait | 0.001`);await f.run(`step ${id} edit ${a} | wait | 60`);assert.notEqual((await state(f)).records[0].baselineId,baselineId);assert.match(await f.run(`analyze ${id}`),/STALE historical/);
 p=uid(await f.run(`revise ${id} ${sid} ${b} | active | 0.001`),"preview");await f.run(`save-scenario ${id} ${p} | Precise`);assert.equal((await state(f)).records[0].scenarios[0].after.active,20001);
});
test("three saved slots plus replacement preview fit after admission saturation, names and escaping included",async()=>{
 const f=createAgentFeatureFixture(feature),ids=[];for(let i=0;i<4;i++)ids.push(await setup(f));let rejected=false;const pairs:string[][]=[];
 for(const id of ids){for(let i=0;i<24;i++){const result=await f.run(`step ${id} add ${esc('\\'.repeat(160))} | 1000000 | 1000000 | ${esc('\\'.repeat(128))} | ${esc('\\'.repeat(320))}`);if(!result.startsWith('Saved privately')){assert.match(result,/quota/);rejected=true;break;}pairs.push([id,uid(result,'step')]);}}
 assert.ok(rejected);for(const id of new Set(pairs.map(p=>p[0]))){const sid=pairs.find(p=>p[0]===id)![1],savedIds=[];for(let i=0;i<3;i++){const p=uid(await f.run(`what-if ${id} ${sid} | remove | ${esc('\\'.repeat(320))}`),'preview');savedIds.push(uid(await f.run(`save-scenario ${id} ${p} | ${esc('\\'.repeat(160))}`),'scenario'));}
 assert.match(await f.run(`what-if ${id} ${sid} | wait | 0`),/Maximum 3/);const p=uid(await f.run(`revise ${id} ${savedIds[0]} ${sid} | wait | 0`),'preview');assert.match(await f.run(`save-scenario ${id} ${p} | ${esc('\\'.repeat(160))}`),/Saved privately/);
 assert.deepEqual(JSON.parse(await reconstruct(f,id)),JSON.parse(await f.run(`export ${id}`)));}
 assert.ok(Buffer.byteLength(JSON.stringify(await state(f)))<=49152);
});
test("count maxima, malformed current/historic counts and enums, and legacy aggregate erasure",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f);for(let i=0;i<24;i++)assert.match(await f.run(`step ${id} add S${i} | 0 | 0 | Me | none`),/Saved privately/);assert.match(await f.run(`step ${id} add Overflow | 0 | 0 | Me | none`),/Maximum 24/);
 const g=createAgentFeatureFixture(feature);for(let i=0;i<12;i++)await setup(g);assert.match(await g.run(CREATE),/Maximum 12/);
 const h=createAgentFeatureFixture(feature),hid=await setup(h);await populate(h,hid);let r=(await state(h)).records[0];const token=uid(await h.run(`what-if ${hid} ${r.steps[0].id} | wait | 30`),'preview');await h.run(`save-scenario ${hid} ${token} | Old`);await h.run(`step ${hid} edit ${r.steps[0].id} | label | Updated`);const raw=h.backend.data.get(h.key('state'))!;
 for(const change of [(r:any)=>r.scenarios[0].baselineRevision=r.revision+1,(r:any)=>r.scenarios[0].after.handoffs=1,(r:any)=>r.scenarios[0].before.handoffs=30,(r:any)=>r.scenarios[0].after.wait=1,(r:any)=>r.scenarios[0].assumption.field=['wait'],(r:any)=>r.steps[0].active='0']){const s=JSON.parse(raw);change(s.records[0]);const bad=JSON.stringify(s);h.backend.data.set(h.key('state'),bad);assert.match(await h.run(`delete ${hid} confirm`),/preserved/);assert.equal(h.backend.data.get(h.key('state')),bad);}
 const s=JSON.parse(raw);for(let i=1;i<12;i++)s.records.push({...structuredClone(s.records[0]),id:`process-${randomUUID()}`});const legacy=JSON.stringify(s);assert.ok(Buffer.byteLength(legacy)>49152);h.backend.data.set(h.key('state'),legacy);assert.match(await h.run(`edit ${hid} | title | Ordinary`),/quota/);for(const x of s.records)assert.match(await h.run(`delete ${x.id} confirm`),/Deleted privately/);
});
test("stale preview replacement and saved-scenario CAS intent reject concurrent child changes",async()=>{
 let armed=false,key='';const backend=createMemoryAgentBackend({beforeCompareSet(k){if(!armed||k!==key)return;armed=false;const s=JSON.parse(backend.data.get(k)!);s.records[0].steps[0].label='Concurrent';s.records[0].baselineId=`base-${randomUUID()}`;s.records[0].pending=null;backend.data.set(k,JSON.stringify(s));}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f),[a,b]=await setupSteps(f,id);key=f.key('state');
 const p=uid(await f.run(`what-if ${id} ${a} | wait | 1`),'preview'),q=uid(await f.run(`what-if ${id} ${b} | wait | 2`),'preview');assert.match(await f.run(`save-scenario ${id} ${p} | Old`),/Stale/);armed=true;assert.match(await f.run(`save-scenario ${id} ${q} | New`),/changed/);assert.equal((await state(f)).records[0].scenarios.length,0);
 const fresh=uid(await f.run(`what-if ${id} ${a} | wait | 1`),'preview');await f.run(`discard ${id} confirm`);assert.match(await f.run(`save-scenario ${id} ${fresh} | Gone`),/Stale/);
});
test("static help, numeric input boundaries and deferred cancellation keep state untouched",async()=>{
 assert.equal(feature.help,metadata.help);assert.equal(await feature.execute('help',{} as never),metadata.help);assert.ok(metadata.help.length<=3500);
 let armed=false;const gate=deferred<void>(),seen=deferred<void>(),backend=createMemoryAgentBackend({async beforeGet(){if(armed){seen.resolve();await gate.promise;}}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f),[a]=await setupSteps(f,id),raw=backend.data.get(f.key('state'));
 for(const v of ['-1','1e3','0.0001','1000000.001']){await f.run(`step ${id} edit ${a} | wait | ${v}`);assert.equal(backend.data.get(f.key('state')),raw);}
 const c=new AbortController(),before=backend.calls.writes;armed=true;const p=f.run(`what-if ${id} ${a} | wait | 0`,{signal:c.signal});await seen.promise;c.abort();await assert.rejects(p,/abort/i);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(backend.calls.writes,before);
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
  assert.match(await f.run(`what-if ${id} ${s.records[0].steps[0].id} | wait | 0`), /Revision limit/);
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
