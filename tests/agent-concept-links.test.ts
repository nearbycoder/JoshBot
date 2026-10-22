import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import feature from "../lib/agent-features/concept-links.js";
import memory from "../lib/agent-features/memory-review.js";
import { createAgentFeatureServices, createProductionContextAdapters } from "../lib/agent-features/services.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const prefix = "/nobo-help agent concept-links ", now = new Date("2026-10-22T15:00:00Z");
const state = async (f:ReturnType<typeof createAgentFeatureFixture>) => (await f.store().read<any>("state"))!;
async function walk(f:ReturnType<typeof createAgentFeatureFixture>, cmd:string) { let all="",first="",count=0; while(cmd) { const reply=await f.run(cmd); assert.ok(reply.length<=3500); first ||= reply; all+=reply; const next=reply.match(/Next: (\/nobo-help agent concept-links [^\n]+)/)?.[1]; cmd=next?.includes(" rev ")?next.slice(prefix.length):""; assert.ok(++count<100); } return {all,first,count}; }
async function setup(f:ReturnType<typeof createAgentFeatureFixture>) { await f.run("create Reliable systems"); const r=(await state(f)).records[0]; for(const t of ["Idempotency","Retries","Timeouts","Isolated"]) await f.run(`concept ${r.id} add ${t} | ${t} annotation`); return (await state(f)).records[0]; }
function production() { const backend=createMemoryAgentBackend(); const owner={teamId:"TCONCEPT",userId:"UCONCEPT"}; const services=createAgentFeatureServices(backend,owner,new AbortController().signal,{now,timezone:"America/Chicago",featureId:feature.id},createProductionContextAdapters({redis:async()=>{throw Error("Unexpected index read");}})); const f=createAgentFeatureFixture(feature,{backend,owner,services:{readContext:services.readContext}}); const key=`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:notes`; const notes=(n:number,body="Idempotency excerpt")=>({entries:Array.from({length:n},(_,i)=>({id:`note${String(i).padStart(3,"0")}`,title:`Note ${i}`,body,createdAt:now.toISOString(),updatedAt:now.toISOString(),data:{}}))}); return {f,backend,key,notes,owner}; }
test("typed directed BFS chooses stable shortest paths and handles cycles/shared/disconnected nodes", async()=>{
 const f=createAgentFeatureFixture(feature),r=await setup(f),[a,b,c,d]=r.nodes;
 await f.run(`connect ${r.id} ${b.id} | depends-on | ${a.id} | Avoid duplicate effects`);
 await f.run(`connect ${r.id} ${a.id} | supports | ${c.id} | First path`);
 await f.run(`connect ${r.id} ${b.id} | contrasts | ${c.id} | Direct wins`);
 await f.run(`connect ${r.id} ${c.id} | example | ${b.id} | Cycle`);
 assert.match(await f.run(`path ${r.id} ${b.id} | ${c.id}`),/1 hop\(s\)[\s\S]*Direct wins/);
 assert.match(await f.run(`path ${r.id} ${a.id} | ${d.id}`),/No directed path/);
 assert.match(await f.run(`path ${r.id} ${a.id} | ${a.id}`),/0 hop/);
 const e=(await state(f)).records[0].edges[0];
 await f.run(`connect-edit ${r.id} ${e.id} | ${b.id} | supports | ${a.id} | Changed label`);
 await f.run(`concept ${r.id} edit ${a.id} | Idempotent | Changed annotation`);
 await f.run(`edit ${r.id} | Updated graph`);
 assert.match(await f.run(`path ${r.id} ${b.id} | ${a.id}`),/Changed label/);
 await f.run(`remove ${r.id} concept ${a.id} confirm`); assert.equal((await state(f)).records[0].edges.length,2);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("real production adapters expose all 200 items, source pages bind source and map revisions",async()=>{
 const {f,backend,key,notes,owner}=production(),r=await setup(f); backend.data.set(key,JSON.stringify(notes(100)));
 const mf=createAgentFeatureFixture(memory,{backend,owner,now}); await mf.run("capture me | subject | A memory fact | User note"); const ms=(await mf.store().read<any>("cards"))!; await mf.run(`confirm ${ms.cards[0].id} 1`); const template=(await mf.store().read<any>("cards"))!.cards[0];
 const cards=Array.from({length:100},(_,i)=>({...structuredClone(template),id:`mr_${randomUUID()}`,key:`key${i}`})); backend.data.set(mf.key("cards"),JSON.stringify({version:1,cards}));
 const result=await walk(f,`sources ${r.id}`); assert.match(result.all,/200 matches of 200/); assert.match(result.all,/toolbox:notes:note099/); assert.ok(result.count>10); assert.equal(f.calls.readContext,result.count);
 const next=result.first.match(/Next: (.+)/)![1].slice(prefix.length); backend.data.set(key,JSON.stringify(notes(100,"Changed"))); assert.match(await f.run(next),/Source snapshot changed/);
 backend.data.set(key,JSON.stringify(notes(100))); await f.run(`edit ${r.id} | New revision`); assert.match(await f.run(next),/Map changed/);
 const data=notes(1,"X".repeat(12010)); backend.data.set(key,JSON.stringify(data)); const detail=await walk(f,`sources ${r.id} --kind note --source toolbox:notes:note000`); assert.match(detail.all,/textTruncated[^\n]*true/); assert.ok(detail.count>3);
 backend.data.set(key,JSON.stringify(notes(101))); assert.match(await f.run(`sources ${r.id} --kind note`),/could not be read completely/);
});
test("explicit fresh selection retains exact metadata, rejects stale/revoked references and quotas",async()=>{
 const {f,backend,key,notes,owner}=production(),r=await setup(f); const entries=notes(11,"界".repeat(600)); entries.entries[0].data={}; backend.data.set(key,JSON.stringify(entries));
 for(let i=0;i<6;i++){ const sid=`toolbox:notes:note00${i}`,p=await f.run(`sources ${r.id} --kind note --source ${sid}`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1],rev=(await state(f)).records[0].revision; assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${sid} | ${fp} | ${rev} | ${"界".repeat(600)}`),/Saved selected/); }
 const sid="toolbox:notes:note006",p=await f.run(`sources ${r.id} --kind note --source ${sid}`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1],rev=(await state(f)).records[0].revision;
 const raw=backend.data.get(f.key("state")); assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${sid} | ${fp} | ${rev} | ${"界".repeat(600)}`),/12000/); assert.equal(backend.data.get(f.key("state")),raw);
 assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${sid} | ${fp} | ${rev} | fabricated`),/exact nonempty span/);
 entries.entries[6].body="changed";backend.data.set(key,JSON.stringify(entries)); assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${sid} | ${fp} | ${rev} | changed`),/stale/);
 const a=(await state(f)).records[0].attachments[0]; assert.equal(a.evidence.sources[0].id,"toolbox:notes:note000"); assert.equal(a.evidence.sources[0].metadata.source,"Personal toolbox / notes"); assert.equal(a.evidence.sources[0].metadata.textTruncated,false);
 (entries.entries[0] as any).teamId="TFOREIGN"; backend.data.set(key,JSON.stringify(entries)); assert.match((await walk(f,`sources ${r.id} --kind note`)).all,/absent\/unavailable/);
 entries.entries[1].body="new"; backend.data.set(key,JSON.stringify(entries)); assert.match((await walk(f,`sources ${r.id} --kind note`)).all,/STALE/);
 assert.match(await f.run(`show ${r.id}`,{owner:{teamId:owner.teamId,userId:"UOTHER"}}),/not found/);
 assert.match(await f.run(`show ${r.id}`,{owner:{teamId:"TOTHER",userId:owner.userId}}),/not found/);
 for(const a of (await state(f)).records[0].attachments) await f.run(`remove ${r.id} attachment ${a.id} confirm`); assert.equal((await state(f)).records[0].attachments.length,0);
});
test("all graph counts and long report continuations are complete and revision-bound",async()=>{
 const f=createAgentFeatureFixture(feature); await f.run("create Max graph"); const id=(await state(f)).records[0].id;
 for(let i=0;i<40;i++) assert.match(await f.run(`concept ${id} add N${i} | A${i}`),/Saved concept/);
 let r=(await state(f)).records[0];
 for(let i=0;i<80;i++) assert.match(await f.run(`connect ${id} ${r.nodes[i%40].id} | ${i<40?"supports":"contrasts"} | ${r.nodes[(i+1)%40].id} | E${i}`),/Saved edge/);
 assert.match((await walk(f,`show ${id}`)).all,/E79/); assert.match(await f.run(`concept ${id} add excess | x`),/Maximum 40/);
 for(let i=0;i<20;i++) await f.run(`remove ${id} edge ${(await state(f)).records[0].edges.at(-1).id} confirm`);
 r=(await state(f)).records[0]; for(let i=0;i<20;i++) await f.run(`connect-edit ${id} ${r.edges[i].id} | ${r.edges[i].from} | supports | ${r.edges[i].to} | ${"x".repeat(250)}`);
 const viewed=await walk(f,`path ${id} ${r.nodes[0].id} | ${r.nodes[20].id}`); assert.ok(viewed.count>1);
 const next=viewed.first.match(/Next: (.+)/)![1].slice(prefix.length); await f.run(`edit ${id} | Changed`); assert.match(await f.run(next),/Restart/);
 const exported=await f.run(`export ${id}`); assert.ok(Buffer.byteLength(exported)<=24576); assert.equal(JSON.parse(exported).record.nodes.length,40);
});
test("strict persisted enums/evidence preserve bytes, CAS conflict protects edits/removals/attachments",async()=>{
 let conflict:((s:any)=>void)|undefined; const backend=createMemoryAgentBackend({beforeCompareSet(key,previous){if(conflict&&key.endsWith(":state")){const s=JSON.parse(previous!);const fn=conflict;conflict=undefined;fn(s);backend.data.set(key,JSON.stringify(s));}}});
 const f=createAgentFeatureFixture(feature,{backend}),r=await setup(f); await f.run(`connect ${r.id} ${r.nodes[0].id} | supports | ${r.nodes[1].id} | label`); const good=await state(f);
 for(const bad of [["supports"],{toString:"supports"},"causes"]){const s=structuredClone(good);s.records[0].edges[0].type=bad;const raw=JSON.stringify(s);backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(backend.data.get(f.key("state")),raw);}
 for(const raw of ["null","{bad"]){backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(backend.data.get(f.key("state")),raw);} backend.data.set(f.key("state"),JSON.stringify(good));
 for(const cmd of [`concept ${r.id} edit ${r.nodes[0].id} | edited | a`,`remove ${r.id} concept ${r.nodes[0].id} confirm`,`delete ${r.id} confirm`]){conflict=s=>s.records[0].revision++;assert.match(await f.run(cmd),/changed/);}
 await f.run("create Other"); conflict=s=>{s.records[1].revision++;s.records[1].title="concurrent other";}; assert.match(await f.run(`edit ${r.id} | Changed safely`),/Updated map/); assert.equal((await state(f)).records[1].title,"concurrent other");
});
test("selection detects edits/deletion across awaited source read and every CAS retry",async()=>{
 let gate:ReturnType<typeof deferred<any[]>>|undefined; let conflict=false;const source={id:"toolbox:notes:n",kind:"note" as const,title:"Note",text:"exact",metadata:{source:"Personal toolbox / notes"}};
 const backend=createMemoryAgentBackend({beforeCompareSet(key,previous){if(conflict&&key.endsWith(":state")){conflict=false;const s=JSON.parse(previous!);s.records[0].revision++;backend.data.set(key,JSON.stringify(s));}}});
 const f=createAgentFeatureFixture(feature,{backend,services:{readContext:async()=>gate?gate.promise:[source]}}),r=await setup(f);
 const p=await f.run(`sources ${r.id}`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1]; let rev=(await state(f)).records[0].revision;
 conflict=true; assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${source.id} | ${fp} | ${rev} | exact`),/changed/);
 rev=(await state(f)).records[0].revision;gate=deferred(); const pending=f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${source.id} | ${fp} | ${rev} | exact`); await new Promise(resolve=>setImmediate(resolve));await f.run(`delete ${r.id} confirm`);gate.resolve([source]);assert.match(await pending,/not found/); assert.equal((await state(f)).records.length,0);
});

test("ten selected sources, replacement/removal, and production memory revocation preserve exact provenance",async()=>{
 const {f,backend,key,notes,owner}=production(),r=await setup(f);backend.data.set(key,JSON.stringify(notes(11)));
 for(let i=0;i<10;i++){const sid=`toolbox:notes:note${String(i).padStart(3,"0")}`,p=await f.run(`sources ${r.id} --kind note --source ${sid}`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1],rev=(await state(f)).records[0].revision;assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | ${sid} | ${fp} | ${rev} | Idempotency excerpt`),/Saved selected/);}
 let p=await f.run(`sources ${r.id} --kind note --source toolbox:notes:note010`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1],rev=(await state(f)).records[0].revision;
 assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | note | toolbox:notes:note010 | ${fp} | ${rev} | Idempotency excerpt`),/Maximum ten/);
 let a=(await state(f)).records[0].attachments[0];assert.match(await f.run(`attach-edit ${r.id} ${a.id} | ${r.nodes[1].id} | note | toolbox:notes:note010 | ${fp} | ${rev} | Idempotency excerpt`),/Saved selected/);
 for(const a of(await state(f)).records[0].attachments)await f.run(`remove ${r.id} attachment ${a.id} confirm`);
 const mf=createAgentFeatureFixture(memory,{backend,owner,now});await mf.run("capture me | key | Exact memory fact | My source note");let ms=(await mf.store().read<any>("cards"))!;const mid=ms.cards[0].id;await mf.run(`confirm ${mid} 1`);
 p=await f.run(`sources ${r.id} --kind memory --source memory-review:${mid}`);fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];rev=(await state(f)).records[0].revision;
 assert.match(await f.run(`attach ${r.id} ${r.nodes[0].id} | memory | memory-review:${mid} | ${fp} | ${rev} | Exact memory fact`),/Saved selected/);
 const saved=(await state(f)).records[0].attachments[0].evidence.sources[0];assert.equal(saved.metadata.cardId,mid);assert.equal(saved.metadata.source,"My source note");assert.deepEqual(saved.metadata.origin,{kind:"user"});
 await mf.run(`correct ${mid} 2 | Corrected fact | Corrected source`);assert.match((await walk(f,`sources ${r.id} --kind memory`)).all,/absent\/unavailable/);assert.match((await walk(f,`show ${r.id}`)).all,/Exact memory fact/);
});
test("mislabeled foreign adapter provenance is refused before selection",async()=>{
 const f=createAgentFeatureFixture(feature,{services:{readContext:async()=>[{id:"artifact:foreign",kind:"note",title:"Fake",text:"text",metadata:{source:"Personal toolbox / notes"}}]}}),r=await setup(f);
 assert.match(await f.run(`sources ${r.id} --kind note`),/provenance/);assert.equal((await state(f)).records[0].attachments.length,0);
});
