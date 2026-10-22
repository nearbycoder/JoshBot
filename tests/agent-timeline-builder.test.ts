import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import feature from "../lib/agent-features/timeline-builder.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const prefix = "/nobo-help agent timeline-builder ";
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
const state = async (f: ReturnType<typeof createAgentFeatureFixture>) => (await f.store().read<any>("state"))!;
async function pages(f: ReturnType<typeof createAgentFeatureFixture>, command: string) {
  let all = "", first = "", count = 0;
  while (command) {
    const reply = await f.run(command); assert.ok(reply.length <= 3500); if (!first) first = reply; all += reply;
    const next = reply.match(/Next: (\/nobo-help agent timeline-builder [^\n]+)/)?.[1];
    command = next?.includes(" rev ") ? next.slice(prefix.length) : "";
    assert.ok(++count < 60);
  }
  return { all, first, count };
}
test("catalog flow preserves precision/provenance and compares only justified order", async () => {
  const f = createAgentFeatureFixture(feature);
  await f.run("create Launch history"); const r = (await state(f)).records[0];
  await f.run(`entry ${r.id} add Draft approved | 2026-10-20 | Review notes | Draft approved on Tuesday`);
  await f.run(`entry ${r.id} add Release published | 2026-10-21T15:00:00Z | Release log | Published at 15:00 UTC`);
  let entries = (await state(f)).records[0].entries;
  const [a,b] = entries;
  await f.run(`before ${r.id} ${a.id} | ${b.id}`);
  await f.run(`dispute ${r.id} ${a.id} | Another note says approval happened on Wednesday`);
  let view = (await pages(f, `view ${r.id}`)).all;
  assert.match(view, /civil-date labels|Civil-date labels/); assert.match(view, /Another note/); assert.doesNotMatch(view, /2026-10-20T/);
  await f.run(`entry ${r.id} add Unknown | unknown | recollection | approximately then`);
  await f.run(`entry ${r.id} add Fold early | 2026-11-01T01:30:00-05:00 | clock | first occurrence`);
  await f.run(`entry ${r.id} add Fold late | 2026-11-01T01:30:00-06:00 | clock | second occurrence`);
  entries = (await state(f)).records[0].entries;
  await f.run(`before ${r.id} ${entries[4].id} | ${entries[3].id}`);
  view = (await pages(f, `view ${r.id}`)).all;
  assert.match(view, /CONTRADICTION: known instant is later/); assert.ok(view.indexOf("Fold early") < view.indexOf("Fold late"));
  const before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`before ${r.id} ${b.id} | ${a.id}`), /cycle rejected/);
  for (const bad of ["2026-02-29", "2024-03-10T02:30", "2026-01-01T01:00-00:00"]) assert.match(await f.run(`entry ${r.id} add Bad | ${bad} | X | Y`), /real|offset|Invalid/);
  assert.equal(f.backend.data.get(f.key("state")), before);
  await f.run(`entry ${r.id} edit ${a.id} | Approval | 2024-02-29 | exact note | kept`);
  await f.run(`dispute-edit ${r.id} ${a.id} | Corrected uncertainty`);
  const oid = (await state(f)).records[0].orders[0].id;
  await f.run(`before-edit ${r.id} ${oid} | ${a.id} | ${entries[2].id}`);
  await f.run(`edit ${r.id} | New title`);
  await f.run(`remove ${r.id} dispute ${a.id} confirm`);
  await f.run(`remove ${r.id} entry ${a.id} confirm`);
  assert.equal((await state(f)).records[0].orders.length, 1);
  assert.deepEqual(f.calls, { generate:0, search:0, readContext:0 });
  assert.match(await f.run(`export ${r.id}`, { owner: { teamId:"TOTHER", userId:f.owner.userId } }), /not found/);
  assert.match(await f.run(`export ${r.id}`, { owner: { teamId:f.owner.teamId, userId:"UOTHER" } }), /not found/);
  await f.run(`delete ${r.id} confirm`); assert.equal((await state(f)).records.length, 0);
});
test("maximum counts and lossless revision-bound show/view pages, including final fields", async () => {
  const f = createAgentFeatureFixture(feature); await f.run("create Dense chronology"); const id = (await state(f)).records[0].id;
  for (let i=0;i<30;i++) assert.match(await f.run(`entry ${id} add E${i} | unknown | S | ${i === 29 ? 'LAST 界😀 é '+escape('"\\'.repeat(50)) : "x"}`), /Saved entry/);
  const r = (await state(f)).records[0];
  assert.match(await f.run(`entry ${id} add excess | unknown | s | x`), /Maximum 30/);
  for (const verb of ["show","view"]) {
    const walked = await pages(f, `${verb} ${id}`); assert.ok(walked.count>1); assert.match(walked.all, /LAST 界😀 é/);
    const next = walked.first.match(/Next: (.+)/)![1].slice(prefix.length);
    await f.run(`edit ${id} | Updated ${verb}`);
    assert.match(await f.run(next), /Restart: .*page 1/);
  }
  const exported = JSON.parse(await f.run(`export ${id}`)); assert.deepEqual(exported.record.entries, r.entries); assert.ok(Buffer.byteLength(JSON.stringify(exported))<=24576);
  for(let i=1;i<12;i++) await f.run(`create Root ${i}`);
  const listing = await f.run("list"); assert.match(listing, /Next: .*list 2/); assert.match(await f.run("list 2"), /Root 11/);
});
test("malformed enums/schema and unreadable raw bytes survive confirmed deletion", async () => {
  const f = createAgentFeatureFixture(feature); await f.run("create Corruption fixture"); let s=await state(f);
  await f.run(`entry ${s.records[0].id} add A | unknown | S | E`); s=await state(f);
  for (const bad of [["unknown"], {toString:"unknown"}, "uncertain"]) {
    const copy=structuredClone(s); copy.records[0].entries[0].date.kind=bad;
    const raw=JSON.stringify(copy); f.backend.data.set(f.key("state"),raw);
    assert.match(await f.run(`delete ${s.records[0].id} confirm`),/Invalid saved/); assert.equal(f.backend.data.get(f.key("state")),raw);
  }
  for(const raw of ["null","{bad",JSON.stringify({...s,version:2})]) { f.backend.data.set(f.key("state"),raw); await f.run(`delete ${s.records[0].id} confirm`); assert.equal(f.backend.data.get(f.key("state")),raw); }
});
test("actual CAS retries reject same-record mutation/removal, preserve unrelated writes", async () => {
  let conflict: ((s:any)=>void)|undefined;
  const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) { if(conflict && key.endsWith(":state")) { const s=JSON.parse(previous!); const fn=conflict; conflict=undefined; fn(s); backend.data.set(key,JSON.stringify(s)); } } });
  const f=createAgentFeatureFixture(feature,{backend}); await f.run("create One"); await f.run("create Two"); const s=await state(f), [a,b]=s.records;
  await f.run(`entry ${a.id} add A | unknown | S | E`); const e=(await state(f)).records[0].entries[0];
  for(const cmd of [`dispute ${a.id} ${e.id} | challenged`,`entry ${a.id} edit ${e.id} | B | unknown | S | E`,`remove ${a.id} entry ${e.id} confirm`,`delete ${a.id} confirm`]) {
    conflict=s=>{s.records[0].revision++;s.records[0].title="Concurrent";}; assert.match(await f.run(cmd), /changed/); assert.equal((await state(f)).records[0].entries[0].dispute,null);
  }
  conflict=s=>{s.records[1].revision++;s.records[1].title="Unrelated edit";};
  assert.match(await f.run(`dispute ${a.id} ${e.id} | retained`),/Saved dispute/); assert.equal((await state(f)).records.find((r:any)=>r.id===b.id).title,"Unrelated edit"); assert.ok(backend.calls.conflicts>=5);
});
test("UTF8 admission reserves worst-case disputes; lifecycle and removal remain possible above content cap", async () => {
  const f=createAgentFeatureFixture(feature); const accepted:string[]=[];
  for(let root=0;root<12;root++) {
    const response=await f.run(`create ${'界😀'.repeat(20)}`); if(!response.includes("Saved privately")) break;
    const r=(await state(f)).records.at(-1); accepted.push(r.id);
    for(let i=0;i<12;i++) { const reply=await f.run(`entry ${r.id} add ${'界'.repeat(40)} | unknown | ${'"'.repeat(180)} | ${escape('"\\'.repeat(280))}`); if(!reply.includes("Saved entry")) break; }
  }
  const before=await state(f); let lifecycle=0;
  for(const r of before.records) for(const e of r.entries) { assert.match(await f.run(`dispute ${r.id} ${e.id} | ${'"'.repeat(256)}`),/Saved dispute/); lifecycle++; }
  assert.ok(lifecycle>10); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)>32768); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);
  for(const r of (await state(f)).records) { assert.ok(Buffer.byteLength(await f.run(`export ${r.id}`))<=24576); await f.run(`delete ${r.id} confirm`); }
  assert.equal((await state(f)).records.length,0);
});
test("confirmed whole-timeline deletion remains available at the valid revision ceiling",async()=>{
 const f=createAgentFeatureFixture(feature);await f.run("create Ceiling");const s=await state(f),id=s.records[0].id;s.records[0].revision=999999999;f.backend.data.set(f.key("state"),JSON.stringify(s));
 assert.match(await f.run(`delete ${id} confirm`),/Deleted privately/);assert.equal((await state(f)).records.length,0);
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
  for (let i = 0; i < 10; i++) assert.match(await f.run(`entry ${id} add ${"t".repeat(160)} | unknown | ${"s".repeat(200)} | ${"e".repeat(600)}`), /Saved/);
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
  inject = s => { s.records[0].revision++; s.records[0].title = "Concurrent target growth"; };
  assert.match(await f.run(`delete ${target} confirm`), /changed/);
  assert.equal(backend.data.get(f.key("state")), winning);
  inject = s => { s.records[1].revision++; s.records[1].title = "Unrelated growth retained"; };
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
