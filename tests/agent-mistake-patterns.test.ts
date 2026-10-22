import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/mistake-patterns.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const rid=async(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string)=>(await f.run(cmd)).match(/[\da-f-]{36}/)![0];
const rule=async(f:ReturnType<typeof createAgentFeatureFixture>)=>rid(f,"rule add Before review, list three boundary cases | testing | 2026-10-23");
const record=async(f:ReturnType<typeof createAgentFeatureFixture>,id:string)=>JSON.parse(await f.run(`export ${id}`)).record;
async function pages(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string){let all="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500&&reply.isWellFormed());all+=reply;cmd=/Next: \/nobo-help agent mistake-patterns (.*)/.exec(reply)?.[1]??"";assert.ok(++n<60);}while(cmd);return all;}

test("catalog civil recurrence, inclusive intervention boundary and truthful exposure denominators",async()=>{
 const f=createAgentFeatureFixture(feature),r=await rule(f);await f.run("record 2026-10-22 | Review | Missed an edge case | testing");await f.run("record 2026-10-23 | Review | Boundary day error | testing");
 let out=await pages(f,`review ${r}`);assert.match(out,/BEFORE.*1 recorded incidents; opportunity denominator unknown/);assert.match(out,/AFTER.*1 recorded incidents; opportunity denominator unknown/);assert.match(out,/MISSING FOLLOW-UP/);
 await f.run(`opportunity ${r} | 2026-10-22 | failure | Missed empty input`);await f.run(`opportunity ${r} | 2026-10-23 | success | Boundary list caught an empty input bug`);await f.run(`opportunity ${r} | 2026-10-24 | failure | Missed null path`);
 out=await pages(f,`review ${r}`);assert.match(out,/BEFORE.*failure fraction 1\/1/);assert.match(out,/AFTER.*2 recorded opportunities, 1 successes, 1 failures; reported failure fraction 1\/2/);
 await rule(f);assert.match(await pages(f,`review ${r}`),/Overlapping/);assert.match(await pages(f,"patterns testing"),/MISSING FOLLOW-UP/);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("rule edits stale assessments; all case/rule/opportunity fields can be edited or removed",async()=>{
 const f=createAgentFeatureFixture(feature),r=await rule(f),c=await rid(f,"record 2024-02-29 | Review | Error | testing");await f.run(`link ${c} | ${r}`);await f.run(`opportunity ${r} | 2026-10-24 | success | Evidence`);const o=(await record(f,r)).opportunities[0].id;
 await f.run(`edit ${r} text | Different prevention rule`);assert.match(await pages(f,`review ${r}`),/1 stale opportunities excluded/);await f.run(`opportunity ${r} edit ${o} | 2026-10-25 | failure | Revised evidence`);assert.match(await pages(f,`review ${r}`),/failure fraction 1\/1/);
 await assert.rejects(f.run(`edit ${r} category | other`),/unlink/);await f.run(`unlink ${c} confirm`);
 for(const [id,fields] of [[c,["date","situation","observableError","category"]],[r,["text","category","startDate"]]] as const){for(const field of fields){await f.run(`clear ${id} ${field} confirm`);await f.run(`edit ${id} ${field} | ${field==="date"||field==="startDate"?"2026-10-20":"Corrected"}`);}}
 await f.run(`opportunity ${r} remove ${o} confirm`);assert.equal((await record(f,r)).opportunities.length,0);await f.run(`link ${c} | ${r}`);await f.run(`delete ${r} confirm`);assert.equal((await record(f,c)).preventionRuleId,null);
});
test("opportunity CAS rejects changed rule and preserves unrelated case edits",async()=>{
 let conflict=false,target="";const backend=createMemoryAgentBackend({beforeCompareSet:(key,previous)=>{if(conflict&&previous){conflict=false;const s=JSON.parse(previous),r=s.records.find((r:{id:string})=>r.id===target);r.revision++;if(r.kind==="rule"){r.ruleRevision++;r.text="Changed rule";}else r.observableError="Concurrent error";backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),r=await rule(f),c=await rid(f,"record 2026-10-22 | Situation | Error | testing");
 target=r;conflict=true;await assert.rejects(f.run(`opportunity ${r} | 2026-10-24 | success | Old rule evidence`),/changed/);assert.equal((await record(f,r)).opportunities.length,0);
 target=c;conflict=true;await f.run(`opportunity ${r} | 2026-10-24 | success | Current evidence`);assert.equal((await record(f,r)).opportunities.length,1);assert.equal((await record(f,c)).observableError,"Concurrent error");
});
test("maximum case list reaches last full ID and rule first follow-ups remain reserved at saturation",async()=>{
 const f=createAgentFeatureFixture(feature),rs:string[]=[];for(let i=0;i<12;i++)rs.push(await rule(f));await assert.rejects(rule(f),/quota/);
 for(let i=0;i<60;i++)await f.run(`record 2026-10-22 | S${i} | E | testing`);await assert.rejects(f.run("record 2026-10-22 | S | E | testing"),/quota/);
 const state=await f.store().read<{records:{id:string;kind:string}[]}>("state"),all=await pages(f,"list");for(const r of state!.records)assert.ok(all.includes(r.id));
 let rejected=false;for(const c of state!.records.filter(r=>r.kind==="case")){try{await f.run(`edit ${c.id} observableError | ${'"'.repeat(300)}`);}catch(e){assert.match(String(e),/quota/);rejected=true;break;}}assert.ok(rejected);
 for(const r of rs){await f.run(`opportunity ${r} | 2026-10-23 | failure | ${'"'.repeat(160)}`);const out=await f.run(`export ${r}`);assert.ok(Buffer.byteLength(out)<=24576);await pages(f,`show ${r}`);}
 assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);for(const r of state!.records)await f.run(`delete ${r.id} confirm`);
});
test("exact 60 opportunity cap, clear dates retain unknown buckets and snapshot navigation rejects changed cases",async()=>{
 const f=createAgentFeatureFixture(feature),r=await rule(f);for(let i=0;i<60;i++)await f.run(`opportunity ${r} | 2026-10-23 | success | E${i}`);await assert.rejects(f.run(`opportunity ${r} | 2026-10-23 | success | 61`));
 const c=await rid(f,"record 2026-10-22 | Situation | Error | testing");await f.run(`clear ${c} date confirm`);assert.match(await pages(f,`review ${r}`),/1 undated cases/);
 const first=await f.run(`review ${r}`),next=/Next: \/nobo-help agent mistake-patterns (.*)/.exec(first)![1];await f.run(`edit ${c} observableError | Changed case`);await assert.rejects(f.run(next),/changed/);
});
test("invalid civil labels, unknown outcomes and corrupt state preserve bytes; owner isolation",async()=>{
 const f=createAgentFeatureFixture(feature),r=await rule(f),good=f.backend.data.get(f.key("state"))!;
 for(const cmd of ["record 2026-02-29 | S | E | C",`opportunity ${r} | 2026-10-24 | unknown | E`,`edit ${r} text | ${"漢".repeat(81)}`])await assert.rejects(f.run(cmd));assert.equal(f.backend.data.get(f.key("state")),good);
 for(const bad of ["null","{",good.replace('"version":1','"version":2'),good.replace('"ruleRevision":1','"ruleRevision":2')]){f.backend.data.set(f.key("state"),bad);await assert.rejects(f.run(`delete ${r} confirm`));assert.equal(f.backend.data.get(f.key("state")),bad);}f.backend.data.set(f.key("state"),good);
 for(const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])await assert.rejects(f.run(`show ${r}`,{owner}),/not found/);
});
