import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/practice-lab.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const rid=async(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string)=>(await f.run(cmd)).match(/[\da-f-]{36}/)![0];
const create=async(f:ReturnType<typeof createAgentFeatureFixture>)=>rid(f,"create Explain a technical tradeoff in two minutes");
const dim=async(f:ReturnType<typeof createAgentFeatureFixture>,id:string,label="Clarity",max=5)=>rid(f,`rubric ${id} add ${label} | ${max} | State the decision and one reason`);
const attempt=async(f:ReturnType<typeof createAgentFeatureFixture>,id:string)=>rid(f,`attempt ${id} | I would use a queue because it separates request time from processing.`);
const record=async(f:ReturnType<typeof createAgentFeatureFixture>,id:string)=>JSON.parse(await f.run(`export ${id}`)).record;
async function prepare(f:ReturnType<typeof createAgentFeatureFixture>){const id=await create(f),x=await dim(f,id),a=await attempt(f,id);return{id,x,a};}
async function pages(f:ReturnType<typeof createAgentFeatureFixture>,cmd:string){let all="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500&&reply.isWellFormed());all+=reply;cmd=/Next: \/nobo-help agent practice-lab ((?:show|progress|next) \S+ page \d+ rev \d+)/.exec(reply)?.[1]??"";assert.ok(++n<60);}while(cmd);return all;}

test("catalog practice compares completed same-rubric attempts and selects lowest ratio for unequal maxima",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),clarity=await dim(f,id),depth=await dim(f,id,"Depth",20),a=await attempt(f,id);
 await f.run(`score ${id} ${a} | ${clarity} | 3 | Reason clear; tradeoff missing`);let out=await pages(f,`progress ${id}`);assert.match(out,/INCOMPLETE/);assert.match(out,/Missing current scores:.*Depth/);assert.match(out,/unknown, never zero/);
 await f.run(`score ${id} ${a} | ${depth} | 8 | Only one alternative considered`);out=await pages(f,`progress ${id}`);assert.match(out,new RegExp(`Lowest relative dimension : ${depth} 8/20`));assert.match(await pages(f,`next ${id}`),new RegExp(`Focus ${depth}: Depth`));
 const b=await attempt(f,id);await f.run(`score ${id} ${b} | ${clarity} | 4 | Clearer`);assert.doesNotMatch(await pages(f,`progress ${id}`),/Same-rubric comparison/);await f.run(`score ${id} ${b} | ${depth} | 12 | More alternatives`);assert.match(await pages(f,`progress ${id}`),/8\/20 → 12\/20; user-score change 4/);
 await f.run(`rubric ${id} edit ${depth} | Depth | 20 | Explain three alternatives`);const c=await attempt(f,id);await f.run(`score ${id} ${c} | ${clarity} | 5 | Clear`);await f.run(`score ${id} ${c} | ${depth} | 20 | Three alternatives`);out=await pages(f,`progress ${id}`);assert.equal((out.match(/Same-rubric comparison/g)??[]).length,1);assert.match(out,/HISTORICAL; cannot assess current/);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("response edits preserve stale scoring evidence and all fields have edit/removal paths",async()=>{
 const f=createAgentFeatureFixture(feature),{id,x,a}=await prepare(f);await f.run(`score ${id} ${a} | ${x} | 3 | Original evidence`);await f.run(`attempt ${id} edit ${a} | Changed response`);let out=await pages(f,`progress ${id}`);assert.match(out,/INCOMPLETE/);assert.match(out,/STALE earlier response/);assert.match(out,/Original evidence/);
 await f.run(`score ${id} ${a} | ${x} | 4 | New evidence`);await f.run(`reopen ${id} ${a} confirm`);assert.match(await pages(f,`progress ${id}`),/INCOMPLETE/);await f.run(`unscore ${id} ${a} ${x} confirm`);await f.run(`attempt ${id} clear ${a} response confirm`);await f.run(`attempt ${id} edit ${a} | New response`);
 for(const field of ["label","maxScore","description"])await f.run(`rubric ${id} clear ${x} ${field} confirm`);await f.run(`rubric ${id} edit ${x} | New label | 10 | New observable criterion`);await f.run(`clear ${id} task confirm`);await f.run(`edit ${id} task | New task`);await f.run(`rubric ${id} remove ${x} confirm`);
 assert.equal((await record(f,id)).attempts[0].rubric.task,"Explain a technical tradeoff in two minutes");await f.run(`attempt ${id} remove ${a} confirm`);assert.equal((await record(f,id)).attempts.length,0);await f.run(`delete ${id} confirm`);
});
test("score CAS rejects changed response and safely retries across unrelated drills",async()=>{
 let conflict=false,target="";const backend=createMemoryAgentBackend({beforeCompareSet:(key,previous)=>{if(conflict&&previous){conflict=false;const s=JSON.parse(previous),d=s.records.find((d:{id:string})=>d.id===target);d.revision++;if(d.attempts.length){d.attempts[0].revision++;d.attempts[0].responseRevision++;d.attempts[0].response="Concurrent response";}else{d.rubricVersion++;d.task="Concurrent task";}backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),{id,x,a}=await prepare(f),other=await create(f);
 target=id;conflict=true;await assert.rejects(f.run(`score ${id} ${a} | ${x} | 5 | Obsolete evidence`),/changed/);assert.equal((await record(f,id)).attempts[0].scores.length,0);
 target=other;conflict=true;await f.run(`score ${id} ${a} | ${x} | 2 | Current evidence`);assert.equal((await record(f,other)).task,"Concurrent task");assert.equal(backend.calls.conflicts,2);
});
test("optional feedback binds exact snapshot dimension/rubric and response quotes, never scores",async()=>{
 let mode="valid";const f=createAgentFeatureFixture(feature,{services:{generate:async({input,instructions})=>{assert.ok(Buffer.byteLength(input)<=16000&&Buffer.byteLength(instructions)<=4000);const r=JSON.parse(input),d=r.dimensions[0],item={dimensionId:d.id,rubricQuote:d.description,responseQuote:"I would use a queue",note:"Describe the tradeoff"};if(mode==="id")item.dimensionId="00000000-0000-4000-8000-000000000000";if(mode==="rubric")item.rubricQuote="Made up";if(mode==="response")item.responseQuote="Not the response";if(mode==="huge")return"x".repeat(4001);if(mode==="refusal")return"Cannot provide feedback";if(mode==="extra")return JSON.stringify({feedback:[{...item,score:5}]});return JSON.stringify({feedback:[item]});}}});
 const{id,a}=await prepare(f),before=f.backend.data.get(f.key("state"));assert.match(await f.run(`feedback ${id} ${a}`),/UNSAVED MODEL OPINIONS/);for(mode of ["id","rubric","response","huge","refusal","extra"])assert.match(await f.run(`feedback ${id} ${a}`),/invalid or oversized complete/);assert.equal(f.backend.data.get(f.key("state")),before);assert.deepEqual(f.calls,{generate:7,search:0,readContext:0});
});
test("complete bounded model output rejects oversized rendering without fake continuation",async()=>{
 const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const r=JSON.parse(input);return JSON.stringify({feedback:r.dimensions.map((d:{id:string;description:string})=>({dimensionId:d.id,rubricQuote:d.description,responseQuote:r.response,note:"n".repeat(350)}))});}}}),id=await create(f);for(let i=0;i<6;i++)await dim(f,id,`D${i}`);const a=await attempt(f,id);assert.match(await f.run(`feedback ${id} ${a}`),/oversized complete/);assert.equal(f.calls.generate,1);
});
test("feedback is discarded after edit/delete/abort and unavailable providers do not retry",async()=>{
 for(const action of ["edit","delete","abort"]){const entered=deferred<void>(),gate=deferred<void>(),controller=new AbortController(),f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();await gate.promise;const r=JSON.parse(input),d=r.dimensions[0];return JSON.stringify({feedback:[{dimensionId:d.id,rubricQuote:d.description,responseQuote:"I would",note:"Opinion"}]});}}}),{id,a}=await prepare(f),pending=f.run(`feedback ${id} ${a}`,{signal:controller.signal});await entered.promise;
 if(action==="abort"){const rejected=assert.rejects(pending);controller.abort();gate.resolve();await rejected;}else{await f.run(action==="edit"?`attempt ${id} edit ${a} | New response`:`delete ${id} confirm`);gate.resolve();assert.match(await pending,/stale result discarded/);}assert.equal(f.calls.generate,1);}
 const f=createAgentFeatureFixture(feature),{id,a}=await prepare(f);assert.match(await f.run(`feedback ${id} ${a}`),/unavailable/);assert.equal(f.calls.generate,1);
});
test("count limits and dynamic reservations allow every remaining score and maximum response at saturation",async()=>{
 const f=createAgentFeatureFixture(feature),ids:string[]=[];for(let i=0;i<10;i++)ids.push(await create(f));await assert.rejects(create(f),/Ten/);
 let rejected=false;for(const id of ids){try{await dim(f,id);}catch(e){assert.match(String(e),/quota/);rejected=true;break;}}
 for(const id of ids){const d=await record(f,id);if(d.dimensions.length)await attempt(f,id);}
 for(const id of ids){let d=await record(f,id);if(!d.dimensions.length)continue;for(let i=d.attempts.length;i<6;i++){try{await attempt(f,id);}catch(e){assert.match(String(e),/quota/);rejected=true;break;}}}
 assert.ok(rejected);
 for(const id of ids){const d=await record(f,id);for(const a of d.attempts){await f.run(`attempt ${id} edit ${a.id} | ${'"'.repeat(1200)}`);for(const x of a.rubric.dimensions)await f.run(`score ${id} ${a.id} | ${x.id} | ${x.maxScore} | ${'"'.repeat(160)}`);}const out=await f.run(`export ${id}`);assert.ok(Buffer.byteLength(out)<=24576);const all=await pages(f,`show ${id}`);for(const a of (await record(f,id)).attempts)assert.ok(all.includes(a.id));}
 assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);for(const id of ids)await f.run(`delete ${id} confirm`);
 const g=createAgentFeatureFixture(feature),id=await create(g);for(let i=0;i<6;i++)await dim(g,id,`Dimension ${i}`);await assert.rejects(dim(g,id),/six/);for(let i=0;i<6;i++){try{await attempt(g,id);}catch(e){assert.match(String(e),/quota/);break;}}
});
test("six small attempts, invalid score maxima, snapshot corruption and tenant isolation",async()=>{
 const f=createAgentFeatureFixture(feature),{id,x}=await prepare(f);for(let i=1;i<6;i++)await attempt(f,id);await assert.rejects(attempt(f,id),/six/);const d=await record(f,id),a=d.attempts[0].id,good=f.backend.data.get(f.key("state"))!;
 for(const cmd of [`score ${id} ${a} | ${x} | 6 | Too high`,`score ${id} ${a} | ${x} | -1 | Negative`,`attempt ${id} edit ${a} | ${"漢".repeat(401)}`])await assert.rejects(f.run(cmd));assert.equal(f.backend.data.get(f.key("state")),good);
 const corrupt=JSON.parse(good);corrupt.records[0].attempts[0].rubric.task="Changed snapshot";
 for(const bad of ["null","{",good.replace('"version":1','"version":2'),JSON.stringify(corrupt)]){f.backend.data.set(f.key("state"),bad);await assert.rejects(f.run(`delete ${id} confirm`));assert.equal(f.backend.data.get(f.key("state")),bad);}f.backend.data.set(f.key("state"),good);
 for(const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])await assert.rejects(f.run(`show ${id}`,{owner}),/not found/);
});
