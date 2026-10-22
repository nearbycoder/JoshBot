import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/delegation-brief.js";
import metadata from "../lib/agent-features/delegation-brief.metadata.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const first = metadata.example.split("delegation-brief ")[1];
async function create(f: ReturnType<typeof createAgentFeatureFixture>) { const reply = await f.run(first); return /brief-[\da-f-]{36}/.exec(reply)![0]; }
async function record(f: ReturnType<typeof createAgentFeatureFixture>, id: string) { return JSON.parse(await f.run(`export ${id}`)).record; }

test("catalog workflow audits real decision rights, boundaries and acceptance without services", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  assert.match(await f.run(`draft ${id}`), /missing decision rights.*in-scope boundary.*out-of-scope boundary/);
  await f.run(`scope ${id} | in | First-time setup only`);
  await f.run(`scope ${id} | out | Published copy is outside scope`);
  await f.run(`resource ${id} | Existing walkthrough and test account`);
  await f.run(`authority ${id} | Suggest edits; ask before changing published text`);
  await f.run(`done ${id} | Three findings each include a reproducible example`);
  await f.run(`checkpoint ${id} | 2026-10-26 | Share the first finding`);
  const draft = await f.run(`draft ${id}`);
  assert.match(draft, /all planning fields supplied/); assert.match(draft, /Acceptance: not recorded/);
  assert.match(draft, /Suggest edits; ask before changing published text/); assert.match(draft, /2026-10-26/);
  await f.run(`accept ${id} confirm`); assert.equal((await record(f,id)).status, "acceptance-recorded");
  await f.run(`done ${id} | Two reproducible findings`); assert.equal((await record(f,id)).status,"draft-request");
  assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});

test("every field and child can be replaced/removed; invalid dates and pipe grammar preserve bytes", async () => {
  const f=createAgentFeatureFixture(feature),id=await create(f);
  for (const field of ["title","recipient","outcome","authority","done"]) {
    await f.run(`edit ${id} | ${field} | Exact <@UOTHER> & text`); assert.equal((await record(f,id))[field],"Exact <@UOTHER> & text");
    await f.run(`clear ${id} ${field} confirm`); assert.equal((await record(f,id))[field],"");
  }
  await f.run(`scope ${id} | in | Setup \\| review`);
  const entry=(await record(f,id)).entries[0]; assert.equal(entry.text,"Setup | review");
  await f.run(`entry ${id} edit ${entry.id} | checkpoint | 2026-10-27 | Edited handoff`);
  assert.equal((await record(f,id)).entries[0].date,"2026-10-27");
  const before=f.backend.data.get(f.key("state"));
  for(const cmd of [`checkpoint ${id} | 2026-02-30 | impossible`,`authority ${id} | one | two`,`done ${id} | bad\\q`,`edit ${id} | owner | No`]) {
    assert.doesNotMatch(await f.run(cmd),/^Saved/); assert.equal(f.backend.data.get(f.key("state")),before);
  }
  await f.run(`entry ${id} remove ${entry.id} confirm`); assert.equal((await record(f,id)).entries.length,0);
  assert.match(await f.run(`delete ${id}`),/delete .* confirm/); await f.run(`delete ${id} confirm`); assert.match(await f.run("list"),/No saved items/);
});

test("complete Unicode detail pages and final list item remain accessible at limits", async () => {
  const f=createAgentFeatureFixture(feature),id=await create(f);
  const value='漢🧭é<&>\\\\'.repeat(50);
  for(let i=0;i<20;i++) await f.run(`scope ${id} | ${i%2?'out':'in'} | ${i}: ${value}`);
  const r=await record(f,id); assert.equal(r.entries.length,20);
  assert.match(await f.run(`resource ${id} | excess`),/Maximum 20/);
  let command=`show ${id}`, replies="", count=0;
  do { const reply=await f.run(command); assert.ok(reply.length<=3500); replies+=reply; const next=/Next: \/nobo-help agent delegation-brief (show [^\n]+)/.exec(reply); command=next?.[1]??""; count++; }while(command&&count<30);
  assert.ok(count>1); assert.ok(replies.includes(r.entries[19].id)); assert.ok(replies.includes(JSON.stringify(r.entries[19].text).slice(1,-1)));
  for(let i=1;i<12;i++) await f.run(`create Short ${i} | Label | Outcome`);
  assert.match(await f.run("list 2"),/11–12 of 12/); assert.match(await f.run(first),/Maximum 12/);
  assert.ok(Buffer.byteLength(await f.run(`export ${id}`))<=24576);
});

test("near content quota reserves acceptance/revision lifecycle and deletion, no eviction", async()=>{
  const f=createAgentFeatureFixture(feature);const ids=[];
  for(let i=0;i<12;i++) ids.push(await create(f));
  let rejected=false;
  for(const id of ids){for(let i=0;i<20;i++) {const prior=f.backend.data.get(f.key("state")); const reply=await f.run(`resource ${id} | ${'漢'.repeat(320)}`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),prior);rejected=true;break;}}if(rejected)break;}
  assert.ok(rejected); const raw=f.backend.data.get(f.key("state"))!;assert.ok(Buffer.byteLength(raw)>31000);
  for(const id of ids) assert.match(await f.run(`accept ${id} confirm`),/^Saved/);
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!)<=49152);
  for(const id of ids) assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});

test("optional output validates exact references and full size; all failures retain deterministic request", async()=>{
  let mode="valid";
  const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const {sources}=JSON.parse(input);const sections=sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}));
    if(mode==="unknown")sections[0].ref="foreign"; if(mode==="quote")sections[0].quote="fabricated"; if(mode==="omit")sections.pop();
    if(mode==="oversize")return "x".repeat(4001); if(mode==="extra")return JSON.stringify({sections,extra:true}); return JSON.stringify({sections});}}});
  const id=await create(f),before=f.backend.data.get(f.key("state"));
  assert.match(await f.run(`polish ${id}`),/unsaved suggestion/);
  for(mode of ["unknown","quote","omit","oversize","extra"])assert.match(await f.run(`polish ${id}`),/Optional assistance unavailable/);
  assert.equal(f.backend.data.get(f.key("state")),before);assert.equal(f.calls.generate,6);assert.match(await f.run(`draft ${id}`),/Desired outcome/);
});

test("edit and delete win while optional wording is pending",async()=>{
  for(const action of ["edit","delete"]){const gate=deferred<string>(),entered=deferred<void>();
    const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();const {sources}=JSON.parse(input);await gate.promise;return JSON.stringify({sections:sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}))});}}});
    const id=await create(f),pending=f.run(`polish ${id}`);await entered.promise;
    await f.run(action==="edit"?`authority ${id} | Ask before spending`:`delete ${id} confirm`);const prior=f.backend.data.get(f.key("state"));gate.resolve("ok");
    assert.match(await pending,/stale result was discarded/);assert.equal(f.backend.data.get(f.key("state")),prior);
  }
});

test("CAS retries retain a concurrent child and owner isolation; corrupt schema never resets",async()=>{
  let conflict=false;const backend=createMemoryAgentBackend({beforeCompareSet:(key,previous)=>{if(conflict&&key.endsWith(":state")&&previous){conflict=false;const s=JSON.parse(previous);s.records[0].outcome="Concurrent outcome";s.records[0].revision++;backend.data.set(key,JSON.stringify(s));}}});
  const f=createAgentFeatureFixture(feature,{backend}),id=await create(f);conflict=true;
  await f.run(`authority ${id} | Decide the test order`);assert.equal((await record(f,id)).outcome,"Concurrent outcome");assert.equal(backend.calls.conflicts,1);
  assert.match(await f.run(`show ${id}`,{owner:{teamId:"TOTHER",userId:"UOTHER"}}),/not found/);
  const bad=JSON.parse(backend.data.get(f.key("state"))!);bad.records[0].entries=[{id:"bad",kind:"secret"}];const raw=JSON.stringify(bad);backend.data.set(f.key("state"),raw);
  assert.match(await f.run(`delete ${id} confirm`),/preserved/);assert.equal(backend.data.get(f.key("state")),raw);
});

// These races pause the real backend CAS and complete a newer real command first.
test("mutation intent rejects same-record races, preserves deletions, and retries unrelated records", async () => {
  for (let scenario = 0; scenario < 7; scenario++) {
    let compete: (() => Promise<void>) | undefined;
    const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
      if (key.endsWith(":state") && compete) { const run = compete; compete = undefined; await run(); }
    } });
    const f = createAgentFeatureFixture(feature, { backend }), id = await create(f);
    await f.run(`scope ${id} | in | Original scope`);
    const initial = await record(f, id);
    const commands = (() => { const entry = initial.entries[0].id;
    return [
      [`accept ${id} confirm`, `edit ${id} | outcome | New unaccepted outcome`],
      [`unaccept ${id} confirm`, `accept ${id} confirm`],
      [`entry ${id} remove ${entry} confirm`, `entry ${id} edit ${entry} | in | - | Revised scope`],
      [`clear ${id} outcome confirm`, `accept ${id} confirm`],
    ]; })();
    commands.push([`delete ${id} confirm`, `edit ${id} | title | Winning title`]);
    commands.push([`edit ${id} | title | Stale title`, `delete ${id} confirm`]);
    const other = await create(f);
    commands.push([`edit ${id} | title | Requested title`, `edit ${other} | title | Unrelated winner`]);
    const [older, newer] = commands[scenario]; let winner: string | undefined;
    compete = async () => { assert.match(await f.run(newer), /^(Saved|Deleted)/); winner = backend.data.get(f.key("state")); };
    const reply = await f.run(older);
    assert.equal(backend.calls.conflicts, 1, older);
    if (scenario < 6) {
      assert.match(reply, /changed before.*Inspect|not found/, older);
      assert.equal(backend.data.get(f.key("state")), winner, older);
    } else {
      assert.match(reply, /^Saved/);
      assert.equal((await record(f, id)).title, "Requested title");
      assert.equal((await record(f, other)).title, "Unrelated winner");
    }
    assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  }
});

test("coercible persisted enums reject reads, renders, mutations and confirmed deletion without changing raw bytes", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  await f.run(`scope ${id} | in | Work`);
  const original = await f.store().read<any>("state");
  for (const bad of [["in"], [["in"]], { toString: "in" }, 1, true, "unknown"]) {
    const state = structuredClone(original), r = state.records[0]; r.entries[0].kind = bad;
    const raw = JSON.stringify(state); f.backend.data.set(f.key("state"), raw);
    for (const command of [`show ${id}`, `export ${id}`, "list", `draft ${id}`, `edit ${id} | title | Replacement`, `delete ${id} confirm`]) {
      assert.match(await f.run(command), /could not be read safely.*preserved/);
      assert.equal(f.backend.data.get(f.key("state")), raw);
    }
  }
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("actual saved/report continuations recover complete data and reject edits, including revision-ceiling removals", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  for (let i=0;i<7;i++) await f.run(`scope ${id} | in | ${i} ${"漢😀".repeat(120)}`);
  const commands = [`show ${id}`, `draft ${id}`];
  for (const command of commands) {
    let next = command, body = "", count = 0, firstContinuation = "";
    do {
      const reply = await f.run(next); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed());
      const header = /\nPage (\d+)\/(\d+)\n/.exec(reply); assert.ok(header, reply);
      assert.equal(Number(header[1]), ++count);
      const more = Number(header[1]) < Number(header[2]);
      const footer = more ? /\nNext: \/nobo-help agent delegation-brief ([^\n]+)$/.exec(reply) : null;
      assert.ok(!more || footer, reply);
      body += reply.slice(header.index + header[0].length, footer?.index);
      next = footer?.[1] ?? "";
      if (next) { assert.match(next, / rev [1-9]\d*-[a-f0-9]{64}$/); firstContinuation ||= next; }
      assert.ok(count < 100);
    } while (next);
    if (command.startsWith("show ")) assert.deepEqual(JSON.parse(body), JSON.parse(await f.run(`export ${id}`)));
    // A short report still accepts and validates the same saved revision token.
    if (!firstContinuation) {
      const show = await f.run(`show ${id}`), token = / rev ([1-9]\d*-[a-f0-9]{64})/.exec(show); assert.ok(token);
      firstContinuation = `${command} 1 rev ${token[1]}`;
    }
    assert.match(await f.run(`edit ${id} | title | Changed ${count}`), /^Saved/);
    const rejected = await f.run(firstContinuation);
    assert.match(rejected, /changed; stale continuation rejected.*Restart page 1/);
    const restart = /Restart page 1: \/nobo-help agent delegation-brief ([^\n]+)/.exec(rejected); assert.ok(restart);
    assert.match(await f.run(restart[1]), /Page 1\//);
  }
  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const page = await f.run(`show ${id}`), issued = /\nNext: \/nobo-help agent delegation-brief ([^\n]+)$/.exec(page); assert.ok(issued);
  assert.match(await f.run(`clear ${id} title confirm`), /^Saved/);
  assert.equal((await record(f,id)).revision, 999_999_999);
  assert.match(await f.run(issued[1]), /stale continuation rejected/);
  assert.match(await f.run(`show ${id} 1 rev invalid`), /Invalid revision token/);
});

const escapeInput = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
const exactSections = (sources: { ref: string; quote: string }[]) => sources.map(s => ({ ...s, text: s.quote }));
async function sparseBrief(f: ReturnType<typeof createAgentFeatureFixture>) {
  const id = await create(f);
  for (const field of ["title", "recipient", "outcome"]) await f.run(`clear ${id} ${field} confirm`);
  return id;
}

test("delegation polish preflights both reviewed impossibilities with actionable complete-draft fallback", async () => {
  for (const mode of ["checkpoint", "raw"]) {
    const f = createAgentFeatureFixture(feature), id = await create(f);
    if (mode === "checkpoint") assert.match(await f.run(`checkpoint ${id} | 2026-10-26 | ${"x".repeat(1000)}`), /^Saved/);
    else for (let i = 0; i < 4; i++) assert.match(await f.run(`scope ${id} | in | ${"x".repeat(900)}`), /^Saved/);
    const raw = f.backend.data.get(f.key("state")), reply = await f.run(`polish ${id}`);
    assert.match(reply, /Polish cannot fit/);
    assert.match(reply, mode === "checkpoint" ? /1023 UTF-8 bytes.*limit is 1000/ : /7795 string units.*4000 \/ 16000/);
    assert.match(reply, /Shorten.*complete deterministic draft pages/);
    assert.doesNotMatch(reply, /unavailable|retry/i); assert.ok(reply.length <= 3500);
    const next = /\nNext: \/nobo-help agent delegation-brief ([^\n]+)$/.exec(reply); assert.ok(next);
    assert.match(await f.run(next[1]), /Page 1\//);
    assert.equal(f.backend.data.get(f.key("state")), raw);
    assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  }
});

test("delegation exact section feasibility counts kind/date labels and UTF-8 without rejecting the 1000-byte boundary", async () => {
  for (const value of ["x".repeat(977), "漢".repeat(325) + "xx"]) {
    let lastSources: { ref: string; quote: string }[] = [];
    const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
      lastSources = JSON.parse(input).sources; return JSON.stringify({ sections: exactSections(lastSources) });
    } } }), id = await create(f);
    await f.run(`checkpoint ${id} | 2026-10-26 | ${value}`);
    let raw = f.backend.data.get(f.key("state"));
    const good = await f.run(`polish ${id}`); assert.match(good, /unsaved suggestion/);
    assert.equal(Buffer.byteLength(lastSources.at(-1)!.quote), 1000);
    for (const source of lastSources) assert.ok(good.includes(source.quote));
    assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.calls.generate, 1);
    const entry = (await record(f,id)).entries[0].id;
    await f.run(`entry ${id} edit ${entry} | checkpoint | 2026-10-26 | ${value}x`);
    raw = f.backend.data.get(f.key("state"));
    assert.match(await f.run(`polish ${id}`), /1001 UTF-8 bytes.*limit is 1000/);
    assert.equal(f.calls.generate, 1); assert.equal(f.backend.data.get(f.key("state")), raw);
  }
});

test("delegation sparse exact JSON at 3999/4000 units is feasible; escaped mandatory JSON above 4000 is not", async () => {
  const escaped = '"\\\t\n'.repeat(246) + '""'; // 986 bytes; every character needs a two-unit JSON escape.
  for (const [field, value, units] of [
    ["authority", '"'.repeat(986), 3999],
    ["done", escaped + "xxx", 4000],
    ["authority", '"'.repeat(986) + "x", 4001],
    ["done", escaped + "xxxx", 4002],
  ] as const) {
    let emitted = "";
    const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
      emitted = JSON.stringify({ sections: exactSections(JSON.parse(input).sources) }); return emitted;
    } } }), id = await sparseBrief(f);
    assert.match(await f.run(`edit ${id} | ${field} | ${escapeInput(value)}`), /^Saved/);
    const raw = f.backend.data.get(f.key("state"));
    // Independently build the only mandatory section from the known sparse fixture.
    assert.equal(JSON.stringify({ sections: [{ ref: field, quote: value, text: value }] }).length, units);
    const reply = await f.run(`polish ${id}`);
    if (units <= 4000) {
      assert.match(reply, /unsaved suggestion/); assert.equal(emitted.length, units);
      assert.ok(reply.includes(value)); assert.equal(f.calls.generate, 1);
    } else {
      assert.match(reply, /minimum complete required JSON/); assert.equal(f.calls.generate, 0);
    }
    assert.equal(f.backend.data.get(f.key("state")), raw);
    assert.equal(f.calls.search, 0); assert.equal(f.calls.readContext, 0);
  }
});

test("delegation minimum complete reply allows exactly 3500 units and refuses 3501 without calling", async () => {
  let append = false, generatedRaw = "";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    const sections = exactSections(JSON.parse(input).sources); if (append) sections.at(-1)!.text += "!";
    generatedRaw = JSON.stringify({ sections }); return generatedRaw;
  } } }), id = await sparseBrief(f);
  await f.run(`authority ${id} | ${"x".repeat(1000)}`); await f.run(`done ${id} | ${"y".repeat(623)}`);
  let raw = f.backend.data.get(f.key("state"));
  const good = await f.run(`polish ${id}`); assert.match(good, /unsaved suggestion/); assert.equal(good.length, 3500);
  assert.ok(generatedRaw.length < 4000); assert.equal(f.calls.generate, 1);
  assert.equal(f.backend.data.get(f.key("state")), raw);
  append = true; assert.match(await f.run(`polish ${id}`), /Optional assistance unavailable/);
  assert.equal(f.calls.generate, 2); assert.equal(f.backend.data.get(f.key("state")), raw);
  // A two-digit revision adds one required displayed unit without changing source text.
  for (let i = 0; i < 4; i++) await f.run(`unaccept ${id} confirm`);
  assert.equal((await record(f,id)).revision, 10); raw = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`polish ${id}`), /minimum complete reply needs 3501.*limit is 3500/);
  assert.equal(f.calls.generate, 2); assert.equal(f.backend.data.get(f.key("state")), raw);
});

test("delegation feasible preflight retains actual-output section and raw limits with one call and no repairs", async () => {
  let mode = "valid";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    const sections = exactSections(JSON.parse(input).sources);
    if (mode === "section") sections[0].text += "漢".repeat(Math.floor((1000 - Buffer.byteLength(sections[0].text)) / 3) + 1);
    const raw = JSON.stringify({ sections });
    if (mode === "units") return raw.padEnd(4001, " ");
    if (mode === "bytes") return "😀".repeat(4001);
    return raw;
  } } }), id = await create(f), raw = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`polish ${id}`), /unsaved suggestion/);
  for (mode of ["section", "units", "bytes"]) {
    const before = f.calls.generate;
    assert.match(await f.run(`polish ${id}`), /Optional assistance unavailable/);
    assert.equal(f.calls.generate, before + 1); assert.equal(f.backend.data.get(f.key("state")), raw);
  }
  assert.deepEqual(f.calls, { generate: 4, search: 0, readContext: 0 });
});

test("delegation complete contract remains one feasible unsaved call with every supplied field", async () => {
  let sources: { ref: string; quote: string }[] = [];
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    sources = JSON.parse(input).sources; return JSON.stringify({ sections: exactSections(sources) });
  } } }), id = await create(f);
  await f.run(`authority ${id} | Suggest changes; ask before publishing`);
  await f.run(`done ${id} | Three reproducible findings`);
  await f.run(`scope ${id} | in | First-time setup`); await f.run(`scope ${id} | out | Published copy`);
  await f.run(`resource ${id} | Existing walkthrough`); await f.run(`checkpoint ${id} | 2026-10-26 | Share findings`);
  const raw = f.backend.data.get(f.key("state")), reply = await f.run(`polish ${id}`);
  assert.match(reply, /unsaved suggestion/); assert.ok(reply.length <= 3500); assert.equal(sources.length, 9);
  for (const source of sources) assert.ok(reply.includes(`Entered: ${source.quote}\nSuggested: ${source.quote}`));
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.deepEqual(f.calls, { generate: 1, search: 0, readContext: 0 });
});
