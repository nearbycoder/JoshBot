import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/boundary-script.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
async function create(f: ReturnType<typeof createAgentFeatureFixture>) { return /boundary-[\da-f-]{36}/.exec(await f.run(feature.example.split("boundary-script ")[1]))![0]; }
async function record(f: ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}

test("catalog reduce workflow uses the actual alternative exactly once, with explicit prohibition",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),alternative="I can provide the existing dashboard link";
 await f.run(`stance ${id} | reduce`);assert.match(await f.run(`draft ${id}`),/Incomplete: explicit reduced scope/);
 await f.run(`offer ${id} | ${alternative}`);await f.run(`avoid ${id} | No promise of a new report`);
 const draft=await f.run(`draft ${id}`);assert.equal(draft.split(alternative).length-1,1);assert.match(draft,/Proposed reduced scope/);assert.match(draft,/No promise of a new report/);
 assert.doesNotMatch(draft,/Incomplete:/);assert.match(draft,/no agreement or promise recorded/);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("defer requires a civil date, reduce needs explicit scope, and commitment words are only heuristics",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`stance ${id} | defer`);
 const before=f.backend.data.get(f.key("state"));assert.match(await f.run(`draft ${id}`),/missing; no date guessed/);assert.equal(f.backend.data.get(f.key("state")),before);
 assert.doesNotMatch(await f.run(`date ${id} | 2026-02-30`),/^Saved/);await f.run(`date ${id} | 2026-11-02`);
 assert.match(await f.run(`draft ${id}`),/not a delivery promise: 2026-11-02/);
 await f.run(`stance ${id} | reduce`);await f.run(`scope ${id} | Two existing charts`);await f.run(`offer ${id} | I will send a link`);
 const draft=await f.run(`draft ${id}`);assert.match(draft,/Proposed reduced scope: Two existing charts/);assert.match(draft,/heuristic in offer: "will"/);
});
test("all fields and prohibitions support edits/removal, with precise invalid-command preservation",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 for(const key of ["title","constraint","offer","date","scope"]){const value=key==="date"?"2026-10-29":"Entered <@UOTHER> & value";await f.run(`edit ${id} | ${key} | ${value}`);assert.equal((await record(f,id))[key],value);await f.run(`clear ${id} ${key} confirm`);assert.equal((await record(f,id))[key],"");}
 await f.run(`clear ${id} stance confirm`);assert.equal((await record(f,id)).stance,null);
 await f.run(`avoid ${id} | No overtime`);const e=(await record(f,id)).avoid[0];await f.run(`prohibition ${id} edit ${e.id} | No added work`);assert.equal((await record(f,id)).avoid[0].text,"No added work");
 const prior=f.backend.data.get(f.key("state"));assert.match(await f.run(`stance ${id} | agree`),/Stance must/);assert.doesNotMatch(await f.run(`offer ${id} | a | b`),/^Saved/);assert.equal(f.backend.data.get(f.key("state")),prior);
 await f.run(`prohibition ${id} remove ${e.id} confirm`);assert.equal((await record(f,id)).avoid.length,0);await f.run(`delete ${id} confirm`);assert.match(await f.run("list"),/No saved items/);
});
test("maximal final prohibition survives full pages and Unicode admission rejects atomically",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 for(let i=0;i<20;i++)assert.match(await f.run(`avoid ${id} | ${i} ${"界".repeat(300)}`),/^Saved/);
 const r=await record(f,id);assert.equal(r.avoid.length,20);assert.match(await f.run(`avoid ${id} | 21`),/Maximum 20/);
 let cmd=`show ${id}`,all="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500);all+=reply;cmd=/Next: \/nobo-help agent boundary-script (show [^\n]+)/.exec(reply)?.[1]??"";n++;}while(cmd&&n<30);
 assert.ok(all.includes(r.avoid[19].id));assert.ok(all.includes(r.avoid[19].text));assert.ok(Buffer.byteLength(await f.run(`export ${id}`))<=24576);
 const id2=await create(f);let rejected=false;for(let i=0;i<20;i++){const previous=f.backend.data.get(f.key("state"));const reply=await f.run(`avoid ${id2} | ${"🧭".repeat(240)}`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),previous);rejected=true;break;}}
 assert.ok(rejected);assert.match(await f.run(`draft ${id2}`),/Private/);assert.match(await f.run(`delete ${id2} confirm`),/^Deleted/);
});
test("polish keeps deterministic template alongside suggestion and rejects quotes, unknown fields and overflow",async()=>{
 let mode="valid";const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const {sources}=JSON.parse(input);const sections=sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}));if(mode==="quote")sections[0].quote="invented";if(mode==="extra")sections[0].agreement=true;if(mode==="huge")return "x".repeat(4001);return JSON.stringify({sections});}}});
 const id=await create(f),before=f.backend.data.get(f.key("state"));const good=await f.run(`polish ${id} | warm`);assert.match(good,/Deterministic template/);assert.match(good,/Optional wording \(warm\)/);assert.ok(good.length<=3500);
 for(mode of ["quote","extra","huge"])assert.match(await f.run(`polish ${id} | direct`),/Optional assistance unavailable/);
 assert.equal(f.backend.data.get(f.key("state")),before);assert.match(await f.run(`draft ${id}`),/My limit/);
 const throwing=createAgentFeatureFixture(feature);const t=await create(throwing);assert.match(await throwing.run(`polish ${t} | warm`),/Optional assistance unavailable/);
});
test("pending tone suggestions cannot outlive edits/deletion and owners cannot see scenarios",async()=>{
 for(const action of ["edit","delete"]){const gate=deferred<void>(),entered=deferred<void>();const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();await gate.promise;const {sources}=JSON.parse(input);return JSON.stringify({sections:sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}))});}}});
 const id=await create(f),pending=f.run(`polish ${id} | direct`);await entered.promise;await f.run(action==="edit"?`offer ${id} | Discuss next week`:`delete ${id} confirm`);gate.resolve();assert.match(await pending,/stale result was discarded/);
 assert.match(await f.run(`show ${id}`,{owner:{teamId:"TOTHER",userId:"UOTHER"}}),/not found/);}
});

// These races pause the real backend CAS and complete a newer real command first.
test("mutation intent rejects same-record races, preserves deletions, and retries unrelated records", async () => {
  for (let scenario = 0; scenario < 7; scenario++) {
    let compete: (() => Promise<void>) | undefined;
    const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
      if (key.endsWith(":state") && compete) { const run = compete; compete = undefined; await run(); }
    } });
    const f = createAgentFeatureFixture(feature, { backend }), id = await create(f);
    await f.run(`avoid ${id} | No weekend work`);
    const initial = await record(f, id);
    const commands = (() => { const entry = initial.avoid[0].id;
    return [
      [`offer ${id} | OLD offer`, `offer ${id} | LATER offer`],
      [`stance ${id} | decline`, `stance ${id} | defer`],
      [`prohibition ${id} remove ${entry} confirm`, `prohibition ${id} edit ${entry} | No Monday promise`],
      [`clear ${id} constraint confirm`, `edit ${id} | constraint | New capacity limit`],
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

  const original = await f.store().read<any>("state");
  for (const bad of [["decline"], [["decline"]], { toString: "decline" }, 1, true, "unknown"]) {
    const state = structuredClone(original), r = state.records[0]; r.stance = bad;
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
  for (let i=0;i<7;i++) await f.run(`avoid ${id} | ${i} ${"漢😀".repeat(120)}`);
  const commands = [`show ${id}`, `draft ${id}`];
  for (const command of commands) {
    let next = command, body = "", count = 0, firstContinuation = "";
    do {
      const reply = await f.run(next); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed());
      const header = /\nPage (\d+)\/(\d+)\n/.exec(reply); assert.ok(header, reply);
      assert.equal(Number(header[1]), ++count);
      const more = Number(header[1]) < Number(header[2]);
      const footer = more ? /\nNext: \/nobo-help agent boundary-script ([^\n]+)$/.exec(reply) : null;
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
    const restart = /Restart page 1: \/nobo-help agent boundary-script ([^\n]+)/.exec(rejected); assert.ok(restart);
    assert.match(await f.run(restart[1]), /Page 1\//);
  }
  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const page = await f.run(`show ${id}`), issued = /\nNext: \/nobo-help agent boundary-script ([^\n]+)$/.exec(page); assert.ok(issued);
  assert.match(await f.run(`clear ${id} title confirm`), /^Saved/);
  assert.equal((await record(f,id)).revision, 999_999_999);
  assert.match(await f.run(issued[1]), /stale continuation rejected/);
  assert.match(await f.run(`show ${id} 1 rev invalid`), /Invalid revision token/);
});
