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
 let cmd=`show ${id}`,all="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500);all+=reply;cmd=/Next: \/nobo-help agent audience-brief (show [^\n]+)/.exec(reply)?.[1]??"";n++;}while(cmd&&n<30);assert.ok(all.includes(r.facts[19].text));assert.ok(all.includes(r.audiences[4].id));assert.ok(Buffer.byteLength(await f.run(`export ${id}`))<=24576);
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

test("actual saved/report continuations recover complete data and reject edits, including revision-ceiling removals", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  for (let i=0;i<7;i++) await f.run(`fact ${id} add ${i} ${"漢😀".repeat(120)} | required`); const a = await addAudience(f,id,1000);
  const commands = [`show ${id}`, `render ${id} ${a}`];
  for (const command of commands) {
    let next = command, body = "", count = 0, firstContinuation = "";
    do {
      const reply = await f.run(next); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed());
      const header = /\nPage (\d+)\/(\d+)\n/.exec(reply); assert.ok(header, reply);
      assert.equal(Number(header[1]), ++count);
      const more = Number(header[1]) < Number(header[2]);
      const footer = more ? /\nNext: \/nobo-help agent audience-brief ([^\n]+)$/.exec(reply) : null;
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
    const restart = /Restart page 1: \/nobo-help agent audience-brief ([^\n]+)/.exec(rejected); assert.ok(restart);
    assert.match(await f.run(restart[1]), /Page 1\//);
  }
  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const page = await f.run(`show ${id}`), issued = /\nNext: \/nobo-help agent audience-brief ([^\n]+)$/.exec(page); assert.ok(issued);
  assert.match(await f.run(`clear ${id} title confirm`), /^Saved/);
  assert.equal((await record(f,id)).revision, 999_999_999);
  assert.match(await f.run(issued[1]), /stale continuation rejected/);
  assert.match(await f.run(`show ${id} 1 rev invalid`), /Invalid revision token/);
});

test("finite composition preserves every exact source and rejects changes, omissions, framing and structure attacks", async () => {
  let modify = (_output: any) => {}, sources: { ref: string; quote: string }[] = [], frameText = "";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    const data = JSON.parse(input); sources = data.sources;
    const frame = Object.keys(data.framing)[0]; frameText = data.framing[frame];
    const output = { sections: sources.map(s => ({ ...s, text: s.quote })), framing: [frame], layout: "compact" };
    modify(output); return JSON.stringify(output);
  } } }), id = await create(f);
  const a = await addAudience(f,id,100); await f.run(`lead ${id} | Pilot notes supplied by Maya`); await f.run(`ask ${id} | Approve a second group`); await f.run(`fact ${id} add Ten users completed onboarding, according to Maya | required`); await f.run(`fact ${id} add Two participants requested help, according to Noah | important`); await f.run(`fact ${id} add The outline is available | optional`);
  const command = `polish ${id} ${a}`, raw = f.backend.data.get(f.key("state"));
  const good = await f.run(command); assert.match(good, /unsaved suggestion/); assert.ok(good.includes(frameText));
  for (const source of sources) assert.ok(good.includes(source.quote), source.ref);
  const refs = sources.map(s => s.ref);
  const attacks: ((o: any) => void)[] = [
    o => { o.sections[0].ref = "unknown"; }, o => { o.sections[0].quote += " altered"; },
    o => { o.sections[1] = o.sections[0]; }, o => { o.sections[0].attribution = "external audit"; },
    o => { o.framing = ["unknown"]; }, o => { o.framing.push(o.framing[0]); },
    o => { o.framing = "thanks"; }, o => { o.framing = ["__proto__"]; },
    o => { o.layout = "approved commitment"; }, o => { o.layout = ["compact"]; },
    o => { o.commitment = "I guarantee Monday delivery"; },
  ];
  for (const ref of refs) {
    attacks.push(o => { o.sections.find((x: any) => x.ref === ref).text += " But I will work all weekend and Maya confirmed twenty users in an external audit on Tuesday."; });
    attacks.push(o => { o.sections = o.sections.filter((x: any) => x.ref !== ref); });
  }
  for (modify of attacks) {
    const calls = f.calls.generate, reply = await f.run(command);
    assert.match(reply, /Optional assistance unavailable/); assert.equal(f.calls.generate, calls + 1);
    assert.equal(f.backend.data.get(f.key("state")), raw);
  }
  // Ordering emitted by a provider cannot change roles or scope: the renderer owns it.
  modify = o => { o.sections.reverse(); o.framing = []; o.layout = "spaced"; };
  const spaced = await f.run(command); assert.match(spaced, /unsaved suggestion/);
  for (const source of sources) assert.ok(spaced.includes(source.quote));
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.calls.search, 0); assert.equal(f.calls.readContext, 0);
});

test("required exact composition refuses oversize before calling and never paginates unsaved output", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  const a = await addAudience(f,id,1000); for (let i=0;i<6;i++) await f.run(`fact ${id} add ${i} ${"x".repeat(900)} | required`);
  const raw = f.backend.data.get(f.key("state")), reply = await f.run(`polish ${id} ${a}`);
  assert.match(reply, /complete exact content cannot fit/); assert.match(reply, /deterministic pages.*explicitly shorten/);
  assert.ok(reply.length <= 3500); assert.doesNotMatch(reply, /Page \d/);
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("polish retains important facts and attributions; only explicitly optional facts may be omitted for budget", async () => {
  let supplied: { ref: string; quote: string }[] = [];
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    supplied = JSON.parse(input).sources; return JSON.stringify({ sections: supplied.map(s => ({ ...s, text: s.quote })) });
  } } }), id = await create(f), a = await addAudience(f,id,20);
  await f.run(`fact ${id} add ${Array(21).fill("important").join(" ")} | important`);
  const refused = await f.run(`polish ${id} ${a}`);
  assert.match(refused, /Required\/important facts.*Increase.*Nothing was dropped.*No model called/);
  assert.equal(f.calls.generate, 0);
  const fid = (await record(f,id)).facts[0].id;
  await f.run(`fact ${id} edit ${fid} | Ten users completed onboarding according to Maya | important`);
  await f.run(`lead ${id} | Pilot result`); await f.run(`ask ${id} | Approve another group`);
  await f.run(`fact ${id} add ${Array(21).fill("optional").join(" ")} | optional`);
  const good = await f.run(`polish ${id} ${a}`);
  assert.match(good, /unsaved suggestion/); assert.match(good, /optional; omitted for word budget/);
  assert.ok(supplied.some(s => s.ref === fid && s.quote === "Ten users completed onboarding according to Maya"));
  assert.ok(supplied.some(s => s.ref === "lead")); assert.ok(supplied.some(s => s.ref === "ask"));
  const optional = (await record(f,id)).facts[1].id;
  await f.run(`require ${id} ${a} | ${optional}`);
  assert.match(await f.run(`polish ${id} ${a}`), /No model called/); assert.equal(f.calls.generate, 1);
});

test("finite composition discards a removal at the revision ceiling", async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    entered.resolve(); await gate.promise; const { sources } = JSON.parse(input);
    return JSON.stringify({ sections: sources.map((s: { ref: string; quote: string }) => ({ ...s, text: s.quote })) });
  } } }), id = await create(f);
  const a = await addAudience(f,id); await f.run(`fact ${id} add Ten users according to Maya | required`);
  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const pending = f.run(`polish ${id} ${a}`); await entered.promise;
  assert.match(await f.run(`clear ${id} title confirm`), /^Saved/);
  const raw = f.backend.data.get(f.key("state")); gate.resolve();
  assert.match(await pending, /stale result was discarded/); assert.equal(f.backend.data.get(f.key("state")), raw);
});

test("minimum of finite layouts admits exact 3500, rejects 3501 before generation, and checks actual layout", async () => {
  let compact = false, wire = "";
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({input}) => {
    const {sources} = JSON.parse(input); wire = JSON.stringify({sections:sources.map((s: {ref:string;quote:string})=>({...s,text:s.quote})), ...(compact ? {layout:"compact"}: {})}); return wire;
  } } });
  const id = /audiencebrief-[\da-f-]{36}/.exec(await f.run("create Update"))![0];
  for(let i=0;i<17;i++) assert.match(await f.run(`fact ${id} add F | required`), /^Saved/);
  assert.match(await f.run(`audience ${id} add Team | update | 1000`), /^Saved/);
  const r = JSON.parse(await f.run(`export ${id}`)).record, aid = r.audiences[0].id;
  assert.match(await f.run(`lead ${id} | L`), /^Saved/);
  const baseline = await f.run(`polish ${id} ${aid}`); assert.match(baseline, /unsaved suggestion/);
  const size = 1 + 3500-baseline.length; assert.ok(size > 0 && size <= 1000, `${size}`);
  assert.match(await f.run(`lead ${id} | ${"L".repeat(size)}`), /^Saved/);
  const raw = f.backend.data.get(f.key("state")), calls = f.calls.generate;
  const reply = await f.run(`polish ${id} ${aid}`); assert.match(reply, /unsaved suggestion/); assert.equal(reply.length,3500); assert.equal(f.calls.generate,calls+1); assert.ok(wire.length < 4000);
  compact = true; assert.match(await f.run(`polish ${id} ${aid}`), /Optional assistance unavailable/); assert.equal(f.calls.generate,calls+2); assert.equal(f.backend.data.get(f.key("state")), raw);
  assert.match(await f.run(`lead ${id} | ${"L".repeat(size+1)}`), /^Saved/);
  const over = f.backend.data.get(f.key("state")); assert.match(await f.run(`polish ${id} ${aid}`), /complete exact content cannot fit/); assert.equal(f.calls.generate,calls+2); assert.equal(f.backend.data.get(f.key("state")),over);
});
