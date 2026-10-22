import { AgentContextCapacityError } from "../lib/agent-features/budgets.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import feature from "../lib/agent-features/reading-path.js";
import { createAgentFeatureServices, createProductionContextAdapters } from "../lib/agent-features/services.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const prefix="/nobo-help agent reading-path ",now=new Date("2026-10-22T15:00:00Z");
const state=async(f:ReturnType<typeof createAgentFeatureFixture>)=>(await f.store().read<any>("state"))!;
async function walk(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string){let all="",first="",count=0;while(cmd){const reply=await f.run(cmd);assert.ok(reply.length<=3500);first||=reply;all+=reply;const next=reply.match(/Next: (\/nobo-help agent reading-path [^\n]+)/)?.[1];cmd=next?.includes(" rev ")?next.slice(prefix.length):"";assert.ok(++count<120);}return{all,first,count};}
async function setup(f:ReturnType<typeof createAgentFeatureFixture>){await f.run("create Learn queue basics");const id=(await state(f)).records[0].id;await f.run(`item ${id} add Queue primer | 15 | Saved article`);await f.run(`item ${id} add Retry design | 20 | Engineering note`);return(await state(f)).records[0];}
function production(){const backend=createMemoryAgentBackend(),owner={teamId:"TREADING",userId:"UREADING"};const services=createAgentFeatureServices(backend,owner,new AbortController().signal,{now,timezone:"America/Chicago",featureId:feature.id},createProductionContextAdapters({redis:async()=>{throw Error("Unexpected index read");}}));const f=createAgentFeatureFixture(feature,{backend,owner,services:{readContext:services.readContext}}),key=`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:bookmarks`;const bookmarks=(n:number,note="Exact annotation")=>({entries:Array.from({length:n},(_,i)=>{const url=`https://example.test/${i}?b=2&a=%2F#section`;return{id:`bookmark${String(i).padStart(3,"0")}`,title:`Book ${i}`,body:`${url}\n${note}`,createdAt:now.toISOString(),updatedAt:now.toISOString(),tags:["reading"],data:{url,note,read:true}};})});return{f,backend,key,bookmarks,owner,services};}
test("catalog route uses prerequisites and whole minutes; completion is a user report",async()=>{
 const f=createAgentFeatureFixture(feature),r=await setup(f),[a,b]=r.items;await f.run(`requires ${r.id} ${b.id} | ${a.id}`);let out=await f.run(`route ${r.id} | 25`);assert.match(out,/15\/25 minutes/);assert.match(out,/Retry design: deferred/);assert.match(out,/20 additional whole minutes, 10 remain/);
 await f.run(`read ${r.id} ${a.id}`);assert.match(await f.run(`route ${r.id} | 25`),/20\/25 minutes/);assert.match(await f.run(`show ${r.id}`),/not mastery/);
 await f.run(`read ${r.id} ${b.id}`);await f.run(`item ${r.id} edit ${a.id} | Revised primer | 15 | New source`);assert.equal((await state(f)).records[0].items.filter((i:any)=>i.completed).length,0);
 await f.run(`read ${r.id} ${a.id}`);await f.run(`item ${r.id} edit ${a.id} | Revised primer | 18 | New source`);assert.equal((await state(f)).records[0].items[0].completed,true);
 const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`requires ${r.id} ${a.id} | ${b.id}`),/cycle rejected/);assert.match(await f.run(`requires ${r.id} ${a.id} | ${randomUUID()}`),/not found/);assert.equal(f.backend.data.get(f.key("state")),raw);
 await f.run(`unread ${r.id} ${a.id} confirm`);assert.match(await f.run(`route ${r.id} | 5`),/0\/5 minutes/);assert.match(await f.run(`route ${r.id} | 5`),/No partial reading/);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("shared closure counts once, stable topological ties, and edits/removals clear dependent reports",async()=>{
 const f=createAgentFeatureFixture(feature);await f.run("create Shared foundation");const id=(await state(f)).records[0].id;for(const [title,min]of[["A",10],["B",10],["C",10],["D",5]])await f.run(`item ${id} add ${title} | ${min} | source`);const r=(await state(f)).records[0],[a,b,c,d]=r.items;for(const [dep,pre]of[[b,a],[c,a],[d,b],[d,c]])await f.run(`requires ${id} ${dep.id} | ${pre.id}`);
 const out=await f.run(`route ${id} | 35`);assert.match(out,/35\/35 minutes/);assert.ok(out.indexOf(`${a.id} · A`) < out.indexOf(`${b.id} · B`));assert.ok(out.indexOf(`${b.id} · B`)<out.indexOf(`${c.id} · C`));assert.ok(out.indexOf(`${c.id} · C`)<out.indexOf(`${d.id} · D`));
 for(const i of r.items)await f.run(`read ${id} ${i.id}`);const edge=(await state(f)).records[0].edges[0];await f.run(`requires-edit ${id} ${edge.id} | ${b.id} | ${c.id}`);let saved=(await state(f)).records[0];assert.equal(saved.items.find((i:any)=>i.id===b.id).completed,false);assert.equal(saved.items.find((i:any)=>i.id===d.id).completed,false);
 await f.run(`remove ${id} edge ${edge.id} confirm`);await f.run(`remove ${id} item ${a.id} confirm`);saved=(await state(f)).records[0];assert.equal(saved.items.length,3);assert.equal(saved.edges.some((e:any)=>e.prerequisite===a.id),false);
});
test("actual production bookmark seam exposes 100 sources, full maximum URL and revision-bound pages",async()=>{
 const {f,backend,key,bookmarks}=production(),r=await setup(f),data=bookmarks(100);const start="https://example.test/",end="?a=%2F&b=2#z",url=start+"x".repeat(2048-start.length-end.length)+end;assert.equal(Buffer.byteLength(url),2048);data.entries[99].data.url=url;data.entries[99].body=url+"\nExact annotation";backend.data.set(key,JSON.stringify(data));
 const result=await walk(f,`bookmarks ${r.id}`);assert.match(result.all,/100 matches of 100/);assert.match(result.all,/toolbox:bookmarks:bookmark099/);assert.ok(result.all.includes(url));assert.equal(f.calls.readContext,result.count);
 const next=result.first.match(/Next: (.+)/)![1].slice(prefix.length);data.entries[0].data.note="Changed";backend.data.set(key,JSON.stringify(data));assert.match(await f.run(next),/snapshot changed/);
 const detail=await walk(f,`bookmarks ${r.id} --source toolbox:bookmarks:bookmark099`);assert.ok(detail.count>1);assert.ok(detail.all.includes(url));const fp=detail.first.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];const rev=(await state(f)).records[0].revision;
 assert.match(await f.run(`attach ${r.id} ${r.items[0].id} | toolbox:bookmarks:bookmark099 | ${fp} | ${rev}`),/Saved selected/);const saved=(await state(f)).records[0];assert.equal(saved.attachments[0].evidence.sources[0].sourceUrl,url);assert.equal(saved.attachments[0].evidence.sources[0].metadata.note,"Exact annotation");assert.equal(saved.items[0].completed,false);assert.equal(saved.attachments[0].evidence.sources[0].metadata.read,true);
 const shown=await walk(f,`show ${r.id}`);assert.ok(shown.all.includes(url));assert.equal(JSON.parse(await f.run(`export ${r.id}`)).record.attachments[0].evidence.sources[0].sourceUrl,url);
 backend.data.set(key,JSON.stringify(bookmarks(101)));assert.match(await f.run(`bookmarks ${r.id}`),/could not be read completely/);
});
test("fresh bookmark selection rejects changed/revoked/unsafe references and 10000 text-byte overflow",async()=>{
 const {f,backend,key,bookmarks,owner}=production(),r=await setup(f),data=bookmarks(3,"界".repeat(1700));backend.data.set(key,JSON.stringify(data));let p=await f.run(`bookmarks ${r.id} --source toolbox:bookmarks:bookmark000`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1],rev=(await state(f)).records[0].revision;
 assert.match(await f.run(`attach ${r.id} ${r.items[0].id} | toolbox:bookmarks:bookmark000 | ${fp} | ${rev}`),/10000/);assert.equal((await state(f)).records[0].attachments.length,0);
 const smaller=bookmarks(3,"界".repeat(900));backend.data.set(key,JSON.stringify(smaller));p=await f.run(`bookmarks ${r.id}`);fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];assert.match(await f.run(`attach ${r.id} ${r.items[0].id} | toolbox:bookmarks:bookmark000 | ${fp} | ${rev}`),/Saved selected/);
 p=await f.run(`bookmarks ${r.id} --source toolbox:bookmarks:bookmark001`);fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];rev=(await state(f)).records[0].revision;assert.match(await f.run(`attach ${r.id} ${r.items[1].id} | toolbox:bookmarks:bookmark001 | ${fp} | ${rev}`),/10000/);
 smaller.entries[1].data.note="changed";backend.data.set(key,JSON.stringify(smaller));assert.match(await f.run(`attach ${r.id} ${r.items[1].id} | toolbox:bookmarks:bookmark001 | ${fp} | ${rev}`),/stale/);
 (smaller.entries[0]as any).userId="UFOREIGN";backend.data.set(key,JSON.stringify(smaller));assert.match((await walk(f,`bookmarks ${r.id}`)).all,/absent\/unavailable/);
 for(const url of["javascript:alert(1)","https://user:secret@example.test/a","https://example.test/%zz"]){const unsafe=bookmarks(1);unsafe.entries[0].data.url=url;unsafe.entries[0].body=url;backend.data.set(key,JSON.stringify(unsafe));const p=await f.run(`bookmarks ${r.id}`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];assert.match(await f.run(`attach ${r.id} ${r.items[1].id} | toolbox:bookmarks:bookmark000 | ${fp} | ${rev}`),/credential-free/);}
 for(const who of[{teamId:"TOTHER",userId:owner.userId},{teamId:owner.teamId,userId:"UOTHER"}])assert.match(await f.run(`show ${r.id}`,{owner:who}),/not found/);
});
test("maximum reading/edge counts and report pages retain last fields and reject stale continuations",async()=>{
 const f=createAgentFeatureFixture(feature);await f.run("create Max route");const id=(await state(f)).records[0].id;for(let i=0;i<24;i++)assert.match(await f.run(`item ${id} add Reading ${i} ${"界".repeat(30)} | 1 | Source ${i} ${"x".repeat(100)}`),/Saved reading/);let r=(await state(f)).records[0];let edges=0;for(let i=1;i<24&&edges<48;i++)for(let j=0;j<i&&edges<48;j++){assert.match(await f.run(`requires ${id} ${r.items[i].id} | ${r.items[j].id}`),/Saved prerequisite/);edges++;}assert.equal((await state(f)).records[0].edges.length,48);assert.match(await f.run(`item ${id} add excess | 1 | source`),/Maximum 24/);
 for(const cmd of[`show ${id}`,`route ${id} | 100`]){const result=await walk(f,cmd);assert.ok(result.count>1);assert.match(result.all,/Reading 23/);const next=result.first.match(/Next: (.+)/)![1].slice(prefix.length);await f.run(`edit ${id} | Updated`);assert.match(await f.run(next),/Restart: .*page 1/);}assert.ok(Buffer.byteLength(await f.run(`export ${id}`))<=24576);
});
test("strict booleans/bookmark enums preserve raw bytes and real CAS retries guard completion/edit/removal",async()=>{
 let conflict:((s:any)=>void)|undefined;const backend=createMemoryAgentBackend({beforeCompareSet(key,previous){if(conflict&&key.endsWith(":state")){const s=JSON.parse(previous!);const fn=conflict;conflict=undefined;fn(s);backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),r=await setup(f),good=await state(f);
 for(const bad of[[false],"false",{toString:"false"}]){const s=structuredClone(good);s.records[0].items[0].completed=bad;const raw=JSON.stringify(s);backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(backend.data.get(f.key("state")),raw);}for(const raw of["null","{bad"]){backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(backend.data.get(f.key("state")),raw);}backend.data.set(f.key("state"),JSON.stringify(good));
 for(const cmd of[`read ${r.id} ${r.items[0].id}`,`requires ${r.id} ${r.items[1].id} | ${r.items[0].id}`,`item ${r.id} edit ${r.items[0].id} | edited | 5 | src`,`remove ${r.id} item ${r.items[0].id} confirm`,`delete ${r.id} confirm`]){conflict=s=>s.records[0].revision++;assert.match(await f.run(cmd),/changed/);}
 await f.run("create Other");conflict=s=>{s.records[1].revision++;s.records[1].goal="Concurrent";};assert.match(await f.run(`read ${r.id} ${r.items[0].id}`),/reported read/);assert.equal((await state(f)).records[1].goal,"Concurrent");
});
test("bookmark attachment guards every CAS retry and deletion during awaited selection",async()=>{
 let gate:ReturnType<typeof deferred<any[]>>|undefined,conflict=false;const source={id:"toolbox:bookmarks:b",kind:"bookmark" as const,title:"Bookmark",text:"annotation",sourceUrl:"https://example.test/a",metadata:{source:"Personal toolbox / bookmarks",url:"https://example.test/a",note:"annotation",read:false}};
 const backend=createMemoryAgentBackend({beforeCompareSet(key,previous){if(conflict&&key.endsWith(":state")){conflict=false;const s=JSON.parse(previous!);s.records[0].revision++;backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend,services:{readContext:async()=>gate?gate.promise:[source]}}),r=await setup(f);let rev=(await state(f)).records[0].revision;const p=await f.run(`bookmarks ${r.id}`),fp=p.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];conflict=true;assert.match(await f.run(`attach ${r.id} ${r.items[0].id} | ${source.id} | ${fp} | ${rev}`),/changed/);
 rev=(await state(f)).records[0].revision;gate=deferred();const pending=f.run(`attach ${r.id} ${r.items[0].id} | ${source.id} | ${fp} | ${rev}`);await new Promise(resolve=>setImmediate(resolve));await f.run(`delete ${r.id} confirm`);gate.resolve([source]);assert.match(await pending,/not found/);assert.equal((await state(f)).records.length,0);
});
test("UTF8 near-quota admission reserves every completion timestamp and removal above content budget",async()=>{
 const f=createAgentFeatureFixture(feature);let filled=false;for(let root=0;root<10&&!filled;root++){await f.run(`create Goal ${root}`);const r=(await state(f)).records.at(-1);for(let i=0;i<24;i++){const reply=await f.run(`item ${r.id} add ${'"'.repeat(150)} | 1 | ${'"'.repeat(190)}`);if(!reply.includes("Saved reading")){filled=true;break;}}}
 const before=await state(f);let count=0;for(const r of before.records)for(const i of r.items){assert.match(await f.run(`read ${r.id} ${i.id}`),/reported read/);count++;}assert.ok(count>24);assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)>32768);assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);for(const r of(await state(f)).records){assert.ok(Buffer.byteLength(await f.run(`export ${r.id}`))<=24576);await f.run(`delete ${r.id} confirm`);}assert.equal((await state(f)).records.length,0);
});

test("ten actual bookmark snapshots retain exactly 10000 source-text bytes and replace/remove safely",async()=>{
 const {f,backend,key,bookmarks,services}=production();await f.run("create Exact source capacity");const id=(await state(f)).records[0].id;
 for(let i=0;i<11;i++)await f.run(`item ${id} add Reading ${i} | 1 | bookmark`);
 const data=bookmarks(11,"n");for(const entry of data.entries){const size=1000-Buffer.byteLength(JSON.stringify(entry.data))-1;entry.body=entry.data.url+"x".repeat(size-Buffer.byteLength(entry.data.url));}backend.data.set(key,JSON.stringify(data));
 const adapted=await services.readContext(["bookmark"]);assert.equal(adapted.length,11);assert.ok(adapted.every(s=>Buffer.byteLength(s.text)===1000));
 for(let i=0;i<10;i++){const r=(await state(f)).records[0],sid=`toolbox:bookmarks:bookmark${String(i).padStart(3,"0")}`,result=await walk(f,`bookmarks ${id} --source ${sid}`),fp=result.first.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];assert.match(await f.run(`attach ${id} ${r.items[i].id} | ${sid} | ${fp} | ${r.revision}`),/Saved selected/);}
 let r=(await state(f)).records[0];assert.equal(r.attachments.length,10);assert.equal(r.attachments.reduce((n:number,a:any)=>n+Buffer.byteLength(a.evidence.sources[0].text),0),10000);
 const shown=await walk(f,`show ${id}`),out=JSON.parse(await f.run(`export ${id}`));assert.equal(out.record.attachments.length,10);assert.ok(shown.all.includes("toolbox:bookmarks:bookmark009"));for(const a of r.attachments)assert.deepEqual(a.evidence.sources[0],JSON.parse(JSON.stringify(adapted.find(s=>s.id===a.evidence.sources[0].id))));
 let detail=await walk(f,`bookmarks ${id} --source toolbox:bookmarks:bookmark010`),fp=detail.first.match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];assert.match(await f.run(`attach ${id} ${r.items[10].id} | toolbox:bookmarks:bookmark010 | ${fp} | ${r.revision}`),/Maximum ten/);
 await f.run(`read ${id} ${r.items[0].id}`);r=(await state(f)).records[0];assert.match(await f.run(`attach-edit ${id} ${r.attachments[0].id} | ${r.items[0].id} | toolbox:bookmarks:bookmark010 | ${fp} | ${r.revision}`),/Saved selected/);r=(await state(f)).records[0];assert.equal(r.items[0].completed,false);assert.equal(r.attachments[0].evidence.sources[0].id,"toolbox:bookmarks:bookmark010");
 assert.match(await f.run(`remove ${id} attachment ${r.attachments[0].id} confirm`),/Removed attachment/);assert.equal((await state(f)).records[0].attachments.length,9);
});

test("schema-valid legacy aggregate recovers by exact root deletion, including CAS growth", async () => {
  let inject: ((value: any) => void) | undefined;
  let winning: string | undefined;
  const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) {
    if (inject && key.endsWith(":state")) {
      const value = JSON.parse(previous!), change = inject; inject = undefined; change(value);
      winning = JSON.stringify(value); backend.data.set(key, winning);
    }
  } });
  const f = createAgentFeatureFixture(feature, { backend });
  await f.run("create Legacy root"); const id = (await state(f)).records[0].id;
  for (let i = 0; i < 24; i++) assert.match(await f.run(`item ${id} add ${"t".repeat(160)} | 1 | ${"s".repeat(200)}`), /Saved/);
  const root = (await state(f)).records[0];
  // Only the aggregate is synthetic: each constituent root was admitted by real commands.
  const clone = () => {
    const ids = new Map<string, string>();
    return JSON.parse(JSON.stringify(root).replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g, old => {
      if (!ids.has(old)) ids.set(old, randomUUID()); return ids.get(old)!;
    }));
  };
  const legacy = { version: 1, records: Array.from({ length: 10 }, clone) };
  const raw = JSON.stringify(legacy); assert.ok(Buffer.byteLength(raw) < 512000);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...legacy, records: legacy.records.slice(1) })) > 49152);
  backend.data.set(f.key("state"), raw);
  for (const r of legacy.records) assert.deepEqual(JSON.parse(await f.run(`export ${r.id}`)).record, r);
  const target = legacy.records[0].id;
  for (const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}]) {
    assert.match(await f.run(`delete ${target} confirm`, { owner }), /not found/);
    assert.equal(backend.data.get(f.key("state")), raw);
  }
  assert.match(await f.run(`edit ${target} | Restricted growth`), /quota/i);
  assert.equal(backend.data.get(f.key("state")), raw);
  const broken = " \n" + JSON.stringify({ ...legacy, version: 2 }) + "\t";
  backend.data.set(f.key("state"), broken); await f.run(`delete ${target} confirm`);
  assert.equal(backend.data.get(f.key("state")), broken); backend.data.set(f.key("state"), raw);
  inject = s => { s.records[0].revision++; s.records[0].goal = "Concurrent target growth"; };
  assert.match(await f.run(`delete ${target} confirm`), /changed/);
  assert.equal(backend.data.get(f.key("state")), winning);
  inject = s => { s.records[1].revision++; s.records[1].goal = "Unrelated growth retained"; };
  assert.match(await f.run(`delete ${target} confirm`), /Deleted privately/);
  assert.equal(backend.data.get(f.key("state")), JSON.stringify({version:1,records:JSON.parse(winning!).records.slice(1)}));
  assert.ok(Buffer.byteLength(backend.data.get(f.key("state"))!) > 49152);
  let remaining = (await state(f)).records;
  while (remaining.length) {
    const before = backend.data.get(f.key("state"))!;
    assert.match(await f.run(`delete ${remaining[0].id} confirm`), /Deleted privately/);
    remaining = remaining.slice(1);
    assert.equal(backend.data.get(f.key("state")), JSON.stringify({version:1,records:remaining}));
    assert.ok(Buffer.byteLength(backend.data.get(f.key("state"))!) < Buffer.byteLength(before));
  }
  assert.match(await f.run("create Recovered"), /Saved privately/);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

test("backend errors are sanitized before and after dispatch while validation stays actionable", async () => {
  const marker = "FAKE_BACKEND_DIAGNOSTIC_PASSWORD_DO_NOT_DISPLAY";
  for (const operation of ["get", "compareSet", "committed"] as const) for (const rejected of [false, true]) {
    const backend = createMemoryAgentBackend(), f = createAgentFeatureFixture(feature, { backend });
    await f.run("create Original"); const r = (await state(f)).records[0];
    const original = backend.data.get(f.key("state")), get = backend.get, compareSet = backend.compareSet;
    let dispatched: string | undefined;
    const fail = () => { if (rejected) return Promise.reject(new Error(marker)); throw new Error(marker); };
    if (operation === "get") backend.get = () => fail();
    else backend.compareSet = (key, previous, next) => {
      if (operation === "committed") {
        assert.equal(backend.data.get(key), previous); backend.data.set(key, next); dispatched = next;
      }
      return fail();
    };
    const reply = await f.run(operation === "get" ? "list" : `edit ${r.id} | Changed`);
    assert.doesNotMatch(reply, new RegExp(marker)); assert.match(reply, /Inspect before retrying/);
    assert.match(reply, /dispatched save may have completed/); assert.ok(reply.length <= 3500);
    assert.equal(backend.data.get(f.key("state")), operation === "committed" ? dispatched : original);
    backend.get = get; backend.compareSet = compareSet;
    assert.equal(JSON.parse(await f.run(`export ${r.id}`)).record.goal, operation === "committed" ? "Changed" : "Original");
    const raw = backend.data.get(f.key("state"));
    for (const cmd of ["create " + "x".repeat(161), "create A | surplus", "list 0"]) {
      const bad = await f.run(cmd); assert.match(bad, /Field|field|page|Page/);
      assert.doesNotMatch(bad, /could not be read|unavailable/); assert.equal(backend.data.get(f.key("state")), raw);
    }
    assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
  }
});

test("source failures hide diagnostics and preserve typed capacity recovery", async () => {
  const marker = "FAKE_SOURCE_DIAGNOSTIC_PASSWORD_DO_NOT_DISPLAY";
  for (const capacity of [false, true]) {
    const f = createAgentFeatureFixture(feature, {services:{readContext:async () => {
      throw capacity ? new AgentContextCapacityError() : new Error(marker);
    }}});
    await f.run("create Sources"); const r = (await state(f)).records[0], raw = f.backend.data.get(f.key("state"));
    const reply = await f.run(`bookmarks ${r.id}`);
    assert.doesNotMatch(reply, new RegExp(marker));
    assert.match(reply, capacity ? /complete-read budget.*No source data was truncated/ : /could not be read completely/);
    assert.match(reply, capacity ? /Narrow|Reduce/ : /owning source/);
    assert.equal(f.backend.data.get(f.key("state")), raw);
    assert.deepEqual(f.calls,{generate:0,search:0,readContext:1});
  }
});

async function erasureFixture(f: ReturnType<typeof createAgentFeatureFixture>) {
  assert.match(await f.run("create Queue basics"), /Saved/);
  const read = async () => (await f.store().read<any>("state"))!;
  const id = (await read()).records[0].id;
  for (let i = 0; i < 12; i++) assert.match(await f.run(`item ${id} add ${"T".repeat(160)} | 15 | ${"E".repeat(200)}`), /Saved/);
  return { id, read };
}

for (const ceiling of [false, true]) test(`selective erasure retains other children and invalidates complete pages (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const f = createAgentFeatureFixture(feature), {id, read} = await erasureFixture(f);
  if (ceiling) { const s = await read(); s.records[0].revision = 999999999; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  const before = (await read()).records[0], child = before.items[0].id;
  assert.deepEqual(JSON.parse(await f.run(`export ${id}`)).record, before);
  const first = await f.run(`show ${id}`), continuation = first.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1];
  assert.ok(continuation, "fixture exercises real continuation");
  assert.match(continuation, / rev \d+:[a-f0-9]{64}$/);
  assert.match(await f.run(continuation), /Page 2\//);
  assert.match(await f.run(`remove ${id} item ${child} confirm`), /Saved|Removed/);
  const after = (await read()).records[0];
  assert.equal(after.revision, ceiling ? 999999999 : before.revision + 1);
  assert.deepEqual(after.items, before.items.slice(1));
  assert.match(await f.run(continuation), /changed|snapshot|Restart/i);
  assert.match(await f.run(continuation.replace(/:[a-f0-9]{64}/, "")), /changed|snapshot|Restart/i);
  // New pages remain complete and lossless after a saturated revision removal.
  let cmd = `show ${id}`, body = "";
  while (cmd) {
    const reply = await f.run(cmd); assert.ok(reply.length <= 3500 && reply.isWellFormed());
    const marker = reply.match(/\nPage \d+\/\d+\n/); assert.ok(marker);
    body += reply.slice(marker.index! + marker[0].length).replace(/\nNext: \/nobo-help agent [^\n]+$/, "");
    cmd = reply.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1] ?? "";
  }
  assert.deepEqual(JSON.parse(body.slice(body.indexOf("{"))), JSON.parse(await f.run(`export ${id}`)));
  if (ceiling) {
    const raw = f.backend.data.get(f.key("state")); assert.match(await f.run(`edit ${id} | Changed`), /Revision limit/);
    assert.equal(f.backend.data.get(f.key("state")), raw);
  }
  await f.run(`delete ${id} confirm`); assert.equal((await read()).records.length, 0);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

for (const ceiling of [false, true]) test(`real CAS protects erasure intent and retries unrelated changes (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  let action: (() => Promise<void>) | undefined, winning: string | undefined;
  const backend = createMemoryAgentBackend({async beforeCompareSet(key) {
    if (key.endsWith(":state") && action) { const work = action; action = undefined; await work(); winning = backend.data.get(key); }
  }});
  const f = createAgentFeatureFixture(feature, {backend}), {id, read} = await erasureFixture(f);
  await f.run("create Queue basics");
  if (ceiling) { const s = await read(); s.records[0].revision = 999999999; backend.data.set(f.key("state"), JSON.stringify(s)); }
  const original = backend.data.get(f.key("state"))!, r = (await read()).records[0], child = r.items[0].id;
  const remove = (child: string) => `remove ${id} item ${child} confirm`;
  // A real same-record removal wins while the original operation is awaiting CAS.
  for (const pending of [remove(child), `delete ${id} confirm`]) {
    backend.data.set(f.key("state"), original);
    action = async () => { assert.match(await f.run(remove(r.items[1].id)), /Saved|Removed/); };
    assert.match(await f.run(pending), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  }
  // A competing writer reintroduces the child ID with changed content. The exact
  // numeric revision can be unchanged; intent must still bind the full snapshot.
  backend.data.set(f.key("state"), original);
  action = async () => {
    assert.match(await f.run(remove(child)), /Saved|Removed/);
    const s = await read(), replacement = structuredClone(r.items[0]);
    replacement.title = "Reintroduced evidence";
    s.records[0].items.push(replacement); backend.data.set(f.key("state"), JSON.stringify(s));
    assert.equal(JSON.parse(await f.run(`export ${id}`)).record.items.at(-1).id, child);
  };
  assert.match(await f.run(remove(child)), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { await f.run(`delete ${id} confirm`); };
  assert.match(await f.run(remove(child)), /not found/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { const other = (await read()).records[1].id; await f.run(`delete ${other} confirm`); };
  assert.match(await f.run(remove(child)), /Saved|Removed/);
  const after = await read(); assert.equal(after.records.length, 1);
  assert.deepEqual(after.records[0].items, r.items.slice(1));
  assert.ok(backend.calls.conflicts >= 5);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

for (const ceiling of [false, true]) for (const operation of ["read", "replace"] as const)
test(`pending source ${operation} cannot repeat or restore removed attachment (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const marker = "ERASED_SOURCE_MARKER", source = {id:"toolbox:bookmarks:erasure",kind:"bookmark" as const,title:"Book",text:marker,sourceUrl:"https://example.test/erasure",metadata:{source:"Personal toolbox / bookmarks",url:"https://example.test/erasure"}};
  const entered = deferred<void>(), gate = deferred<typeof source[]>(); let waiting = false;
  const f = createAgentFeatureFixture(feature, {services:{readContext:async kinds => {
    assert.deepEqual(kinds, ["bookmark"]); if (waiting) { entered.resolve(); return gate.promise; } return [source];
  }}});
  await setup(f); let r = (await state(f)).records[0];
  const list = `bookmarks ${r.id} --source ${source.id}`;
  const fp = (await f.run(list)).match(/Fingerprint: (e1:[a-f0-9]{64})/)![1];
  assert.match(await f.run(`attach ${r.id} ${r.items[0].id} | ${source.id} | ${fp} | ${r.revision}`), /Saved selected/);
  const s = await state(f); if (ceiling) { s.records[0].revision = 999999999; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  r = (await state(f)).records[0];
  const attachment = r.attachments[0], calls = f.calls.readContext;
  waiting = true;
  const pending = f.run(operation === "read" ? list : `attach-edit ${r.id} ${attachment.id} | ${r.items[0].id} | ${source.id} | ${fp} | ${r.revision}`);
  await entered.promise;
  assert.match(await f.run(`remove ${r.id} attachment ${attachment.id} confirm`), /Removed/);
  const raw = f.backend.data.get(f.key("state")), writes = f.backend.calls.writes;
  gate.resolve([source]);
  const reply = await pending; assert.match(reply, /changed/); assert.doesNotMatch(reply, new RegExp(marker));
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.backend.calls.writes, writes);
  assert.equal(f.calls.readContext, calls + 1); assert.equal(f.calls.generate + f.calls.search, 0);
});

test("all field and relationship erasures remain valid at the root revision ceiling", async () => {
  const f = createAgentFeatureFixture(feature);
  const r = await setup(f), id = r.id;
  await f.run(`requires ${id} ${r.items[1].id} | ${r.items[0].id}`);
  for (const i of r.items) await f.run(`read ${id} ${i.id}`);
  const edge = (await state(f)).records[0].edges[0];
  const s = (await f.store().read<any>("state"))!; s.records[0].revision = 999999999;
  const original = JSON.stringify(s);
  for (const cmd of [`remove ${id} item ${r.items[0].id} confirm`,
    `remove ${id} edge ${edge.id} confirm`,
    `unread ${id} ${r.items[0].id} confirm`]) {
    f.backend.data.set(f.key("state"), original);
    assert.match(await f.run(cmd), /Saved|Removed|Cleared/);
    assert.notEqual(f.backend.data.get(f.key("state")), original, cmd);
    const exported = JSON.parse(await f.run(`export ${id}`));
    assert.equal(exported.record.revision, 999999999);
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 24576);
  }
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});
