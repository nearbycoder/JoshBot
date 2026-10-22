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

async function erasureFixture(f: ReturnType<typeof createAgentFeatureFixture>) {
  assert.match(await f.run("create Launch"), /Saved/);
  const read = async () => (await f.store().read<any>("state"))!;
  const id = (await read()).records[0].id;
  for (let i = 0; i < 8; i++) assert.match(await f.run(`entry ${id} add Entry | unknown | Source | ${"E".repeat(500)}`), /Saved/);
  return { id, read };
}

for (const ceiling of [false, true]) test(`selective erasure retains other children and invalidates complete pages (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const f = createAgentFeatureFixture(feature), {id, read} = await erasureFixture(f);
  if (ceiling) { const s = await read(); s.records[0].revision = 999999999; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  const before = (await read()).records[0], child = before.entries[0].id;
  assert.deepEqual(JSON.parse(await f.run(`export ${id}`)).record, before);
  const first = await f.run(`show ${id}`), continuation = first.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1];
  assert.ok(continuation, "fixture exercises real continuation");
  assert.match(continuation, / rev \d+:[a-f0-9]{64}$/);
  assert.match(await f.run(continuation), /Page 2\//);
  assert.match(await f.run(`remove ${id} entry ${child} confirm`), /Saved|Removed/);
  const after = (await read()).records[0];
  assert.equal(after.revision, ceiling ? 999999999 : before.revision + 1);
  assert.deepEqual(after.entries, before.entries.slice(1));
  assert.match(await f.run(continuation), /changed|snapshot|Restart/i);
  assert.match(await f.run(continuation.replace(/:[a-f0-9]{64}/, "")), /changed|snapshot|Restart/i);
  // New pages remain complete and lossless after a saturated revision removal.
  let cmd = `show ${id}`, body = "";
  while (cmd) {
    const reply = await f.run(cmd); assert.ok(reply.length <= 3500 && reply.isWellFormed());
    const marker = reply.match(/\nPage \d+\/\d+\n/); assert.ok(marker);
    body += reply.slice(marker.index! + marker[0].length).replace(/\nNext: \/nobo-help agent [^\n]+$/, "");
    cmd = reply.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1] ?? "";
  }
  assert.deepEqual(JSON.parse(body.slice(body.indexOf("{"))), JSON.parse(await f.run(`export ${id}`)));
  if (ceiling) {
    const raw = f.backend.data.get(f.key("state")); assert.match(await f.run(`edit ${id} | Changed`), /Revision limit/);
    assert.equal(f.backend.data.get(f.key("state")), raw);
  }
  await f.run(`delete ${id} confirm`); assert.equal((await read()).records.length, 0);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

for (const ceiling of [false, true]) test(`real CAS protects erasure intent and retries unrelated changes (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  let action: (() => Promise<void>) | undefined, winning: string | undefined;
  const backend = createMemoryAgentBackend({async beforeCompareSet(key) {
    if (key.endsWith(":state") && action) { const work = action; action = undefined; await work(); winning = backend.data.get(key); }
  }});
  const f = createAgentFeatureFixture(feature, {backend}), {id, read} = await erasureFixture(f);
  await f.run("create Launch");
  if (ceiling) { const s = await read(); s.records[0].revision = 999999999; backend.data.set(f.key("state"), JSON.stringify(s)); }
  const original = backend.data.get(f.key("state"))!, r = (await read()).records[0], child = r.entries[0].id;
  const remove = (child: string) => `remove ${id} entry ${child} confirm`;
  // A real same-record removal wins while the original operation is awaiting CAS.
  for (const pending of [remove(child), `delete ${id} confirm`]) {
    backend.data.set(f.key("state"), original);
    action = async () => { assert.match(await f.run(remove(r.entries[1].id)), /Saved|Removed/); };
    assert.match(await f.run(pending), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  }
  // A competing writer reintroduces the child ID with changed content. The exact
  // numeric revision can be unchanged; intent must still bind the full snapshot.
  backend.data.set(f.key("state"), original);
  action = async () => {
    assert.match(await f.run(remove(child)), /Saved|Removed/);
    const s = await read(), replacement = structuredClone(r.entries[0]);
    replacement.excerpt = "Reintroduced evidence";
    s.records[0].entries.push(replacement); backend.data.set(f.key("state"), JSON.stringify(s));
    assert.equal(JSON.parse(await f.run(`export ${id}`)).record.entries.at(-1).id, child);
  };
  assert.match(await f.run(remove(child)), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { await f.run(`delete ${id} confirm`); };
  assert.match(await f.run(remove(child)), /not found/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { const other = (await read()).records[1].id; await f.run(`delete ${other} confirm`); };
  assert.match(await f.run(remove(child)), /Saved|Removed/);
  const after = await read(); assert.equal(after.records.length, 1);
  assert.deepEqual(after.records[0].entries, r.entries.slice(1));
  assert.ok(backend.calls.conflicts >= 5);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

test("all field and relationship erasures remain valid at the root revision ceiling", async () => {
  const f = createAgentFeatureFixture(feature);
  await f.run("create Timeline"); const id = (await state(f)).records[0].id;
  await f.run(`entry ${id} add A | unknown | S | E`); await f.run(`entry ${id} add B | unknown | S | E`);
  const [a,b] = (await state(f)).records[0].entries;
  await f.run(`before ${id} ${a.id} | ${b.id}`); await f.run(`dispute ${id} ${a.id} | Disputed`);
  const order = (await state(f)).records[0].orders[0];
  const s = (await f.store().read<any>("state"))!; s.records[0].revision = 999999999;
  const original = JSON.stringify(s);
  for (const cmd of [`remove ${id} entry ${a.id} confirm`,
    `remove ${id} order ${order.id} confirm`,
    `remove ${id} dispute ${a.id} confirm`]) {
    f.backend.data.set(f.key("state"), original);
    assert.match(await f.run(cmd), /Saved|Removed|Cleared/);
    assert.notEqual(f.backend.data.get(f.key("state")), original, cmd);
    const exported = JSON.parse(await f.run(`export ${id}`));
    assert.equal(exported.record.revision, 999999999);
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 24576);
  }
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});
