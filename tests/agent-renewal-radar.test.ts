import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import feature from "../lib/agent-features/renewal-radar.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const escape=(s:string)=>s.replaceAll("\\","\\\\").replaceAll("|","\\|");
async function create(f:ReturnType<typeof createAgentFeatureFixture>){const reply=await f.run(feature.example.split("renewal-radar ")[1]);assert.match(reply,/^Saved/);return /renewal-[\da-f-]{36}/.exec(reply)![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}
async function pages(f:ReturnType<typeof createAgentFeatureFixture>,command:string){let body="",first="",n=0;do{const reply=await f.run(command);assert.ok(reply.length<=3500);const h=/\nPage (\d+)\/(\d+)\n/.exec(reply);assert.ok(h,reply);assert.equal(+h[1],++n);const foot=+h[1]<+h[2]?/\nNext: \/nobo-help agent renewal-radar ([^\n]+)$/.exec(reply):null;body+=reply.slice(h.index+h[0].length,foot?.index);command=foot?.[1]??"";first ||= command;assert.ok(n<100);}while(command);return {body,first};}

test("catalog arithmetic, explicit local decision/reschedule and exact minor-unit rounding",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 assert.match(await f.run("upcoming 60"),/2026-11-17/);assert.match(await f.run("costs"),/USD 10.00\/month equivalent; USD 120.00\/year/);
 assert.match(await f.run(`review ${id} | keep | Need it for the next project`),/^Saved/);assert.equal((await record(f,id)).status,"keep");
 await f.run(`reschedule ${id} | 2027-12-01 | Confirmed renewal manually`);assert.equal((await record(f,id)).renewalDate,"2027-12-01");
 await f.run(`edit ${id} | amount | 0.01`);assert.match(await f.run("costs"),/monthly 1\/12/);assert.match(await f.run("costs"),/USD 0.00\/month/);
 await f.run(`edit ${id} | billingUnit | month`);await f.run(`edit ${id} | interval | 2`);assert.match(await f.run("costs"),/USD 0.01\/month/);
 const second=await create(f);await f.run(`edit ${second} | currency | EUR`);const costs=await f.run("costs");assert.match(costs,/EUR 10.00/);assert.match(costs,/no conversion or cross-currency totals/);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("every entered field is editable/removable; malformed inputs do not change bytes",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),values={title:"A | B \\ <@UOTHER>",renewalDate:"2028-02-29",noticeDays:"366",amount:"1000000.00",currency:"CAD",billingUnit:"month",interval:"120",termsNote:"Terms\nexplicit",reviewNote:"Decision",confirmationNote:"Manual"};
 for(const [field,value]of Object.entries(values)){assert.match(await f.run(`edit ${id} | ${field} | ${escape(value)}`),/^Saved/);const r=await record(f,id);assert.equal(r[{amount:"amountMinorUnits",currency:"currencyLabel"}[field]??field],field==="amount"?100000000:["noticeDays","interval"].includes(field)?+value:value);assert.match(await f.run(`clear ${id} ${field} confirm`),/^Saved/);}
 await f.run(`clear ${id} status confirm`);assert.match(await f.run("costs"),/Cost unknown/);assert.match(await f.run("upcoming 60"),/unknown timing/);
 const raw=f.backend.data.get(f.key("state"));for(const command of [`edit ${id} | amount | 1e3`,`edit ${id} | amount | 1000000.01`,`edit ${id} | amount | 1.001`,`edit ${id} | noticeDays | 367`,`edit ${id} | interval | 0`,`edit ${id} | renewalDate | 2026-02-30`,`review ${id} | cancel | reason`,`reschedule ${id} | 2027-12-01 | `,`edit ${id} | termsNote | bad\\q`,`delete ${id} maybe`]){assert.doesNotMatch(await f.run(command),/^Saved|^Deleted/);assert.equal(f.backend.data.get(f.key("state")),raw);}
 assert.match(await f.run(`delete ${id}`),/Delete/);assert.equal(f.backend.data.get(f.key("state")),raw);assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});
test("forty roots, full detail reconstruction, Unicode byte limit and stamped aggregate continuations",async()=>{
 const f=createAgentFeatureFixture(feature),ids=[];for(let i=0;i<40;i++)ids.push(await create(f));assert.match(await f.run(feature.example.split("renewal-radar ")[1]),/Maximum 40/);
 const id=ids[39],value="漢😀\"\\\n".repeat(80);assert.ok(Buffer.byteLength(value)<=1000);await f.run(`edit ${id} | termsNote | ${escape(value)}`);
 const full=await pages(f,`show ${id}`);assert.deepEqual(JSON.parse(full.body),JSON.parse(await f.run(`export ${id}`)));assert.equal((await record(f,id)).termsNote,value.trim());
 assert.match(await f.run("list 4"),new RegExp(id));const p=await pages(f,"costs");assert.ok(p.body.includes(ids[39]));assert.ok(p.first);
 await f.run(`edit ${ids[0]} | title | Updated`);assert.match(await f.run(p.first),/stale continuation rejected/);
 const raw=f.backend.data.get(f.key("state"));assert.doesNotMatch(await f.run(`edit ${id} | termsNote | ${"界".repeat(334)}`),/^Saved/);assert.equal(f.backend.data.get(f.key("state")),raw);
});
test("reserved lifecycle fits saturated accepted content and removals work at revision ceiling",async()=>{
 const f=createAgentFeatureFixture(feature),ids=[];for(let i=0;i<35;i++)ids.push(await create(f));let refused=false;
 for(const id of ids){const raw=f.backend.data.get(f.key("state"));const reply=await f.run(`edit ${id} | termsNote | ${"界".repeat(333)}`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),raw);refused=true;break;}}assert.ok(refused);
 for(const id of ids){assert.match(await f.run(`review ${id} | change | ${"x\n".repeat(79)}xx`),/^Saved/);assert.match(await f.run(`reschedule ${id} | 2028-12-01 | ${"y\n".repeat(79)}yy`),/^Saved/);}assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);
 const s=await f.store().read<any>("state");s.records[0].revision=999999999;f.backend.data.set(f.key("state"),JSON.stringify(s));assert.match(await f.run(`delete ${ids[0]} confirm`),/^Deleted/);
});
test("real CAS retries reject same-record edit/delete races and preserve unrelated winners",async()=>{
 for(const mode of ["edit","delete","unrelated"]){let compete:(()=>Promise<void>)|undefined;const backend=createMemoryAgentBackend({beforeCompareSet:async k=>{if(k.endsWith(":state")&&compete){const c=compete;compete=undefined;await c();}}}),f=createAgentFeatureFixture(feature,{backend}),id=await create(f),other=await create(f);let winner="";
 compete=async()=>{assert.match(await f.run(mode==="delete"?`delete ${id} confirm`:`review ${mode==="unrelated"?other:id} | change | newer`),/^(Saved|Deleted)/);winner=backend.data.get(f.key("state"))!;};
 const reply=await f.run(`review ${id} | keep | older`);assert.equal(backend.calls.conflicts,1);if(mode==="unrelated"){assert.match(reply,/^Saved/);assert.equal((await record(f,other)).status,"change");}else{assert.match(reply,/changed before|not found/);assert.equal(backend.data.get(f.key("state")),winner);}}
});
test("malformed persisted enums, date/number shapes and null preserve exact raw state; isolated owners",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),original=await f.store().read<any>("state");
 for(const [field,value]of [["status",["keep"]],["billingUnit",["year"]],["noticeDays","14"],["currencyLabel",["USD"]],["renewalDate","2026-02-30"],["amountMinorUnits",-1]] as const){const s=structuredClone(original);s.records[0][field]=value;const raw=JSON.stringify(s);f.backend.data.set(f.key("state"),raw);for(const cmd of ["list",`show ${id}`,`review ${id} | keep | reason`,`delete ${id} confirm`]){assert.match(await f.run(cmd),/could not be read safely.*preserved/);assert.equal(f.backend.data.get(f.key("state")),raw);}}
 for(const raw of ["null","{broken"]){f.backend.data.set(f.key("state"),raw);await f.run(`delete ${id} confirm`);assert.equal(f.backend.data.get(f.key("state")),raw);}f.backend.data.set(f.key("state"),JSON.stringify(original));
 for(const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])assert.match(await f.run(`show ${id}`,{owner}),/not found/);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("cancellation during read never starts mutation",async()=>{
 let pause=false;const entered=deferred<void>(),gate=deferred<void>(),backend=createMemoryAgentBackend({beforeGet:async k=>{if(pause&&k.endsWith(":state")){entered.resolve();await gate.promise;}}}),f=createAgentFeatureFixture(feature,{backend}),id=await create(f),raw=backend.data.get(f.key("state")),abort=new AbortController();pause=true;
 const pending=f.run(`review ${id} | change | reason`,{signal:abort.signal});const rejected=assert.rejects(pending,/abort/i);await entered.promise;abort.abort();gate.resolve();await rejected;assert.equal(backend.data.get(f.key("state")),raw);
});
test("literal metadata matches exact catalog and help is bounded",()=>{const e=JSON.parse(readFileSync(new URL("../docs/personal-agent-50-catalog.json",import.meta.url),"utf8")).find((x:any)=>x.id===feature.id);for(const k of ["id","title","description","group","keywords","example","resourceBudgets"] as const)assert.deepEqual(feature[k],e[k]);assert.ok(feature.help.length<=3500);});
