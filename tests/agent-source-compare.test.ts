import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/source-compare.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const prefix="/nobo-help agent source-compare ";
const state=async(f:ReturnType<typeof createAgentFeatureFixture>)=>(await f.store().read<any>("state"))!;
async function walk(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string){let all="",first="",count=0;while(cmd){const reply=await f.run(cmd);assert.ok(reply.length<=3500);first||=reply;all+=reply;const next=reply.match(/Next: (\/nobo-help agent source-compare [^\n]+)/)?.[1];cmd=next?.includes(" rev ")?next.slice(prefix.length):"";assert.ok(++count<70);}return{all,first,count};}
async function setup(f:ReturnType<typeof createAgentFeatureFixture>){await f.run("create Two onboarding studies");const id=(await state(f)).records[0].id;await f.run(`source ${id} add Study A | Five participants completed setup without help.`);await f.run(`source ${id} add Study B | Two of five participants needed help during setup.`);await f.run(`topic ${id} add Setup assistance`);const r=(await state(f)).records[0];for(const s of r.sources)await f.run(`quote ${id} ${r.topics[0].id} | ${s.id} | ${s.text}`);return(await state(f)).records[0];}
const draft=(r:any)=>JSON.stringify({items:[{topicId:r.topics[0].id,cells:r.cells.filter((c:any)=>c.topicId===r.topics[0].id).map((c:any)=>({sourceId:c.sourceId,excerpt:c.quote}))}]});
test("catalog comparison preserves unknown coverage, user labels and exact quotes; edits invalidate dependents",async()=>{
 const f=createAgentFeatureFixture(feature),r=await setup(f),tid=r.topics[0].id;let out=await f.run(`compare ${r.id}`);assert.match(out,/User label: unknown/);assert.doesNotMatch(out,/User label: disagreement/);assert.match(out,/lexical difference|Lexical difference/);
 const before=f.backend.data.get(f.key("state"));assert.match(await f.run(`quote-edit ${r.id} ${r.cells[0].id} | ${tid} | ${r.sources[0].id} | fabricated`),/exact nonempty span/);assert.equal(f.backend.data.get(f.key("state")),before);
 await f.run(`label ${r.id} ${tid} | disagreement`);assert.match(await f.run(`compare ${r.id}`),/User label: disagreement/);
 await f.run(`source ${r.id} edit ${r.sources[0].id} | Study A new sample | Different sample, observed 2026-10-20.`);let s=(await state(f)).records[0];assert.equal(s.cells.length,1);assert.equal(s.topics[0].label,"unknown");assert.match(await f.run(`compare ${r.id}`),/UNKNOWN — no selected excerpt/);
 await f.run(`topic ${r.id} edit ${tid} | Different dates`);assert.equal((await state(f)).records[0].cells.length,0);assert.match(await f.run(`label ${r.id} ${tid} | agreement`),/at least two/);
 await f.run(`quote ${r.id} ${tid} | ${r.sources[0].id} | Different sample`);await f.run(`remove ${r.id} source ${r.sources[0].id} confirm`);assert.equal((await state(f)).records[0].cells.length,0);
 await f.run(`edit ${r.id} | Updated comparison`);await f.run(`remove ${r.id} topic ${tid} confirm`);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("normalized duplicates never become independent corroboration or automatic contradiction",async()=>{
 const f=createAgentFeatureFixture(feature);await f.run("create Duplicates");const id=(await state(f)).records[0].id;for(const [label,text]of[["A","Same   quote"],["B","ＳＡＭＥ quote"],["C","Different sample"]])await f.run(`source ${id} add ${label} | ${text}`);await f.run(`topic ${id} add Shared wording`);let r=(await state(f)).records[0];for(const s of r.sources.slice(0,2))await f.run(`quote ${id} ${r.topics[0].id} | ${s.id} | ${s.text}`);
 const out=await f.run(`compare ${id}`);assert.match(out,/Duplicate normalized quotes/);assert.match(out,/not independent corroboration/);assert.match(out,/UNKNOWN — no selected excerpt/);assert.match(out,/User label: unknown/);
});
test("complete maximum matrix and source text pages are revision-bound and retrievable",async()=>{
 const f=createAgentFeatureFixture(feature);await f.run("create Max matrix");const id=(await state(f)).records[0].id;
 for(let i=0;i<5;i++)assert.match(await f.run(`source ${id} add S${i} | common ${"x".repeat(2980)} END${i}`),/Saved source/);
 for(let i=0;i<8;i++)assert.match(await f.run(`topic ${id} add T${i}`),/Saved topic/);const r=(await state(f)).records[0];
 for(const t of r.topics)for(const s of r.sources)assert.match(await f.run(`quote ${id} ${t.id} | ${s.id} | common`),/Saved exact/);
 assert.equal((await state(f)).records[0].cells.length,40);assert.match(await f.run(`source ${id} add sixth | text`),/five/);assert.match(await f.run(`topic ${id} add ninth`),/eight/);
 for(const verb of["show","compare"]){const result=await walk(f,`${verb} ${id}`);assert.ok(result.count>1);assert.ok(result.all.includes(verb==="show"?"END4":r.topics[7].id));const next=result.first.match(/Next: (.+)/)![1].slice(prefix.length);await f.run(`edit ${id} | Updated ${verb}`);assert.match(await f.run(next),/Restart: .*page 1/);}
 const out=await f.run(`export ${id}`);assert.ok(Buffer.byteLength(out)<=24576);assert.equal(JSON.parse(out).record.sources[4].text,r.sources[4].text);
 for(const owner of[{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])assert.match(await f.run(`export ${id}`,{owner}),/not found/);
});
test("one explicit constrained synthesis cites current cells without fabricated prose or labels",async()=>{
 let output="";const f=createAgentFeatureFixture(feature,{services:{generate:async({input,instructions})=>{assert.ok(Buffer.byteLength(input)<=16000);assert.ok(Buffer.byteLength(instructions)<=4000);return output;}}}),r=await setup(f);output=draft(r);const before=f.backend.data.get(f.key("state"));const reply=await f.run(`synthesize ${r.id}`);assert.match(reply,/Unsaved interpretation/);assert.match(reply,/User label \(not a factual finding\): unknown/);assert.match(reply,/Five participants/);assert.equal(f.calls.generate,1);assert.equal(f.backend.data.get(f.key("state")),before);
 for(const invalid of[JSON.stringify({items:[{topicId:r.topics[0].id,cells:[{sourceId:r.sources[0].id,excerpt:"fabricated"}]}]}),JSON.stringify({items:[{topicId:r.topics[0].id,cells:[],conclusion:"proven"}]}),"x".repeat(4001)]){output=invalid;assert.match(await f.run(`synthesize ${r.id}`),/invalid\/oversized/);assert.equal(f.backend.data.get(f.key("state")),before);}assert.equal(f.calls.generate,4);
 const unavailable=createAgentFeatureFixture(feature);const u=await setup(unavailable);assert.match(await unavailable.run(`synthesize ${u.id}`),/unavailable/);assert.equal(unavailable.calls.generate,1);
});
test("deferred synthesis refuses edit/deletion, consumes cancellation and leaves no late save",async()=>{
 for(const action of["edit","delete","cancel"]){const gate=deferred<string>(),started=deferred<void>(),controller=new AbortController();const f=createAgentFeatureFixture(feature,{services:{generate:async()=>{started.resolve();return gate.promise;}}}),r=await setup(f);const pending=f.run(`synthesize ${r.id}`,{signal:controller.signal});await started.promise;
 if(action==="cancel"){const rejection=assert.rejects(pending,/cancelled/);controller.abort(new Error("cancelled"));await rejection;const before=f.backend.data.get(f.key("state"));gate.resolve(draft(r));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.backend.data.get(f.key("state")),before);}else{await f.run(action==="edit"?`edit ${r.id} | New revision`:`delete ${r.id} confirm`);gate.resolve(draft(r));assert.match(await pending,/stale draft discarded/);}assert.equal(f.calls.generate,1);}
});
test("input/output bounds reject complete oversized digests without regeneration pages",async()=>{
 let output="";const f=createAgentFeatureFixture(feature,{services:{generate:async()=>output}});await f.run("create Big digest");const id=(await state(f)).records[0].id;for(let i=0;i<3;i++)await f.run(`source ${id} add S${i} | ${"x".repeat(600)}`);for(let i=0;i<8;i++)await f.run(`topic ${id} add T${i}`);let r=(await state(f)).records[0];for(const t of r.topics)for(const s of r.sources)await f.run(`quote ${id} ${t.id} | ${s.id} | ${"x".repeat(600)}`);assert.match(await f.run(`synthesize ${id}`),/16000-byte/);assert.equal(f.calls.generate,0);
 await f.run(`delete ${id} confirm`);await f.run("create Too long reply");const id2=(await state(f)).records[0].id;for(let i=0;i<2;i++)await f.run(`source ${id2} add S${i} | ${"x".repeat(490)}`);for(let i=0;i<3;i++)await f.run(`topic ${id2} add T${i}`);r=(await state(f)).records[0];for(const t of r.topics)for(const s of r.sources)await f.run(`quote ${id2} ${t.id} | ${s.id} | ${s.text}`);r=(await state(f)).records[0];output=JSON.stringify({items:r.topics.map((t:any)=>({topicId:t.id,cells:r.sources.map((s:any)=>({sourceId:s.id,excerpt:s.text}))}))});assert.ok(output.length<=4000);assert.match(await f.run(`synthesize ${id2}`),/No model call was made/);assert.equal(f.calls.generate,0);
});
test("strict enum/span validation preserves corrupt bytes; all mutation CAS retries protect target revision",async()=>{
 let conflict:((s:any)=>void)|undefined;const backend=createMemoryAgentBackend({beforeCompareSet(key,previous){if(conflict&&key.endsWith(":state")){const s=JSON.parse(previous!);const fn=conflict;conflict=undefined;fn(s);backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),r=await setup(f),good=await state(f);
 for(const bad of[["agreement"],{toString:"agreement"},"true"]){const copy=structuredClone(good);copy.records[0].topics[0].label=bad;const raw=JSON.stringify(copy);backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(backend.data.get(f.key("state")),raw);}for(const raw of["null","{bad"]){backend.data.set(f.key("state"),raw);await f.run(`delete ${r.id} confirm`);assert.equal(backend.data.get(f.key("state")),raw);}backend.data.set(f.key("state"),JSON.stringify(good));
 for(const cmd of[`label ${r.id} ${r.topics[0].id} | agreement`,`source ${r.id} edit ${r.sources[0].id} | Edited | New text`,`quote-edit ${r.id} ${r.cells[0].id} | ${r.topics[0].id} | ${r.sources[0].id} | Five`,`remove ${r.id} quote ${r.cells[0].id} confirm`,`delete ${r.id} confirm`]){conflict=s=>s.records[0].revision++;assert.match(await f.run(cmd),/changed/);}
 await f.run("create Other");conflict=s=>{s.records[1].revision++;s.records[1].title="Unrelated";};assert.match(await f.run(`label ${r.id} ${r.topics[0].id} | disagreement`),/Saved user label/);assert.equal((await state(f)).records[1].title,"Unrelated");
});
test("exact content-byte boundary reserves all label growth and allows removal after crossing it",async()=>{
 const f=createAgentFeatureFixture(feature);for(let i=0;i<6;i++){await f.run(`create R${i}界😀`);const r=(await state(f)).records.at(-1);for(let j=0;j<2;j++)await f.run(`source ${r.id} add S${j} | "`);for(let j=0;j<8;j++)await f.run(`topic ${r.id} add T${j}`);const fresh=(await state(f)).records.at(-1);for(const t of fresh.topics)for(const s of fresh.sources)await f.run(`quote ${r.id} ${t.id} | ${s.id} | "`);}
 let filled=false;
 for(const r of(await state(f)).records){for(const source of r.sources){const reply=await f.run(`source ${r.id} edit ${source.id} | ${source.label} | ${'"'.repeat(3000)}`);if(reply.includes("quota reached")){const bytes=Buffer.byteLength(f.backend.data.get(f.key("state"))!); // source edit clears 8 cells, so measure a one-char edit first.
 await f.run(`source ${r.id} edit ${source.id} | Edited | "`);const current=Buffer.byteLength(f.backend.data.get(f.key("state"))!),remaining=49152-current;assert.ok(remaining>=0);const value='"'.repeat(1+Math.floor(remaining/2))+(remaining%2?"x":"");assert.ok(value.length<=3000);assert.match(await f.run(`source ${r.id} edit ${source.id} | Edited | ${value}`),/Saved source/);filled=true;break;}}if(filled)break;}
 assert.ok(filled);assert.equal(Buffer.byteLength(f.backend.data.get(f.key("state"))!),49152);
 // Remaining untouched rows still have two valid cells; their labels can grow.
 let changed=0;for(const r of(await state(f)).records)for(const t of r.topics)if(r.cells.filter((c:any)=>c.topicId===t.id).length>=2){assert.match(await f.run(`label ${r.id} ${t.id} | disagreement`),/Saved user label/);changed++;}assert.ok(changed>0);assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)>49152);
 for(const r of(await state(f)).records){assert.ok(Buffer.byteLength(await f.run(`export ${r.id}`))<=24576);await f.run(`delete ${r.id} confirm`);}assert.equal((await state(f)).records.length,0);
});

test("synthesis content stamp rejects same-revision changes including ceiling-state removal",async()=>{
 const gate=deferred<string>(),started=deferred<void>();const f=createAgentFeatureFixture(feature,{services:{generate:async()=>{started.resolve();return gate.promise;}}}),r=await setup(f);
 const seeded=await state(f);seeded.records[0].revision=999999999;f.backend.data.set(f.key("state"),JSON.stringify(seeded));
 const pending=f.run(`synthesize ${r.id}`);await started.promise;
 // Simulate a supported external same-revision removal at a revision ceiling.
 await f.store().update<any,void>("state",seeded,s=>{s.records[0].cells.pop();return{value:s,result:undefined};});
 gate.resolve(draft(r));assert.match(await pending,/stale draft discarded/);
 assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);
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
  for (let i = 0; i < 2; i++) assert.match(await f.run(`source ${id} add Source | ${"界".repeat(3000)}`), /Saved/);
  const root = (await state(f)).records[0];
  // Only the aggregate is synthetic: each constituent root was admitted by real commands.
  const clone = () => {
    const ids = new Map<string, string>();
    return JSON.parse(JSON.stringify(root).replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g, old => {
      if (!ids.has(old)) ids.set(old, randomUUID()); return ids.get(old)!;
    }));
  };
  const legacy = { version: 1, records: Array.from({ length: 6 }, clone) };
  const raw = JSON.stringify(legacy); assert.ok(Buffer.byteLength(raw) < 512000);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...legacy, records: legacy.records.slice(1) })) > 65536);
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
  inject = s => { s.records[0].revision++; s.records[0].title = "Concurrent target growth"; };
  assert.match(await f.run(`delete ${target} confirm`), /changed/);
  assert.equal(backend.data.get(f.key("state")), winning);
  inject = s => { s.records[1].revision++; s.records[1].title = "Unrelated growth retained"; };
  assert.match(await f.run(`delete ${target} confirm`), /Deleted privately/);
  assert.equal(backend.data.get(f.key("state")), JSON.stringify({version:1,records:JSON.parse(winning!).records.slice(1)}));
  assert.ok(Buffer.byteLength(backend.data.get(f.key("state"))!) > 65536);
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
    assert.equal(JSON.parse(await f.run(`export ${r.id}`)).record.title, operation === "committed" ? "Changed" : "Original");
    const raw = backend.data.get(f.key("state"));
    for (const cmd of ["create " + "x".repeat(161), "create A | surplus", "list 0"]) {
      const bad = await f.run(cmd); assert.match(bad, /Field|field|page|Page/);
      assert.doesNotMatch(bad, /could not be read|unavailable/); assert.equal(backend.data.get(f.key("state")), raw);
    }
    assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
  }
});
