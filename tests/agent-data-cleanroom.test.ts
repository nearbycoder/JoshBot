import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import feature from "../lib/agent-features/data-cleanroom.js";
import metadata from "../lib/agent-features/data-cleanroom.metadata.js";
const CREATE = "create Effort samples | name,minutes\nDraft,60\nDraft,60\nReview,unknown", PREFIX = "table", TITLE = "Effort samples";
async function populate(f: ReturnType<typeof createAgentFeatureFixture>, id: string) {assert.match(await f.run(`replace ${id} confirm | a,b\n${Array.from({length:12},(_,i)=>`${i},${"界".repeat(60)}`).join("\n")}`),/Saved privately/);}
async function body(f:ReturnType<typeof createAgentFeatureFixture>,command:string):Promise<string>{let out="";for(let i=0;i<100;i++){const reply=await f.run(command);assert.ok(reply.length<=3500);const h=/^.*\nPage \d+\/\d+\n/.exec(reply);assert.ok(h,reply);const next=/\nNext: (\/nobo-help agent [^\n]+)$/.exec(reply);out+=reply.slice(h[0].length,next?.index??reply.length);if(!next)return out;command=next[1].slice(route.length);}assert.fail("Too many pages");}
// Independent token-regex RFC reader, used only as an export oracle.
function oracle(input:string):string[][]{const rows:string[][]=[[]],token=/("(?:[^"]|"")*"|[^,"\r\n]*)(,|\r\n|\n|$)/gy;let at=0;while(at<input.length){token.lastIndex=at;const m=token.exec(input);assert.ok(m);const value=m[1].startsWith('"')?m[1].slice(1,-1).replace(/""/g,'"'):m[1];rows.at(-1)!.push(value);at=token.lastIndex;if(m[2]==="\r\n"||m[2]==="\n")rows.push([]);if(m[2]==="")break;}return rows;}
test("catalog CSV schema audit, dedupe preview/apply, canonical export and explicit undo",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f);await f.run(`schema ${id} | name:text,minutes:integer`);const audit=await f.run(`audit ${id}`);assert.match(audit,/Duplicate exact row 2/);assert.match(audit,/Invalid integer: row 3 .*column 2/);
 const p=uid(await f.run(`preview ${id} | dedupe | name,minutes`),"preview");assert.equal((await state(f)).records[0].current.rows.length,3);const detail=await body(f,`preview-show ${id}`);assert.ok(detail.includes(`apply ${id} ${p}`));
 assert.match(await f.run(`apply ${id} ${p}`),/Saved privately/);assert.equal(await body(f,`export-csv ${id}`),'name,minutes\r\nDraft,60\r\nReview,unknown');
 assert.match(await f.run(`apply ${id} ${p}`),/Stale|consumed/);await f.run(`undo ${id} confirm`);assert.equal((await state(f)).records[0].current.rows.length,3);assert.equal((await state(f)).records[0].undo,null);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("independent CSV oracle preserves Unicode, quoted CRLF/comma/quote, blanks and formula-like text",async()=>{
 const f=createAgentFeatureFixture(feature),values=[["name","detail","blank"],["界😀","line1\r\nline2, \"quoted\"",""],["=1+1","  exact  ","@SUM(1)"],["+cmd","back\\slash | pipe","-42"]],source=values.map(row=>row.map(v=>'"'+v.replace(/"/g,'""')+'"').join(',')).join('\r\n');
 const id=uid(await f.run(`create Roundtrip | ${esc(source)}`),"table"),r=(await state(f)).records[0];assert.deepEqual([r.original.columns.map((c:any)=>c.name),...r.original.rows.map((x:any)=>x.cells)],values);
 const canonical=await body(f,`export-csv ${id}`);assert.deepEqual(oracle(canonical),values);assert.match(await f.run(`export-csv ${id}`),/spreadsheets may execute/);
 const escaped=oracle(await body(f,`export-spreadsheet ${id}`));assert.equal(escaped[2][0],"'=1+1");assert.equal(escaped[3][2],"'-42");assert.deepEqual((await state(f)).records[0],r);
 assert.deepEqual(JSON.parse(await reconstruct(f,id)),JSON.parse(await f.run(`export ${id}`)));
});
test("schema conversion never drops invalid values or converts blank to zero; every edit/removal is explicit",async()=>{
 const f=createAgentFeatureFixture(feature),id=uid(await f.run('create Types | a,b\n 007 ,2024-02-29\n,2024-02-30'),"table");let r=(await state(f)).records[0];
 await f.run(`keys ${id} | a`);const before=f.backend.data.get(f.key("state"));assert.match(await f.run(`preview ${id} | convert | a:integer`),/Conversion refused/);assert.equal(f.backend.data.get(f.key("state")),before);
 let p=uid(await f.run(`preview ${id} | trim | all`),"preview");await f.run(`apply ${id} ${p}`);assert.match(await f.run(`preview ${id} | convert | a:integer`),/row 2/);
 await f.run(`cell ${id} ${r.current.rows[1].id} | a | "0"`);await f.run(`cell ${id} ${r.current.rows[1].id} | b | "2024-03-01"`);
 p=uid(await f.run(`preview ${id} | convert | a:integer,b:civilDate`),"preview");await f.run(`apply ${id} ${p}`);assert.equal((await state(f)).records[0].current.rows[0].cells[0],"7");
 await f.run(`discard ${id} undo confirm`);p=uid(await f.run(`preview ${id} | dedupe | selected`),"preview");await f.run(`discard ${id} preview confirm`);assert.match(await f.run(`apply ${id} ${p}`),/Stale/);
 await f.run(`cell-clear ${id} ${r.current.rows[0].id} ${r.current.columns[0].id} confirm`);assert.equal((await state(f)).records[0].current.rows[0].cells[0],"");await f.run(`keys-remove ${id} confirm`);await f.run(`row-remove ${id} ${r.current.rows[1].id} confirm`);await f.run(`edit ${id} | title | Edited`);
 assert.equal((await state(f)).records[0].original.rows.length,2);await f.run(`replace ${id} confirm | renamed\nnew`);r=(await state(f)).records[0];assert.equal(r.original.rows.length,1);assert.equal(r.original.columns[0].name,"renamed");
});
test("malformed CSV, ambiguous headers, strict persisted enums and row widths preserve bytes",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f),raw=f.backend.data.get(f.key("state"))!;
 for(const source of ['a,a\n1,2','a, a\n1,2',',b\n1,2','a,b\n1','a\n"unclosed','a\n"ok"junk','a\nx"y','a\rx','a\n'+"x".repeat(6001)]){await f.run(`replace ${id} confirm | ${source}`);assert.equal(f.backend.data.get(f.key("state")),raw);}
 for(const change of [(r:any)=>r.current.columns[0].type=["text"],(r:any)=>r.current.rows[0].cells.push("extra"),(r:any)=>r.original.rows[0].cells[0]=null]){const s=JSON.parse(raw);change(s.records[0]);const bad=JSON.stringify(s);f.backend.data.set(f.key("state"),bad);assert.match(await f.run(`delete ${id} confirm`),/preserved/);assert.equal(f.backend.data.get(f.key("state")),bad);}
});
test("maximum rows/columns and six roots; dynamic reservation completes all admitted worst-escaping lifecycles",async()=>{
 const f=createAgentFeatureFixture(feature),source=Array.from({length:41},(_,i)=>Array.from({length:8},(_,j)=>i?"":`h${j}`).join(',')).join('\n'),id=uid(await f.run(`create Counts | ${source}`),"table");assert.equal((await state(f)).records[0].current.rows.length,40);assert.equal((await state(f)).records[0].current.columns.length,8);
 assert.match(await f.run(`replace ${id} confirm | ${source}\n,,,,,,,`),/Maximum 40/);
 const g=createAgentFeatureFixture(feature),ids=[];for(let i=0;i<6;i++)ids.push(uid(await g.run(`create T${i} | a\nsmall`),"table"));assert.match(await g.run('create seventh | a\nx'),/Maximum 6/);
 let rejected=false;for(const rid of ids){const row=(await state(g)).records.find((r:any)=>r.id===rid).current.rows[0].id;for(let n=100;n<=2500;n+=100){const result=await g.run(`cell ${rid} ${row} | a | ${esc(JSON.stringify('"\\界'.repeat(n)))}`);if(!result.startsWith('Saved privately')){assert.match(result,/quota|too long|could not be read safely/);rejected=true;break;}}}
 assert.ok(rejected);
 for(const rid of ids){const p=uid(await g.run(`preview ${rid} | trim | all`),"preview");assert.match(await g.run(`apply ${rid} ${p}`),/Saved privately/);assert.match(await g.run(`undo ${rid} confirm`),/Saved privately/);assert.deepEqual(JSON.parse(await reconstruct(g,rid)),JSON.parse(await g.run(`export ${rid}`)));}
 assert.ok(Buffer.byteLength(JSON.stringify(await state(g)))<=65536);
});
test("stale preview replacement/edit and same-target apply CAS conflicts reject exact intent",async()=>{
 let armed=false,target="",key="";const backend=createMemoryAgentBackend({beforeCompareSet(k){if(!armed||k!==key)return;armed=false;const s=JSON.parse(backend.data.get(k)!);const r=s.records.find((r:any)=>r.id===target);r.title="Concurrent";backend.data.set(k,JSON.stringify(s));}}),f=createAgentFeatureFixture(feature,{backend}),id=await setup(f);target=id;key=f.key("state");
 const a=uid(await f.run(`preview ${id} | dedupe | name`),"preview"),b=uid(await f.run(`preview ${id} | trim | all`),"preview");assert.match(await f.run(`apply ${id} ${a}`),/Stale/);armed=true;assert.match(await f.run(`apply ${id} ${b}`),/changed/);assert.equal((await state(f)).records[0].current.rows.length,3);
 await f.run(`edit ${id} | title | Edit`);assert.match(await f.run(`apply ${id} ${b}`),/Stale/);
});
test("individually exportable legacy aggregates recover by root deletion only; help and cancellation stay safe",async()=>{
 const f=createAgentFeatureFixture(feature),id=await setup(f);await populate(f,id);const s=await state(f);for(let i=1;i<6;i++)s.records.push({...structuredClone(s.records[0]),id:`table-${randomUUID()}`});
 // Add only valid grid content; quota is not a read validator.
 for(const r of s.records)for(const g of [r.original,r.current])for(const row of g.rows)row.cells[1]='界'.repeat(180);
 const raw=JSON.stringify(s);assert.ok(Buffer.byteLength(raw)>65536);f.backend.data.set(f.key("state"),raw);for(const r of s.records){assert.ok(Buffer.byteLength(await f.run(`export ${r.id}`))<=24576);assert.match(await f.run(`delete ${r.id} confirm`),/Deleted privately/);}
 assert.equal(feature.help,metadata.help);assert.equal(await feature.execute('help',{} as never),metadata.help);assert.ok(metadata.help.length<=3500);
 let armed=false;const gate=deferred<void>(),seen=deferred<void>(),backend=createMemoryAgentBackend({async beforeGet(){if(armed){seen.resolve();await gate.promise;}}}),g=createAgentFeatureFixture(feature,{backend}),gid=await setup(g),c=new AbortController(),before=backend.calls.writes;
 armed=true;const p=g.run(`preview ${gid} | trim | all`,{signal:c.signal});await seen.promise;c.abort();await assert.rejects(p,/abort/i);gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(backend.calls.writes,before);
});
const route = `/nobo-help agent ${feature.id} `;
const uid = (reply: string, prefix: string) => { const m = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`)); assert.ok(m, reply); return m[0]; };
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
async function state(f: ReturnType<typeof createAgentFeatureFixture>): Promise<any> { return f.store().read("state"); }
async function setup(f: ReturnType<typeof createAgentFeatureFixture>) { return uid(await f.run(CREATE), PREFIX); }
async function reconstruct(f: ReturnType<typeof createAgentFeatureFixture>, id: string): Promise<string> {
  let command = `show ${id}`, body = "";
  for (let i = 0; i < 100; i++) {
    const reply = await f.run(command); assert.ok(reply.length <= 3500, reply.length.toString()); assert.ok(reply.isWellFormed());
    const h = /^.*\nPage \d+\/\d+\n/.exec(reply); assert.ok(h, reply);
    const next = /\nNext: (\/nobo-help agent [^\n]+)$/.exec(reply);
    body += reply.slice(h[0].length, next?.index ?? reply.length);
    if (!next) return body;
    assert.match(next[1], / rev \d+-[a-f0-9]{64}$/);
    command = next[1].slice(route.length);
  }
  assert.fail("Continuation did not terminate.");
}
test("whole-root schema failures preserve bytes; owner and workspace scopes stay isolated", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f), original = f.backend.data.get(f.key("state"))!;
  for (const owner of [{ userId: "UOTHER", teamId: "TFIXTURE" }, { userId: "UFIXTURE", teamId: "TOTHER" }]) {
    assert.match(await f.run(`show ${id}`, { owner }), /not found/i);
    assert.match(await f.run(`delete ${id} confirm`, { owner }), /not found/i);
  }
  for (const corrupt of ['null', '{broken', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ ...JSON.parse(original).records[0], revision: "1" }] })]) {
    f.backend.data.set(f.key("state"), corrupt);
    assert.match(await f.run(`delete ${id} confirm`), /saved data|preserved|read safely/i);
    assert.equal(f.backend.data.get(f.key("state")), corrupt);
  }
  f.backend.data.set(f.key("state"), original);
  assert.equal(JSON.parse(await reconstruct(f, id)).record.id, id);
});
test("backend synchronous, rejected and after-dispatch exceptions never expose diagnostics", async () => {
  for (const operation of ["get-sync", "get-reject", "cas-sync", "cas-reject", "cas-after"]) {
    const backend = createMemoryAgentBackend(), f = createAgentFeatureFixture(feature, { backend });
    const id = await setup(f), oldGet = backend.get, oldCas = backend.compareSet;
    const secret = "FAKE_SECRET_diagnostic_9321";
    if (operation === "get-sync") backend.get = () => { throw new Error(secret); };
    if (operation === "get-reject") backend.get = () => Promise.reject(new Error(secret));
    if (operation === "cas-sync") backend.compareSet = () => { throw new Error(secret); };
    if (operation === "cas-reject") backend.compareSet = () => Promise.reject(new Error(secret));
    if (operation === "cas-after") backend.compareSet = async (...args) => { await oldCas(...args); throw new Error(secret); };
    const reply = await f.run(`edit ${id} | title | Updated`);
    assert.doesNotMatch(reply, new RegExp(secret)); assert.match(reply, /inspect.*before repeating/i);
    backend.get = oldGet; backend.compareSet = oldCas;
    assert.equal((await state(f)).records[0].title, operation === "cas-after" ? "Updated" : TITLE);
  }
});
test("real CAS conflicts retry unrelated records but reject same-target edits and deletion", async () => {
  for (const kind of ["unrelated", "same", "delete"]) {
    let armed = false, key = "", target = "", other = "";
    const backend = createMemoryAgentBackend({ beforeCompareSet(k) {
      if (!armed || k !== key) return; armed = false;
      const s = JSON.parse(backend.data.get(k)!);
      if (kind === "delete") s.records = s.records.filter((r: any) => r.id !== target);
      else s.records.find((r: any) => r.id === (kind === "same" ? target : other)).title = "Concurrent";
      backend.data.set(k, JSON.stringify(s));
    } });
    const f = createAgentFeatureFixture(feature, { backend }); target = await setup(f); other = await setup(f); key = f.key("state"); armed = true;
    const reply = await f.run(`edit ${target} | title | Intended`), s = await state(f);
    assert.equal(backend.calls.conflicts, 1);
    if (kind === "unrelated") { assert.match(reply, /Saved privately/); assert.equal(s.records.find((r: any) => r.id === other).title, "Concurrent"); assert.equal(s.records.find((r: any) => r.id === target).title, "Intended"); }
    else { assert.match(reply, /changed|not found/i); assert.ok(!s.records.some((r: any) => r.title === "Intended")); }
  }
});
test("ceiling refuses writes, permits exact removals and rejects old content-stamped continuation", async () => {
  const f = createAgentFeatureFixture(feature), id = await setup(f); await populate(f, id);
  const s = await state(f); s.records[0].revision = 999999999; f.backend.data.set(f.key("state"), JSON.stringify(s));
  const before = await f.run(`show ${id}`), continuation = /Next: (\/nobo-help agent [^\n]+)/.exec(before)?.[1]; assert.ok(continuation, before);
  assert.match(await f.run(`edit ${id} | title | Refuse`), /Revision limit/);
  const reply = await f.run(`clear ${id} title confirm`); assert.match(reply, /Saved privately/);
  assert.equal((await state(f)).records[0].revision, 999999999);
  assert.match(await f.run(continuation.slice(route.length)), /stale continuation/i);
  assert.match(await f.run(`delete ${id} confirm`), /Deleted privately/);
  assert.equal((await state(f)).records.length, 0);
});
