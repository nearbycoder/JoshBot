import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import feature from "../lib/agent-features/pantry-plan.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const escape=(s:string)=>s.replaceAll("\\","\\\\").replaceAll("|","\\|");
async function create(f:ReturnType<typeof createAgentFeatureFixture>){const reply=await f.run(feature.example.split("pantry-plan ")[1]);assert.match(reply,/^Saved/);return /recipe-[\da-f-]{36}/.exec(reply)![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}
async function pages(f:ReturnType<typeof createAgentFeatureFixture>,command:string){let body="",first="",n=0;do{const reply=await f.run(command);assert.ok(reply.length<=3500);const h=/\nPage (\d+)\/(\d+)\n/.exec(reply);assert.ok(h,reply);assert.equal(+h[1],++n);const foot=+h[1]<+h[2]?/\nNext: \/nobo-help agent pantry-plan ([^\n]+)$/.exec(reply):null;body+=reply.slice(h.index+h[0].length,foot?.index);command=foot?.[1]??"";first ||= command;assert.ok(n<100);}while(command);return {body,first};}

const token=(reply:string)=>/Plan token (plan-[\da-f-]{36})/.exec(reply)![1];
test("catalog 400g needed minus 0.3kg gives 100g gap, preview consumes only once",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`ingredient ${id} add pasta | 200 | g`);await f.run(`stock ${id} | pasta | 0.3 | kg`);const before=(await record(f,id)).stock;
 const plan=await f.run(`plan ${id} | 4`);assert.match(plan,/400 g needed; 300 g available; 100 g shopping gap/);assert.deepEqual((await record(f,id)).stock,before);
 const t=token(plan);assert.match(await f.run(`use ${id} ${t} confirm`),/^Saved/);const r=await record(f,id);assert.equal(r.stock[0].remaining,"0");assert.equal(r.stock[0].quantity,"0.3");assert.equal(r.preview,null);const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`use ${id} ${t} confirm`),/Stale or already used/);assert.equal(f.backend.data.get(f.key("state")),raw);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("exact normalization combines compatible keys; unknown/incompatible stock is not zero",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`ingredient ${id} add Green  Bean | 0.1 | kg`);await f.run(`ingredient ${id} add green bean | 100 | g`);await f.run(`stock ${id} | GREEN BEAN | 1 | l`);const p=await f.run(`plan ${id} | 4`);assert.match(p,/400 g needed; unknown stock; shopping gap unknown; incompatible/);
 await f.run(`stock ${id} | Green Bean | 0 | g`);assert.match(await f.run(`plan ${id} | 4`),/400 g needed; 0 g available; 400 g shopping gap/);
 await f.run(`ingredient ${id} add egg | 2 | each`);await f.run(`stock ${id} | egg | 10 | eggs`);assert.match(await f.run(`plan ${id} | 4`),/egg \[each\].*unknown stock.*incompatible/);
 await f.run(`stock ${id} | green bean | 0.5 | kg`);assert.equal((await record(f,id)).stock.length,3);assert.match(await f.run(`plan ${id} | 4`),/500 g available; 0 g shopping gap/);
});
test("repeated fractional serving consumption is exact and the denominator cannot grow with repeated plans",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`edit ${id} | baseServings | 3`);await f.run(`ingredient ${id} add spice | 1 | g`);await f.run(`stock ${id} | spice | 1 | g`);
 for(let i=0;i<3;i++){const p=await f.run(`plan ${id} | 1`);assert.match(p,/1\/3 \(exact fraction\) g needed/);if(i===1)assert.match(p,/2\/3 \(exact fraction\) g available/);await f.run(`use ${id} ${token(p)} confirm`);}
 assert.equal((await record(f,id)).stock[0].remaining,"0");
});
test("full field/child edits and removals invalidate stale tokens with byte-preserving refusals",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`ingredient ${id} add A | 1 | g`);await f.run(`stock ${id} | A | 3 | g`);
 for(const action of ["recipe","ingredient","stock","pantry","clear"]){const t=token(await f.run(`plan ${id} | 1`)),r=await record(f,id),cmd=action==="recipe"?`edit ${id} | title | Revised`:action==="ingredient"?`ingredient ${id} edit ${r.ingredients[0].id} | A | 2 | g`:action==="stock"?`stock ${id} | A | 4 | g`:action==="pantry"?`pantry ${id} edit ${r.stock[0].id} | A | 5 | g`:`clear ${id} preview confirm`;assert.match(await f.run(cmd),/^Saved/);const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`use ${id} ${t} confirm`),/Stale or already used/);assert.equal(f.backend.data.get(f.key("state")),raw);}
 const r=await record(f,id);await f.run(`ingredient ${id} remove ${r.ingredients[0].id} confirm`);await f.run(`pantry ${id} remove ${r.stock[0].id} confirm`);await f.run(`clear ${id} title confirm`);await f.run(`clear ${id} baseServings confirm`);assert.equal((await record(f,id)).ingredients.length,0);assert.equal((await record(f,id)).baseServings,null);
 const raw=f.backend.data.get(f.key("state"));for(const cmd of [`stock ${id} | A | -1 | g`,`stock ${id} | A | 1e3 | g`,`stock ${id} | A | 0.0001 | g`,`stock ${id} | A | 1000000.001 | g`,`stock ${id} | A | 1 | [g]`,`plan ${id} | 101`,`edit ${id} | baseServings | 0`,`stock ${id} | A | 1 | g | extra`]){assert.doesNotMatch(await f.run(cmd),/^Saved/);assert.equal(f.backend.data.get(f.key("state")),raw);}
});
test("twenty ingredients/pantry rows have lossless saved and preview pages with stale ceiling guards",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);for(let i=0;i<20;i++){const name=`${i} ${"漢😀".repeat(22)}`;await f.run(`ingredient ${id} add ${name} | 1 | g`);await f.run(`stock ${id} | ${name} | 2 | g`);}
 assert.match(await f.run(`ingredient ${id} add extra | 1 | g`),/Maximum 20/);assert.match(await f.run(`stock ${id} | extra | 1 | g`),/Maximum 20/);
 await f.run(`plan ${id} | 4`);const full=await pages(f,`show ${id}`);assert.deepEqual(JSON.parse(full.body),JSON.parse(await f.run(`export ${id}`)));const p=await pages(f,`preview ${id}`),r=await record(f,id);for(const e of r.ingredients)assert.ok(p.body.includes(e.id));assert.ok(full.first&&p.first);
 const s=await f.store().read<any>("state");s.records[0].revision=999999999;f.backend.data.set(f.key("state"),JSON.stringify(s));const ceiling=await pages(f,`show ${id}`);await f.run(`pantry ${id} remove ${r.stock[0].id} confirm`);assert.match(await f.run(ceiling.first),/stale continuation rejected/);assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});
test("reserved previews and use fit saturated Unicode content; root limit and byte overshoot are atomic",async()=>{
 const f=createAgentFeatureFixture(feature),ids=[];for(let i=0;i<12;i++)ids.push(await create(f));assert.match(await f.run(feature.example.split("pantry-plan ")[1]),/Maximum 12/);let refused=false;
 outer:for(const id of ids){await f.run(`ingredient ${id} add pasta | 200 | g`);await f.run(`stock ${id} | pasta | 0.3 | kg`);for(let i=0;i<19;i++){const raw=f.backend.data.get(f.key("state")),reply=await f.run(`ingredient ${id} add ${i} ${"🧭".repeat(39)} | 1 | each`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),raw);refused=true;break outer;}}}assert.ok(refused);
 const s=await f.store().read<any>("state");for(const r of s.records.filter((r:any)=>r.ingredients.length)){const p=await f.run(`plan ${r.id} | 100`);assert.match(p,/Preview only/);assert.match(await f.run(`use ${r.id} ${token(p)} confirm`),/^Saved/);}assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);
});
test("actual CAS prevents concurrent double-use, stale recipe updates and deletion resurrection; unrelated edits retry",async()=>{
 for(const mode of ["duplicate","edit","delete","unrelated"]){let compete:(()=>Promise<void>)|undefined;const backend=createMemoryAgentBackend({beforeCompareSet:async k=>{if(k.endsWith(":state")&&compete){const c=compete;compete=undefined;await c();}}}),f=createAgentFeatureFixture(feature,{backend}),id=await create(f),other=await create(f);await f.run(`ingredient ${id} add A | 1 | g`);await f.run(`stock ${id} | A | 3 | g`);const t=token(await f.run(`plan ${id} | 2`));let winner="";
 compete=async()=>{assert.match(await f.run(mode==="duplicate"?`use ${id} ${t} confirm`:mode==="delete"?`delete ${id} confirm`:`edit ${mode==="unrelated"?other:id} | title | Winner`),/^(Saved|Deleted)/);winner=backend.data.get(f.key("state"))!;};const reply=await f.run(`use ${id} ${t} confirm`);assert.equal(backend.calls.conflicts,1);if(mode==="unrelated"){assert.match(reply,/^Saved/);assert.equal((await record(f,other)).title,"Winner");}else{assert.match(reply,/changed before|not found/);assert.equal(backend.data.get(f.key("state")),winner);}}
});
test("strict persisted numeric strings/arrays, invalid preview and tenant boundaries preserve raw state",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`ingredient ${id} add pasta | 200 | g`);await f.run(`stock ${id} | pasta | 0.3 | kg`);await f.run(`plan ${id} | 4`);const original=await f.store().read<any>("state");
 const bads=[(r:any)=>r.baseServings=[2],(r:any)=>r.ingredients[0].unit=["g"],(r:any)=>r.ingredients[0].quantity=200,(r:any)=>r.stock[0].remaining="-1",(r:any)=>r.preview.servings=[4],(r:any)=>r.preview.sourceStamp="f".repeat(64)];for(const bad of bads){const s=structuredClone(original);bad(s.records[0]);const raw=JSON.stringify(s);f.backend.data.set(f.key("state"),raw);for(const cmd of ["list",`preview ${id}`,`delete ${id} confirm`]){assert.match(await f.run(cmd),/could not be read safely.*preserved/);assert.equal(f.backend.data.get(f.key("state")),raw);}}
 for(const raw of ["null","{broken"]){f.backend.data.set(f.key("state"),raw);await f.run(`delete ${id} confirm`);assert.equal(f.backend.data.get(f.key("state")),raw);}f.backend.data.set(f.key("state"),JSON.stringify(original));for(const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])assert.match(await f.run(`show ${id}`,{owner}),/not found/);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("metadata is exact catalog literal and help fits",()=>{const e=JSON.parse(readFileSync(new URL("../docs/personal-agent-50-catalog.json",import.meta.url),"utf8")).find((x:any)=>x.id===feature.id);for(const k of ["id","title","description","group","keywords","example","resourceBudgets"] as const)assert.deepEqual(feature[k],e[k]);assert.ok(feature.help.length<=3500);});

test("revision ceiling does not permit consumption writes or token cycling; explicit preview/root removal still works",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`ingredient ${id} add A | 1 | g`);await f.run(`stock ${id} | A | 3 | g`);const t=token(await f.run(`plan ${id} | 2`)),s=await f.store().read<any>("state");s.records[0].revision=999999999;f.backend.data.set(f.key("state"),JSON.stringify(s));const raw=f.backend.data.get(f.key("state"));
 for(const cmd of [`use ${id} ${t} confirm`,`plan ${id} | 2`]){assert.match(await f.run(cmd),/Revision limit reached/);assert.equal(f.backend.data.get(f.key("state")),raw);}assert.match(await f.run(`clear ${id} preview confirm`),/^Saved/);assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});
