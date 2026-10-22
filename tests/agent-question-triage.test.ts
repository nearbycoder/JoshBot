import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/question-triage.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const prefix="/nobo-help agent question-triage ";
const state=async(f:ReturnType<typeof createAgentFeatureFixture>)=>(await f.store().read<any>("state"))!;
async function walk(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string){let all="",first="",count=0;while(cmd){const reply=await f.run(cmd);assert.ok(reply.length<=3500);first||=reply;all+=reply;const next=reply.match(/Next: (\/nobo-help agent question-triage [^\n]+)/)?.[1];cmd=next?.includes(" rev ")?next.slice(prefix.length):"";assert.ok(++count<70);}return{all,first,count};}
async function setup(f:ReturnType<typeof createAgentFeatureFixture>){await f.run("create Choose workshop format");const id=(await state(f)).records[0].id;await f.run(`ask ${id} add Can attendees install the software? | blocking | Determines whether live exercises are feasible`);return(await state(f)).records[0];}
test("catalog flow, missing criteria, challenge retention and edit invalidation",async()=>{
 const f=createAgentFeatureFixture(feature),r=await setup(f),q=r.questions[0];
 await f.run(`answer ${r.id} ${q.id} | All three installed it | Pilot notes | 2026-10-24`);assert.match(await f.run(`queue ${r.id}`),/criterion missing, unresolved/);
 await f.run(`evidence-needed ${r.id} ${q.id} | A pilot with three representative attendees`);assert.match(await f.run(`queue ${r.id}`),/stale answer/);
 await f.run(`answer-edit ${r.id} ${q.id} | All three installed it | Pilot notes | 2026-10-24`);assert.match(await f.run(`queue ${r.id}`),/answered against user-defined criterion/);
 await f.run(`challenge ${r.id} ${q.id} | One pilot used a different operating system`);assert.match(await f.run(`queue ${r.id}`),/challenged/);let saved=(await state(f)).records[0].questions[0];assert.equal(saved.answer.text,"All three installed it");assert.equal(saved.answer.sourceLabel,"Pilot notes");
 await f.run(`challenge-edit ${r.id} ${q.id} | ${saved.challenges[0].id} | Recheck the Linux setup`);
 await f.run(`ask ${r.id} edit ${q.id} | Can everyone install version two? | blocking | Live feasibility`);assert.equal((await state(f)).records[0].questions[0].answer.stale,true);
 await f.run(`remove ${r.id} challenge ${saved.challenges[0].id} confirm`);assert.match(await f.run(`queue ${r.id}`),/stale answer/);
 await f.run(`answer-edit ${r.id} ${q.id} | Version two installed | New pilot | unknown`);assert.match(await f.run(`queue ${r.id}`),/Review: unknown/);
 await f.run(`edit ${r.id} | Choose a new workshop`);assert.equal((await state(f)).records[0].questions[0].answer.stale,true);
 await f.run(`remove ${r.id} evidence ${q.id} confirm`);await f.run(`remove ${r.id} answer ${q.id} confirm`);assert.equal((await state(f)).records[0].questions[0].answer,null);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("queue prioritizes blocking uncertainty then dated reviews without fabricating unknown dates",async()=>{
 const f=createAgentFeatureFixture(feature),r=await setup(f);for(const [title,kind]of [["Optional unknown","optional"],["Upcoming","optional"],["Overdue","optional"],["Blocking challenge","blocking"]])await f.run(`ask ${r.id} add ${title} | ${kind} | consequence`);
 const qs=(await state(f)).records[0].questions;
 for(const [q,date]of [[qs[2],"2026-10-24"],[qs[3],"2024-02-29"],[qs[4],"unknown"]]as const){await f.run(`evidence-needed ${r.id} ${q.id} | test`);await f.run(`answer ${r.id} ${q.id} | report | label | ${date}`);}
 await f.run(`challenge ${r.id} ${qs[4].id} | unresolved sample`);const out=(await walk(f,`queue ${r.id}`)).all;
 assert.ok(out.indexOf(qs[0].id)<out.indexOf(qs[4].id));assert.ok(out.indexOf(qs[4].id)<out.indexOf(qs[3].id));assert.ok(out.indexOf(qs[3].id)<out.indexOf(qs[2].id));assert.ok(out.indexOf(qs[2].id)<out.indexOf(qs[1].id));assert.match(out,/2024-02-29 \(due\)/);assert.match(out,/2026-10-24 \(upcoming\)/);
 const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`answer ${r.id} ${qs[1].id} | x | y | 2026-02-29`),/real/);assert.equal(f.backend.data.get(f.key("state")),raw);
});
test("complete pages bind revision and original as-of date; root lists and isolation",async()=>{
 let now=new Date("2026-10-22T15:00:00Z");const f=createAgentFeatureFixture(feature,{now:()=>now});await f.run("create Large board");const id=(await state(f)).records[0].id;
 let last="";for(let i=0;i<24;i++){const reply=await f.run(`ask ${id} add ${"界".repeat(90)} LAST${i} | blocking | ${'"'.repeat(250)}`);if(!reply.includes("Saved question"))break;last=`LAST${i}`;}
 for(const verb of["show","queue"]){const result=await walk(f,`${verb} ${id}`);assert.ok(result.count>1);assert.ok(result.all.includes(last));const next=result.first.match(/Next: (.+)/)![1].slice(prefix.length);now=new Date("2026-10-23T15:00:00Z");if(verb==="queue")assert.match(await f.run(next),/2026-10-22|2026-10-23/);await f.run(`edit ${id} | Updated ${verb}`);assert.match(await f.run(next),/Restart: .*page 1/);}
 const out=await f.run(`export ${id}`);assert.ok(Buffer.byteLength(out)<=24576);assert.ok(out.includes(last));
 for(let i=1;i<12;i++)await f.run(`create Board ${i}`);assert.match(await f.run("list 2"),/Board 11/);
 for(const owner of[{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])assert.match(await f.run(`export ${id}`,{owner}),/not found/);
});
test("actual CAS answer/criterion/challenge/edit/removal conflicts reject; unrelated retry succeeds",async()=>{
 let conflict:((s:any)=>void)|undefined;const backend=createMemoryAgentBackend({beforeCompareSet(key,previous){if(conflict&&key.endsWith(":state")){const s=JSON.parse(previous!);const fn=conflict;conflict=undefined;fn(s);backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),r=await setup(f),q=r.questions[0];
 for(const cmd of[`answer ${r.id} ${q.id} | answer | label | unknown`,`evidence-needed ${r.id} ${q.id} | criterion`,`challenge ${r.id} ${q.id} | note`,`ask ${r.id} edit ${q.id} | edited | optional | consequence`,`remove ${r.id} question ${q.id} confirm`,`delete ${r.id} confirm`]){conflict=s=>{s.records[0].revision++;};assert.match(await f.run(cmd),/changed/);}
 assert.deepEqual((await state(f)).records[0].questions[0],q);await f.run("create Other");conflict=s=>{s.records[1].revision++;s.records[1].decision="Concurrent";};assert.match(await f.run(`answer ${r.id} ${q.id} | accepted | label | unknown`),/Saved user-reported/);assert.equal((await state(f)).records[1].decision,"Concurrent");assert.ok(backend.calls.conflicts>=7);
});
test("strict enums/answer state and malformed raw bytes are preserved even on confirmed deletion",async()=>{
 const f=createAgentFeatureFixture(feature),r=await setup(f),s=await state(f);for(const kind of[["blocking"],{toString:"blocking"},"important"]){const copy=structuredClone(s);copy.records[0].questions[0].kind=kind;const raw=JSON.stringify(copy);f.backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(f.backend.data.get(f.key("state")),raw);}
 for(const raw of["null","{bad",JSON.stringify({...s,version:2})]){f.backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(f.backend.data.get(f.key("state")),raw);}
});
test("worst-case answer/evidence/date/challenge lifecycle fits at UTF8 quota; removals bypass content gate",async()=>{
 const f=createAgentFeatureFixture(feature);for(let root=0;root<12;root++){await f.run(`create Board ${root}`);const r=(await state(f)).records.at(-1);for(let i=0;i<10;i++){const reply=await f.run(`ask ${r.id} add ${"界😀".repeat(20)} | blocking | ${'"'.repeat(200)}`);if(!reply.includes("Saved question"))break;}}
 const initial=await state(f);let count=0;for(const r of initial.records)for(const q of r.questions){assert.match(await f.run(`answer ${r.id} ${q.id} | ${'"'.repeat(256)} | ${'"'.repeat(128)} | 9999-12-31`),/Saved user-reported/);for(let i=0;i<3;i++)assert.match(await f.run(`challenge ${r.id} ${q.id} | ${'"'.repeat(128)}`),/Saved challenge/);count++;}
 assert.ok(count>10);const raw=f.backend.data.get(f.key("state"))!;assert.ok(Buffer.byteLength(raw)>32768);assert.ok(Buffer.byteLength(raw)<=49152);
 for(const r of(await state(f)).records){assert.ok(Buffer.byteLength(await f.run(`export ${r.id}`))<=24576);for(const q of r.questions)await f.run(`remove ${r.id} question ${q.id} confirm`);await f.run(`delete ${r.id} confirm`);}assert.equal((await state(f)).records.length,0);
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
  for (let i = 0; i < 8; i++) assert.match(await f.run(`ask ${id} add ${"q".repeat(320)} | optional | ${"c".repeat(256)}`), /Saved/);
  const root = (await state(f)).records[0];
  // Only the aggregate is synthetic: each constituent root was admitted by real commands.
  const clone = () => {
    const ids = new Map<string, string>();
    return JSON.parse(JSON.stringify(root).replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g, old => {
      if (!ids.has(old)) ids.set(old, randomUUID()); return ids.get(old)!;
    }));
  };
  const legacy = { version: 1, records: Array.from({ length: 12 }, clone) };
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
  inject = s => { s.records[0].revision++; s.records[0].decision = "Concurrent target growth"; };
  assert.match(await f.run(`delete ${target} confirm`), /changed/);
  assert.equal(backend.data.get(f.key("state")), winning);
  inject = s => { s.records[1].revision++; s.records[1].decision = "Unrelated growth retained"; };
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
    assert.equal(JSON.parse(await f.run(`export ${r.id}`)).record.decision, operation === "committed" ? "Changed" : "Original");
    const raw = backend.data.get(f.key("state"));
    for (const cmd of ["create " + "x".repeat(161), "create A | surplus", "list 0"]) {
      const bad = await f.run(cmd); assert.match(bad, /Field|field|page|Page/);
      assert.doesNotMatch(bad, /could not be read|unavailable/); assert.equal(backend.data.get(f.key("state")), raw);
    }
    assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
  }
});
