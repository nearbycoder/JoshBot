import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/audience-brief.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
async function create(f:ReturnType<typeof createAgentFeatureFixture>){return /audiencebrief-[\da-f-]{36}/.exec(await f.run(feature.example.split("audience-brief ")[1]))![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}
async function addAudience(f:ReturnType<typeof createAgentFeatureFixture>,id:string,budget=100){return /audience-[\da-f-]{36}/.exec(await f.run(`audience ${id} add Sponsor | Outcome and next decision | ${budget}`))![0];}

test("catalog workflow preserves the exact fact and ask while reporting complete coverage",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),original="Ten users completed onboarding";
 const fact=/fact-[\da-f-]{36}/.exec(await f.run(`fact ${id} add ${original} | required`))![0],a=await addAudience(f,id);
 await f.run(`require ${id} ${a} | ${fact}`);await f.run(`ask ${id} | Approve a second pilot group`);
 const reply=await f.run(`render ${id} ${a}`);assert.ok(reply.includes(original));assert.match(reply,/Ask: Approve a second pilot group/);assert.match(reply,/9\/100 words/);assert.match(reply,/audience-required · included/);
 assert.equal((await record(f,id)).facts[0].text,original);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("required overflow is explicit and prevents even optional generation",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),a=await addAudience(f,id,20),long=Array.from({length:21},(_,i)=>`fact${i}`).join(" ");
 await f.run(`fact ${id} add ${long} | required`);const reply=await f.run(`render ${id} ${a}`);assert.match(reply,/need 21 words; budget 20; short by 1/);assert.match(reply,/No complete variant produced/);assert.doesNotMatch(reply,/Unsent variant:/);
 assert.match(await f.run(`polish ${id} ${a}`),/No model called/);assert.equal(f.calls.generate,0);assert.equal((await record(f,id)).facts[0].text,long);
});
test("selection uses importance then audience-needs overlap and stable entered order, with every omission disclosed",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),a=await addAudience(f,id,20);
 const first="The team discussed process details with the operations group on Tuesday";
 const relevant="The next decision concerns expansion after the outcome review on Friday";
 await f.run(`fact ${id} add ${first} | optional`);await f.run(`fact ${id} add ${relevant} | optional`);
 let reply=await f.run(`render ${id} ${a}`);assert.ok(reply.includes(relevant));assert.ok(!reply.includes(first));assert.match(reply,/omitted: word budget/);
 const r=await record(f,id);await f.run(`fact ${id} edit ${r.facts[0].id} | ${first} | important`);
 reply=await f.run(`render ${id} ${a}`);assert.ok(reply.includes(first));assert.ok(!reply.includes(relevant));assert.equal((await record(f,id)).facts[1].text,relevant);
});
test("canonical fields, facts, audience needs/budget and requirements all edit/remove without retained variants",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),a=await addAudience(f,id);await f.run(`fact ${id} add Original canonical fact | optional`);const fid=(await record(f,id)).facts[0].id;
 await f.run(`require ${id} ${a} | ${fid}`);await f.run(`unrequire ${id} ${a} | ${fid} confirm`);assert.deepEqual((await record(f,id)).audiences[0].requiredFactIds,[]);
 for(const field of ["title","lead","ask"]){await f.run(`edit ${id} | ${field} | Entered & <text>`);assert.equal((await record(f,id))[field],"Entered & <text>");await f.run(`clear ${id} ${field} confirm`);assert.equal((await record(f,id))[field],"");}
 await f.run(`audience ${id} edit ${a} | Reviewer | Onboarding friction | 40`);const revision=(await record(f,id)).revision;
 await f.run(`fact ${id} edit ${fid} | Updated canonical fact | required`);const r=await record(f,id);assert.equal(r.facts[0].text,"Updated canonical fact");assert.equal(r.revision,revision+1);assert.ok(!Object.hasOwn(r,"variants"));
 await f.run(`require ${id} ${a} | ${fid}`);await f.run(`fact ${id} remove ${fid} confirm`);assert.deepEqual((await record(f,id)).audiences[0].requiredFactIds,[]);
 await f.run(`audience ${id} remove ${a} confirm`);assert.equal((await record(f,id)).audiences.length,0);await f.run(`delete ${id} confirm`);assert.match(await f.run("list"),/No saved items/);
});
test("maximal final facts/audiences and Unicode quota retain complete retrieval and deletion",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);for(let i=0;i<20;i++)assert.match(await f.run(`fact ${id} add ${i} ${"界".repeat(280)} | optional`),/^Saved/);
 for(let i=0;i<5;i++)await addAudience(f,id);const r=await record(f,id);assert.equal(r.facts.length,20);assert.equal(r.audiences.length,5);assert.match(await f.run(`fact ${id} add excess | optional`),/Maximum 20/);assert.match(await f.run(`audience ${id} add excess | needs | 20`),/Maximum 5/);
 let cmd=`show ${id}`,all="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500);all+=reply;cmd=/Next: \/nobo-help agent audience-brief (show \S+ \d+)/.exec(reply)?.[1]??"";n++;}while(cmd&&n<30);assert.ok(all.includes(r.facts[19].text));assert.ok(all.includes(r.audiences[4].id));assert.ok(Buffer.byteLength(await f.run(`export ${id}`))<=24576);
 const id2=await create(f);let rejected=false;for(let i=0;i<20;i++){const old=f.backend.data.get(f.key("state"));const reply=await f.run(`fact ${id2} add ${"🧭".repeat(240)} | required`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),old);rejected=true;break;}}assert.ok(rejected);assert.match(await f.run(`delete ${id2} confirm`),/^Deleted/);
});
test("optional narratives validate coverage, exact quotes, all references and word budget without mutating facts",async()=>{
 let mode="valid";const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const {sources}=JSON.parse(input);const sections=sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}));if(mode==="unknown")sections[0].ref="invented";if(mode==="quote")sections[0].quote="Eleven users";if(mode==="missing")sections.pop();if(mode==="words")sections[0].text="word ".repeat(21);if(mode==="extra")sections[0].invention="unsupported";if(mode==="huge")return "x".repeat(4001);return JSON.stringify({sections});}}});
 const id=await create(f),a=await addAudience(f,id,20);await f.run(`fact ${id} add Ten users completed onboarding | required`);await f.run(`ask ${id} | Approve a second group`);const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`polish ${id} ${a}`),/unsaved suggestion/);
 for(mode of ["unknown","quote","missing","words","extra","huge"])assert.match(await f.run(`polish ${id} ${a}`),/Optional assistance unavailable/);assert.equal(f.backend.data.get(f.key("state")),raw);assert.equal((await record(f,id)).facts[0].text,"Ten users completed onboarding");
});
test("editing a canonical fact or deleting the brief discards an in-flight narrative",async()=>{
 for(const action of ["edit","delete"]){const entered=deferred<void>(),gate=deferred<void>();const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();await gate.promise;const {sources}=JSON.parse(input);return JSON.stringify({sections:sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}))});}}});const id=await create(f),a=await addAudience(f,id);await f.run(`fact ${id} add Original fact | required`);const fid=(await record(f,id)).facts[0].id,pending=f.run(`polish ${id} ${a}`);await entered.promise;await f.run(action==="edit"?`fact ${id} edit ${fid} | Changed fact | required`:`delete ${id} confirm`);gate.resolve();assert.match(await pending,/stale result was discarded/);}
});
test("CAS retry validates requirements against current facts; invalid saved references and foreign owners remain private",async()=>{
 let conflict=false;const backend=createMemoryAgentBackend({beforeCompareSet:(key,previous)=>{if(conflict&&previous&&key.endsWith(":state")){conflict=false;const s=JSON.parse(previous);s.records[0].facts=[];s.records[0].revision++;backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),id=await create(f),a=await addAudience(f,id);await f.run(`fact ${id} add Disposable | optional`);const fid=(await record(f,id)).facts[0].id;conflict=true;
 assert.match(await f.run(`require ${id} ${a} | ${fid}`),/changed before.*Inspect/);assert.equal(backend.calls.conflicts,1);assert.deepEqual((await record(f,id)).audiences[0].requiredFactIds,[]);
 assert.match(await f.run(`show ${id}`,{owner:{teamId:"TOTHER",userId:"UOTHER"}}),/not found/);
 const bad=JSON.parse(backend.data.get(f.key("state"))!);bad.records[0].audiences[0].requiredFactIds=[fid];const raw=JSON.stringify(bad);backend.data.set(f.key("state"),raw);assert.match(await f.run(`delete ${id} confirm`),/preserved/);assert.equal(backend.data.get(f.key("state")),raw);
});

// These races pause the real backend CAS and complete a newer real command first.
test("mutation intent rejects same-record races, preserves deletions, and retries unrelated records", async () => {
  for (let scenario = 0; scenario < 7; scenario++) {
    let compete: (() => Promise<void>) | undefined;
    const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
      if (key.endsWith(":state") && compete) { const run = compete; compete = undefined; await run(); }
    } });
    const f = createAgentFeatureFixture(feature, { backend }), id = await create(f);
    await f.run(`fact ${id} add Original fact | required`); await f.run(`audience ${id} add Sponsor | Needs | 100`);
    const initial = await record(f, id);
    const commands = (() => { const entry = initial.facts[0].id, a = initial.audiences[0].id;
    return [
      [`fact ${id} edit ${entry} | OLD fact | required`, `fact ${id} edit ${entry} | LATER fact | required`],
      [`fact ${id} remove ${entry} confirm`, `require ${id} ${a} | ${entry}`],
      [`require ${id} ${a} | ${entry}`, `audience ${id} edit ${a} | Reviewer | New needs | 50`],
      [`clear ${id} lead confirm`, `lead ${id} | New lead`],
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
  await f.run(`fact ${id} add Fact | required`); const a = await addAudience(f, id);
  const original = await f.store().read<any>("state");
  for (const bad of [["required"], [["required"]], { toString: "required" }, 1, true, "unknown"]) {
    const state = structuredClone(original), r = state.records[0]; r.facts[0].importance = bad;
    const raw = JSON.stringify(state); f.backend.data.set(f.key("state"), raw);
    for (const command of [`show ${id}`, `export ${id}`, "list", `render ${id} ${a}`, `edit ${id} | title | Replacement`, `delete ${id} confirm`]) {
      assert.match(await f.run(command), /could not be read safely.*preserved/);
      assert.equal(f.backend.data.get(f.key("state")), raw);
    }
  }
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
