import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import feature from "../lib/agent-features/home-maintenance.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const escape=(s:string)=>s.replaceAll("\\","\\\\").replaceAll("|","\\|");
async function create(f:ReturnType<typeof createAgentFeatureFixture>){const reply=await f.run(feature.example.split("home-maintenance ")[1]);assert.match(reply,/^Saved/);return /asset-[\da-f-]{36}/.exec(reply)![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}
async function pages(f:ReturnType<typeof createAgentFeatureFixture>,command:string){let body="",first="",n=0;do{const reply=await f.run(command);assert.ok(reply.length<=3500);const h=/\nPage (\d+)\/(\d+)\n/.exec(reply);assert.ok(h,reply);assert.equal(+h[1],++n);const foot=+h[1]<+h[2]?/\nNext: \/nobo-help agent home-maintenance ([^\n]+)$/.exec(reply):null;body+=reply.slice(h.index+h[0].length,foot?.index);command=foot?.[1]??"";first ||= command;assert.ok(n<100);}while(command);return {body,first};}

test("catalog civil-day service example and exact history correction/removal",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`service ${id} | 2026-07-01 | none | Replaced filter`);let due=await f.run("due 2026-10-22");assert.match(due,/2026-09-29/);assert.match(due,/23 civil days overdue/);
 await f.run(`service ${id} | 2026-10-22 | none | Replaced filter today`);const r=await record(f,id);assert.equal(r.services.length,2);assert.match(await f.run(`history ${id}`),/Replaced filter today/);
 await f.run(`history ${id} edit ${r.services[1].id} | 2026-10-20 | none | Correct date | Checked receipt`);assert.match(await f.run("due 2026-10-22"),/2027-01-18/);
 await f.run(`history ${id} remove ${r.services[1].id} confirm`);assert.match(await f.run("due 2026-10-22"),/2026-09-29/);assert.equal((await record(f,id)).services.length,1);
 await f.run(`history ${id} clear ${r.services[0].id} note confirm`);assert.equal((await record(f,id)).services[0].note,"");assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("either threshold suffices; required missing baselines stay unknown and meters require explicit corrections",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`edit ${id} | intervalUsage | 100`);assert.match(await f.run("due 2026-10-22"),/Status: unknown/);
 await f.run(`service ${id} | 2026-07-01 | 1000 | Service`);assert.match(await f.run("due 2026-10-22"),/Status: due/);
 await f.run(`meter ${id} | 1100`);assert.match(await f.run("due 2026-07-02"),/Status: due/);assert.match(await f.run("due 2026-07-02"),/Usage threshold 1100/);
 const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`meter ${id} | 1099`),/Decreasing meter requires/);assert.equal(f.backend.data.get(f.key("state")),raw);
 assert.match(await f.run(`correct ${id} | 999 | Meter replaced`),/^Saved/);assert.match(await f.run("due 2026-07-02"),/Status: unknown/);assert.match(await f.run("due 2026-10-22"),/other threshold unknown/);
 await f.run(`clear ${id} intervalDays confirm`);assert.match(await f.run("due 2026-10-22"),/Status: unknown/);await f.run(`clear ${id} latestMeter confirm`);assert.equal((await record(f,id)).latestMeter,null);
});
test("exact fields, strict bounded decimals and destructive confirmations preserve raw values",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 for(const [key,value]of Object.entries({title:"A | B \\ 🧭",manual:"Manual\nentered",intervalDays:"3650",intervalUsage:"0.001"})){assert.match(await f.run(`edit ${id} | ${key} | ${escape(value)}`),/^Saved/);assert.match(await f.run(`clear ${id} ${key} confirm`),/^Saved/);}
 const raw=f.backend.data.get(f.key("state"));for(const cmd of [`edit ${id} | intervalDays | 3651`,`edit ${id} | intervalDays | 0`,`edit ${id} | intervalUsage | 0`,`meter ${id} | 1e3`,`meter ${id} | 0.0001`,`meter ${id} | -1`,`service ${id} | 2026-02-30 | none | x`,`service ${id} | 2026-10-23 | none | x`,`clear ${id} manual`,`edit ${id} | manual | bad\\q`]){assert.doesNotMatch(await f.run(cmd),/^Saved/);assert.equal(f.backend.data.get(f.key("state")),raw);}
 await f.run(`delete ${id}`);assert.equal(f.backend.data.get(f.key("state")),raw);assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});
test("all ten services remain retrievable with stamped exact JSON pages and final history entry",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`edit ${id} | manual | ${"漢😀".repeat(140)}`);
 for(let i=0;i<10;i++)assert.match(await f.run(`service ${id} | 2026-10-${String(i+1).padStart(2,"0")} | none | ${"x".repeat(160)}`),/^Saved/);
 const r=await record(f,id);assert.equal(r.services.length,10);assert.match(await f.run(`service ${id} | 2026-10-22 | none | 11`),/Maximum 10/);
 const full=await pages(f,`show ${id}`);assert.deepEqual(JSON.parse(full.body),JSON.parse(await f.run(`export ${id}`)));assert.ok(full.first);const history=await pages(f,`history ${id}`);assert.ok(history.body.includes(r.services[9].id));
 const state=await f.store().read<any>("state");state.records[0].revision=999999999;f.backend.data.set(f.key("state"),JSON.stringify(state));const saturated=await pages(f,`show ${id}`);await f.run(`history ${id} remove ${r.services[0].id} confirm`);assert.match(await f.run(saturated.first),/stale continuation rejected/);assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});
test("worst remaining history reserve permits every service after content admission saturates",async()=>{
 const f=createAgentFeatureFixture(feature),ids:string[]=[];let refused=false;
 for(let i=0;i<30;i++){const raw=f.backend.data.get(f.key("state")),reply=await f.run(`add ${"界".repeat(53)} | ${"🧭".repeat(250)} | 90 | 100`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),raw);refused=true;break;}ids.push(/asset-[\da-f-]{36}/.exec(reply)![0]);}assert.ok(refused);assert.ok(ids.length>1);
 for(const id of ids)for(let i=0;i<10;i++)assert.match(await f.run(`service ${id} | 2026-10-${String(i+1).padStart(2,"0")} | ${1000000000} | ${"x\n".repeat(79)}xx`),/^Saved/);
 assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);assert.match(await f.run(`delete ${ids[0]} confirm`),/^Deleted/);
});
test("actual CAS detects service/edit/deletion conflicts and retries unrelated assets",async()=>{
 for(const mode of ["service","delete","unrelated"]){let compete:(()=>Promise<void>)|undefined;const backend=createMemoryAgentBackend({beforeCompareSet:async k=>{if(k.endsWith(":state")&&compete){const c=compete;compete=undefined;await c();}}}),f=createAgentFeatureFixture(feature,{backend}),id=await create(f),other=await create(f);let winner="";
 compete=async()=>{await f.run(mode==="delete"?`delete ${id} confirm`:`service ${mode==="unrelated"?other:id} | 2026-10-22 | none | Newer`);winner=backend.data.get(f.key("state"))!;};const reply=await f.run(`service ${id} | 2026-07-01 | none | Older`);assert.equal(backend.calls.conflicts,1);if(mode==="unrelated"){assert.match(reply,/^Saved/);assert.equal((await record(f,other)).services[0].note,"Newer");}else{assert.match(reply,/changed before|not found/);assert.equal(backend.data.get(f.key("state")),winner);}}
});
test("corrupt shapes and raw null stay untouched, separate owner/workspace cannot read",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),original=await f.store().read<any>("state");for(const [key,bad] of [["intervalDays",[90]],["intervalUsage",[100]],["manual",["Manual"]],["latestMeter","3"],["services",{}]]){const s=structuredClone(original);s.records[0][key as string]=bad;const raw=JSON.stringify(s);f.backend.data.set(f.key("state"),raw);for(const cmd of ["list",`history ${id}`,`delete ${id} confirm`]){assert.match(await f.run(cmd),/could not be read safely.*preserved/);assert.equal(f.backend.data.get(f.key("state")),raw);}}
 for(const raw of ["null","{broken"]){f.backend.data.set(f.key("state"),raw);await f.run(`delete ${id} confirm`);assert.equal(f.backend.data.get(f.key("state")),raw);}f.backend.data.set(f.key("state"),JSON.stringify(original));for(const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])assert.match(await f.run(`show ${id}`,{owner}),/not found/);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("metadata exact catalog parity and bounded grammar",()=>{const e=JSON.parse(readFileSync(new URL("../docs/personal-agent-50-catalog.json",import.meta.url),"utf8")).find((x:any)=>x.id===feature.id);for(const k of ["id","title","description","group","keywords","example","resourceBudgets"] as const)assert.deepEqual(feature[k],e[k]);assert.ok(feature.help.length<=3500);});

test("explicit meter correction establishes the next monotonic sequence and its reason follows the service baseline",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`edit ${id} | intervalUsage | 100`);await f.run(`service ${id} | 2026-07-01 | 1000 | Old meter`);
 assert.match(await f.run(`correct ${id} | 500 | Meter replaced and reading confirmed`),/^Saved/);
 assert.match(await f.run(`meter ${id} | 600`),/^Saved/);
 assert.equal((await record(f,id)).latestReason,"Meter replaced and reading confirmed");
 assert.match(await f.run(`service ${id} | 2026-10-22 | 650 | New meter service`),/^Saved/);
 const r=await record(f,id);assert.equal(r.services[1].correctionReason,"Meter replaced and reading confirmed");assert.equal(r.latestReason,"");
 assert.match(await f.run(`meter ${id} | 700`),/^Saved/);assert.match(await f.run("due 2026-10-22"),/Usage threshold 750; latest 700; 50 usage units remaining/);
 const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`meter ${id} | 699`),/Decreasing meter requires/);assert.equal(f.backend.data.get(f.key("state")),raw);
});
