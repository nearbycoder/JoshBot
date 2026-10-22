import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/curriculum.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const create = async (f: ReturnType<typeof createAgentFeatureFixture>, settings = "3 | 25") => (await f.run(`create Learn SQL joins | ${settings}`)).match(/[\da-f-]{36}/)![0];
const unit = async (f: ReturnType<typeof createAgentFeatureFixture>, c: string, name: string, sessions = 2) => (await f.run(`unit ${c} add ${name} | ${sessions} | Explain ${name} with a worked example`)).match(/[\da-f-]{36}/)![0];
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, c: string) => JSON.parse(await f.run(`export ${c}`)).record;
async function pages(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) { let all = "", n = 0; do { const reply = await f.run(cmd); assert.ok(reply.length <= 3500 && reply.isWellFormed()); all += reply; cmd = /Next: \/nobo-help agent curriculum (.*)/.exec(reply)?.[1] ?? ""; assert.ok(++n < 60); } while (cmd); return all; }

test("catalog prerequisites, shared closure and evidence unlock without inferred mastery", async () => {
 const f = createAgentFeatureFixture(feature), c = await create(f), inner = await unit(f,c,"Inner joins"), left = await unit(f,c,"Left joins"), outer = await unit(f,c,"Outer joins");
 await f.run(`requires ${c} ${left} | ${inner}`); await f.run(`requires ${c} ${outer} | ${inner},${left}`);
 const p = await pages(f,`plan ${c}`); assert.match(p,/6\/36 whole sessions allocated, 150 minutes/); assert.match(p,/BLOCKED/); assert.match(p,/CONDITIONAL/); assert.equal(p.match(new RegExp(`Unit ${inner}:`,"g"))?.length,1);
 await assert.rejects(f.run(`demonstrate ${c} ${left} | Guessed`),/Blocked/);
 await f.run(`demonstrate ${c} ${inner} | Explained matching rows correctly`); assert.match(await pages(f,`plan ${c}`),new RegExp(`Next eligible unit: ${left}`));
 await f.run(`demonstrate ${c} ${left} | Explained unmatched left rows`); await f.run(`demonstrate ${c} ${outer} | Explained all unmatched rows`);
 await f.run(`unit ${c} edit ${inner} | Inner joins | 2 | Explain duplicate matches`);
 const stale = await pages(f,`plan ${c}`); assert.equal((stale.match(/Evidence \(STALE\)/g)??[]).length,3); assert.match(stale,/Explained matching rows correctly/);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("cycle/unknown edges rejected, 12-week horizon bounds whole sessions, unknown differs from blocked",async()=>{
 const f=createAgentFeatureFixture(feature),c=await create(f,"1 | 30"),a=await unit(f,c,"A",13),b=await unit(f,c,"B",3);
 await f.run(`requires ${c} ${b} | ${a}`); const before=f.backend.data.get(f.key("state"));
 await assert.rejects(f.run(`requires ${c} ${a} | ${b}`),/cycle/); assert.equal(f.backend.data.get(f.key("state")),before);
 await assert.rejects(f.run(`requires ${c} ${a} | 00000000-0000-4000-8000-000000000000`),/Missing/);
 const p=await pages(f,`plan ${c}`); assert.match(p,/12\/12 whole sessions allocated, 360 minutes; 4 known sessions unallocated/); assert.doesNotMatch(p,/week 13/);
 await f.run(`unit ${c} clear ${a} readinessTest confirm`); assert.match(await pages(f,`plan ${c}`),/UNKNOWN/); await assert.rejects(f.run(`demonstrate ${c} ${a} | Evidence`),/Unknown/);
});
test("all fields and evidence can be edited, removed and reopened with dependent invalidation",async()=>{
 const f=createAgentFeatureFixture(feature),c=await create(f),a=await unit(f,c,"A"),b=await unit(f,c,"B");await f.run(`requires ${c} ${b} | ${a}`);
 await f.run(`demonstrate ${c} ${a} | First evidence`);await f.run(`evidence ${c} ${a} | 2024-02-29 | Corrected evidence`);assert.equal((await record(f,c)).units[0].demonstration.date,"2024-02-29");
 await f.run(`demonstrate ${c} ${b} | Second evidence`);await f.run(`reopen ${c} ${a} confirm`);assert.match(await pages(f,`plan ${c}`),/STALE/);
 for(const field of ["target","sessionsPerWeek","sessionMinutes"]){await f.run(`clear ${c} ${field} confirm`);await f.run(`edit ${c} ${field} | ${field==="target"?"New target":"4"}`);}
 for(const field of ["label","estimateSessions","readinessTest"])await f.run(`unit ${c} clear ${a} ${field} confirm`);
 await f.run(`unit ${c} edit ${a} | New unit | 3 | Observable criterion`);await f.run(`requires ${c} ${b} clear confirm`);await f.run(`requires ${c} ${b} | ${a}`);await f.run(`unit ${c} remove ${a} confirm`);
 const r=await record(f,c);assert.equal(r.units.length,1);assert.deepEqual(r.units[0].prerequisites,[]);assert.ok(r.units[0].demonstration.unitRevision<r.units[0].revision);
 await f.run(`delete ${c} confirm`);assert.match(await f.run("list"),/No saved/);
});
test("demonstration CAS never certifies changed readiness and unrelated course retries survive",async()=>{
 let conflict=false,target="";const backend=createMemoryAgentBackend({beforeCompareSet:(key,previous)=>{if(conflict&&previous){conflict=false;const s=JSON.parse(previous),c=s.records.find((x:{id:string})=>x.id===target);c.revision++;c.units[0].revision++;c.units[0].readinessTest="Concurrent criterion";backend.data.set(key,JSON.stringify(s));}}});
 const f=createAgentFeatureFixture(feature,{backend}),c=await create(f),a=await unit(f,c,"A"),other=await create(f);await unit(f,other,"Other");
 target=c;conflict=true;await assert.rejects(f.run(`demonstrate ${c} ${a} | Obsolete evidence`),/changed/);assert.equal((await record(f,c)).units[0].demonstration,null);
 target=other;conflict=true;await f.run(`demonstrate ${c} ${a} | Current evidence`);assert.ok((await record(f,c)).units[0].demonstration);assert.equal(backend.calls.conflicts,2);
});
test("maximum units, Unicode lifecycle reservation and complete paginated export",async()=>{
 const f=createAgentFeatureFixture(feature),courses:string[]=[];let stopped=false;
 for(let i=0;i<8;i++){let c:string;try{c=await create(f);}catch(e){assert.match(String(e),/quota/);break;}courses.push(c);for(let j=0;j<24;j++){try{await unit(f,c,`Unit ${j}`);}catch(e){assert.match(String(e),/quota/);stopped=true;break;}}if(stopped)break;}
 assert.ok(stopped);const first=await record(f,courses[0]);assert.equal(first.units.length,24);await assert.rejects(unit(f,courses[0],"25th"),/24/);
 for(const c of courses){for(const u of (await record(f,c)).units)await f.run(`demonstrate ${c} ${u.id} | ${'"'.repeat(240)}`);const out=await f.run(`export ${c}`);assert.ok(Buffer.byteLength(out)<=24576);const all=await pages(f,`show ${c}`);for(const u of (await record(f,c)).units)assert.ok(all.includes(u.id));}
 assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);for(const c of courses)await f.run(`delete ${c} confirm`);
});
test("schema corruption/invalid inputs preserve bytes and foreign owners cannot retrieve courses",async()=>{
 const f=createAgentFeatureFixture(feature),c=await create(f),a=await unit(f,c,"A"),good=f.backend.data.get(f.key("state"))!;
 for(const bad of ["null","{",good.replace('"version":1','"version":2'),good.replace('"prerequisites":[]',`"prerequisites":["${a}"]`)]){f.backend.data.set(f.key("state"),bad);await assert.rejects(f.run(`delete ${c} confirm`));assert.equal(f.backend.data.get(f.key("state")),bad);}f.backend.data.set(f.key("state"),good);
 for(const cmd of ["create Bad | 15 | 20","create Bad | 1 | 181",`unit ${c} add X | 169 | Y`,`evidence ${c} ${a} | 2026-02-29 | X`])await assert.rejects(f.run(cmd));assert.equal(f.backend.data.get(f.key("state")),good);
 for(const owner of [{teamId:"TOTHER",userId:f.owner.userId},{teamId:f.owner.teamId,userId:"UOTHER"}])await assert.rejects(f.run(`show ${c}`,{owner}),/not found/);
});
