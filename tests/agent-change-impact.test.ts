import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/change-impact.js";
import metadata from "../lib/agent-features/change-impact.metadata.js";
const CREATE = "create Launch dependencies", PREFIX = "map", TITLE = "Launch dependencies";
async function populate(f:ReturnType<typeof createAgentFeatureFixture>,id:string){for(let i=0;i<20;i++)assert.match(await f.run(`item ${id} add ${"x".repeat(140)}${i} | document | ${"o".repeat(90)}`),/Saved privately/);}
async function addItem(f:ReturnType<typeof createAgentFeatureFixture>,id:string,label:string){return uid(await f.run(`item ${id} add ${label} | document | Me`),'item');}
async function body(f:ReturnType<typeof createAgentFeatureFixture>,command:string):Promise<string>{let out='';for(let i=0;i<100;i++){const reply=await f.run(command);assert.ok(reply.length<=3500);const h=/^.*\nPage \d+\/\d+\n/.exec(reply);assert.ok(h,reply);const next=/\nNext: (\/nobo-help agent [^\n]+)$/.exec(reply);out+=reply.slice(h[0].length,next?.index??reply.length);if(!next)return out;command=next[1].slice(route.length);}assert.fail('Pages did not terminate');}
test("catalog launch dependency and reported resolution; all input/disposition lifecycle edits",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),a=uid(await f.run(`item ${id} add Launch date | assumption | Me`),'item'),b=await addItem(f,id,'Announcement draft'),eid=uid(await f.run(`depends ${id} ${b} | ${a} | Draft contains the launch date`),'edge'),cid=uid(await f.run(`change ${id} ${a} | Launch moved by one week`),'change');
 let out=await f.run(`impact ${id} ${cid}`);assert.match(out,/1 edges/);assert.ok(out.includes(eid));assert.match(await f.run(`close ${id} ${cid}`),/Every affected item/);assert.match(await f.run(`resolve ${id} ${cid} ${a} | reviewed | Source`),/excluded/);
 await f.run(`resolve ${id} ${cid} ${b} | reviewed | Updated the date in my draft`);await f.run(`close ${id} ${cid}`);assert.equal((await state(f)).records[0].changes[0].status,'closed');
 await f.run(`reopen ${id} ${cid}`);await f.run(`resolve ${id} ${cid} ${b} | not-affected | Draft has no date now`);await f.run(`resolve-remove ${id} ${cid} ${b} confirm`);assert.equal((await state(f)).records[0].changes[0].dispositions.length,0);
 await f.run(`item ${id} edit ${b} | label | Launch announcement`);await f.run(`item ${id} edit ${b} | type | commitment`);await f.run(`item ${id} edit ${b} | ownerLabel | Writer`);assert.match(await f.run(`close ${id} ${cid}`),/Graph changed/);
 await f.run(`refresh ${id} ${cid} confirm`);await f.run(`resolve ${id} ${cid} ${b} | reviewed | Updated`);await f.run(`close ${id} ${cid}`);await f.run(`edge-edit ${id} ${eid} | ${b} | ${a} | Revised dependency reason`);assert.match(await f.run(`impact ${id} ${cid}`),/STALE: historical status closed/);
 await f.run(`change-edit ${id} ${cid} confirm | ${a} | Launch moved two weeks`);assert.equal((await state(f)).records[0].changes[0].dispositions.length,0);
 await f.run(`item ${id} clear ${b} label confirm`);await f.run(`item ${id} clear ${b} ownerLabel confirm`);await f.run(`edge-remove ${id} ${eid} confirm`);await f.run(`edit ${id} | title | Changed map`);
 await f.run(`change-remove ${id} ${cid} confirm`);await f.run(`item ${id} remove ${a} confirm`);assert.equal((await state(f)).records[0].changes.length,0);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("independent distance oracle, cycles, deterministic ties and real saved shortest path provenance",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),nodes=[];for(const label of ['A','B','C','D','E','F','unrelated'])nodes.push(await addItem(f,id,label));
 const pairs=[[1,0],[2,0],[3,1],[3,2],[0,3],[4,3],[4,1],[5,4]];for(const [d,p]of pairs)await f.run(`depends ${id} ${nodes[d]} | ${nodes[p]} | Reason ${d}-${p}`);
 const cid=uid(await f.run(`change ${id} ${nodes[0]} | Changed`),'change'),r=(await state(f)).records[0],c=r.changes[0];
 // Repeated relaxation is independent of the implementation's BFS and adjacency order.
 const distances=Array(7).fill(Infinity);distances[0]=0;for(let k=0;k<7;k++)for(const [d,p]of pairs)distances[d]=Math.min(distances[d],distances[p]+1);
 assert.equal(c.affected.length,5);assert.ok(!c.affected.includes(nodes[0]));assert.ok(!c.affected.includes(nodes[6]));assert.equal(new Set(c.affected).size,c.affected.length);
 const report=await body(f,`impact ${id} ${cid}`);
 for(let i=1;i<=5;i++){assert.ok(report.includes(`path ${id} ${cid} ${nodes[i]}`));const detail=await body(f,`path ${id} ${cid} ${nodes[i]}`),steps=[...detail.matchAll(/(item-[0-9a-f-]{36}) depends-on (item-[0-9a-f-]{36}) via (edge-[0-9a-f-]{36}):/g)];assert.equal(steps.length,distances[i]);assert.equal(steps[0][1],nodes[i]);assert.equal(steps.at(-1)![2],nodes[0]);for(const [n,m]of steps.entries()){const edge=r.edges.find((e:any)=>e.id===m[3]);assert.equal(edge.dependent,m[1]);assert.equal(edge.prerequisite,m[2]);if(n)assert.equal(steps[n-1][2],m[1]);}}
 const dpath=await body(f,`path ${id} ${cid} ${nodes[3]}`),firstPrerequisite=nodes[1]<nodes[2]?nodes[1]:nodes[2];assert.ok(dpath.includes(`${nodes[3]} depends-on ${firstPrerequisite}`));
});
test("all count maxima, emitted final pages, five source-only changes and full export",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),nodes=[];for(let i=0;i<40;i++)nodes.push(await addItem(f,id,`N${i}`));assert.match(await f.run(`item ${id} add Overflow | other | Me`),/Maximum 40/);
 let count=0;for(let i=1;i<40&&count<80;i++)for(let j=1;j<40&&count<80;j++){assert.match(await f.run(`depends ${id} ${nodes[i]} | ${nodes[j]} | Link`),/Saved privately/);count++;}
 assert.match(await f.run(`depends ${id} ${nodes[39]} | ${nodes[38]} | Overflow`),/Maximum 80/);
 for(let i=0;i<5;i++){const cid=uid(await f.run(`change ${id} ${nodes[0]} | Change ${i}`),'change');assert.match(await f.run(`close ${id} ${cid}`),/Saved privately/);}assert.match(await f.run(`change ${id} ${nodes[0]} | Sixth`),/Maximum 5/);
 assert.deepEqual(JSON.parse(await reconstruct(f,id)),JSON.parse(await f.run(`export ${id}`)));
 const g=createAgentFeatureFixture(feature);for(let i=0;i<8;i++)await setup(g);assert.match(await g.run(CREATE),/Maximum 8/);
});
test("every admitted affected queue finishes at escaping saturation and remains fully retrievable",async()=>{
 const f=createAgentFeatureFixture(feature),ids=[];for(let i=0;i<3;i++)ids.push(await setup(f));const changes:string[][]=[];
 for(const id of ids){const nodes=[];for(let i=0;i<10;i++)nodes.push(await addItem(f,id,`N${i}`));for(let i=1;i<10;i++)await f.run(`depends ${id} ${nodes[i]} | ${nodes[i-1]} | ${esc('\\'.repeat(160))}`);changes.push([id,uid(await f.run(`change ${id} ${nodes[0]} | ${esc('\\'.repeat(400))}`),'change')]);}
 let rejected=false;for(const id of ids)for(let i=0;i<30;i++){const reply=await f.run(`item ${id} add ${esc('\\'.repeat(160))} | commitment | ${esc('\\'.repeat(96))}`);if(!reply.startsWith('Saved privately')){assert.match(reply,/quota|Maximum/);rejected=true;break;}}
 assert.ok(rejected);
 for(const [id,cid]of changes){assert.match(await f.run(`refresh ${id} ${cid} confirm`),/Saved privately/);const c=(await state(f)).records.find((r:any)=>r.id===id).changes[0];for(const iid of c.affected)assert.match(await f.run(`resolve ${id} ${cid} ${iid} | not-affected | ${esc('\\'.repeat(96))}`),/Saved privately/);assert.match(await f.run(`close ${id} ${cid}`),/Saved privately/);assert.deepEqual(JSON.parse(await reconstruct(f,id)),JSON.parse(await f.run(`export ${id}`)));}
 assert.ok(Buffer.byteLength(JSON.stringify(await state(f)))<=49152);
});
test("CAS resolve/close refuse same-target child edits and graph ABA cannot revive certification",async()=>{
 for(const operation of ['resolve','close']){let armed=false,key='';const backend=createMemoryAgentBackend({beforeCompareSet(k){if(!armed||k!==key)return;armed=false;const s=JSON.parse(backend.data.get(k)!);s.records[0].items[0].label='Concurrent';s.records[0].graphId=`graph-${randomUUID()}`;backend.data.set(k,JSON.stringify(s));}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f),a=await addItem(f,id,'A'),b=await addItem(f,id,'B');key=f.key('state');await f.run(`depends ${id} ${b} | ${a} | Original`);const cid=uid(await f.run(`change ${id} ${a} | Changed`),'change');if(operation==='close')await f.run(`resolve ${id} ${cid} ${b} | reviewed | Done`);armed=true;
 assert.match(await f.run(operation==='close'?`close ${id} ${cid}`:`resolve ${id} ${cid} ${b} | reviewed | Done`),/changed/i);assert.equal((await state(f)).records[0].changes[0].status,'open');await f.run(`item ${id} edit ${a} | label | A`);assert.match(await f.run(`close ${id} ${cid}`),/Graph changed/);assert.match(await f.run(`refresh ${id} ${cid} confirm`),/Saved privately/);assert.equal((await state(f)).records[0].changes[0].dispositions.length,0);}
});
test("strict persisted historical enums/closed queues and valid legacy aggregate erasure",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),a=await addItem(f,id,'A'),b=await addItem(f,id,'B');await f.run(`depends ${id} ${b} | ${a} | Dependency`);const cid=uid(await f.run(`change ${id} ${a} | Changed`),'change');await f.run(`resolve ${id} ${cid} ${b} | reviewed | Done`);await f.run(`close ${id} ${cid}`);await f.run(`item ${id} edit ${b} | label | Historical`);const raw=f.backend.data.get(f.key('state'))!;
 for(const mutate of [(r:any)=>r.changes[0].dispositions[0].state=['reviewed'],(r:any)=>r.changes[0].dispositions=[],(r:any)=>r.items[0].type=['document'],(r:any)=>r.edges[0].prerequisite=`item-${randomUUID()}`,(r:any)=>r.changes[0].sourceSnapshot.extra=true]){const s=JSON.parse(raw);mutate(s.records[0]);const bad=JSON.stringify(s);f.backend.data.set(f.key('state'),bad);assert.match(await f.run(`delete ${id} confirm`),/preserved/);assert.equal(f.backend.data.get(f.key('state')),bad);}
 const g=createAgentFeatureFixture(feature),gid=await setup(g);await populate(g,gid);const s=await state(g);for(let i=1;i<8;i++)s.records.push({...structuredClone(s.records[0]),id:`map-${randomUUID()}`});const legacy=JSON.stringify(s);assert.ok(Buffer.byteLength(legacy)>49152);g.backend.data.set(g.key('state'),legacy);assert.match(await g.run(`edit ${gid} | title | No`),/quota/);for(const r of s.records)assert.match(await g.run(`delete ${r.id} confirm`),/Deleted privately/);
});
test("source item deletion cleans owned edges/changes, help is static and cancellation writes nothing late",async()=>{
 assert.equal(feature.help,metadata.help);assert.equal(await feature.execute('help',{} as never),metadata.help);assert.ok(metadata.help.length<=3500);
 let armed=false;const gate=deferred<void>(),seen=deferred<void>(),backend=createMemoryAgentBackend({async beforeGet(){if(armed){seen.resolve();await gate.promise;}}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f),a=await addItem(f,id,'A'),b=await addItem(f,id,'B');await f.run(`depends ${id} ${b} | ${a} | Dependency`);await f.run(`change ${id} ${a} | Changed`);await f.run(`item ${id} remove ${a} confirm`);let r=(await state(f)).records[0];assert.equal(r.edges.length,0);assert.equal(r.changes.length,0);
 const c=new AbortController(),before=backend.calls.writes;armed=true;const p=f.run(`change ${id} ${b} | Late`,{signal:c.signal});await seen.promise;c.abort();await assert.rejects(p,/abort/i);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(backend.calls.writes,before);
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
