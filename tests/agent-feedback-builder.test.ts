import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/feedback-builder.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
async function create(f:ReturnType<typeof createAgentFeatureFixture>){return /feedback-[\da-f-]{36}/.exec(await f.run(feature.example.split("feedback-builder ")[1]))![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}

test("catalog first example produces observation-impact-request feedback without any service",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),observation="The document arrived after the meeting began",impact="I could not prepare questions",request="Share the document one working day before the meeting";
 assert.match(await f.run(`check ${id}`),/Missing: observable behavior\/example, personal impact, specific request/);
 await f.run(`behavior ${id} | ${observation}`);await f.run(`impact ${id} | ${impact}`);await f.run(`request ${id} | ${request}`);
 const draft=await f.run(`draft ${id}`);assert.ok(draft.includes(`Observation supplied: ${observation}`));assert.ok(draft.includes(`Personal impact: ${impact}`));assert.ok(draft.includes(`Requested change: ${request}`));assert.match(draft,/Missing: none/);
 assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});assert.match(await f.run(`polish ${id}`),/Optional assistance unavailable/);assert.ok((await f.run(`draft ${id}`)).includes(observation));
});
test("exact motive text stays an interpretation; lexical matches retain case and are labeled heuristics",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),motive="I think they don't care about my time";
 await f.run(`inference ${id} | ${motive}`);await f.run(`behavior ${id} | You ALWAYS deliberately arrive late`);await f.run(`request ${id} | Try harder`);
 const check=await f.run(`check ${id}`);assert.match(check,/Lexical heuristics only/);assert.ok(check.includes('"ALWAYS"'));assert.ok(check.includes('"deliberately"'));assert.ok(check.includes('"Try harder"'));
 let draft=await f.run(`draft ${id}`);assert.ok(draft.includes(motive));assert.ok(!draft.includes(`Observation supplied: ${motive}`));
 await f.run(`reclassify ${id} confirm`);const r=await record(f,id);assert.equal(r.behavior,"");assert.equal(r.inferences[1].text,"You ALWAYS deliberately arrive late");
 draft=await f.run(`draft ${id}`);assert.match(draft,/missing observable example/);assert.match(draft,/unverified; not an observation/);
});
test("all fields and labeled interpretations can be edited and cleared; bad inputs are atomic",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 for(const field of ["title","situation","behavior","impact","request","positive"]){await f.run(`edit ${id} | ${field} | Exact & <label>`);assert.equal((await record(f,id))[field],"Exact & <label>");await f.run(`clear ${id} ${field} confirm`);assert.equal((await record(f,id))[field],"");}
 await f.run(`inference ${id} | Interpretation`);const e=(await record(f,id)).inferences[0];await f.run(`interpretation ${id} edit ${e.id} | Revised interpretation`);assert.equal((await record(f,id)).inferences[0].text,"Revised interpretation");
 const raw=f.backend.data.get(f.key("state"));for(const cmd of [`request ${id} | a | b`,`edit ${id} | intent | invented`,`behavior ${id} | bad\\q`])assert.doesNotMatch(await f.run(cmd),/^Saved/);assert.equal(f.backend.data.get(f.key("state")),raw);
 await f.run(`interpretation ${id} remove ${e.id} confirm`);assert.equal((await record(f,id)).inferences.length,0);await f.run(`delete ${id} confirm`);assert.match(await f.run("list"),/No saved items/);
});
test("final retained interpretation is recoverable and near-quota Unicode remains renderable/deletable",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);for(let i=0;i<20;i++)await f.run(`inference ${id} | ${i} ${"🧭".repeat(220)}`);
 const r=await record(f,id);assert.equal(r.inferences.length,20);assert.match(await f.run(`inference ${id} | too many`),/Maximum 20/);
 let cmd=`show ${id}`,output="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500);output+=reply;cmd=/Next: \/nobo-help agent feedback-builder (show [^\n]+)/.exec(reply)?.[1]??"";n++;}while(cmd&&n<30);
 assert.ok(output.includes(r.inferences[19].text));assert.ok(output.includes(r.inferences[19].id));
 const id2=await create(f);let full=false;for(let i=0;i<20;i++){const raw=f.backend.data.get(f.key("state"));const reply=await f.run(`inference ${id2} | ${"漢".repeat(320)}`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),raw);full=true;break;}}assert.ok(full);
 assert.match(await f.run(`check ${id2}`),/Lexical heuristics/);assert.match(await f.run(`delete ${id2} confirm`),/^Deleted/);
});
test("polish cannot rewrite interpretations into observed facts, or accept fabricated references/quotes/oversize",async()=>{
 let mode="valid";const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const {sources}=JSON.parse(input);const sections=sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}));if(mode==="motive")sections.find((s:{ref:string})=>s.ref.startsWith("inference-")).text="They are disrespectful";if(mode==="observation")sections.find((s:{ref:string})=>s.ref==="behavior").text="They intentionally delayed it";if(mode==="unknown")sections[0].ref="fake";if(mode==="quote")sections[0].quote="changed";if(mode==="huge")return "x".repeat(4001);return JSON.stringify({sections});}}});
 const id=await create(f);await f.run(`behavior ${id} | The document arrived at 10:03`);await f.run(`inference ${id} | I suspect a misunderstanding`);const raw=f.backend.data.get(f.key("state"));
 assert.match(await f.run(`polish ${id}`),/unsaved suggestion/);for(mode of ["motive","observation","unknown","quote","huge"])assert.match(await f.run(`polish ${id}`),/Optional assistance unavailable/);
 assert.equal(f.backend.data.get(f.key("state")),raw);assert.equal(f.calls.generate,6);
});
test("edits and deletion discard pending suggestions; private owners cannot inspect another case",async()=>{
 for(const action of ["edit","delete"]){const gate=deferred<void>(),entered=deferred<void>();const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();await gate.promise;const {sources}=JSON.parse(input);return JSON.stringify({sections:sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote}))});}}});const id=await create(f),pending=f.run(`polish ${id}`);await entered.promise;
 await f.run(action==="edit"?`impact ${id} | I missed a question`:`delete ${id} confirm`);const raw=f.backend.data.get(f.key("state"));gate.resolve();assert.match(await pending,/stale result was discarded/);assert.equal(f.backend.data.get(f.key("state")),raw);assert.match(await f.run(`show ${id}`,{owner:{teamId:"TOTHER",userId:"UOTHER"}}),/not found/);}
});

// These races pause the real backend CAS and complete a newer real command first.
test("mutation intent rejects same-record races, preserves deletions, and retries unrelated records", async () => {
  for (let scenario = 0; scenario < 7; scenario++) {
    let compete: (() => Promise<void>) | undefined;
    const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
      if (key.endsWith(":state") && compete) { const run = compete; compete = undefined; await run(); }
    } });
    const f = createAgentFeatureFixture(feature, { backend }), id = await create(f);
    await f.run(`behavior ${id} | He does not care`); await f.run(`inference ${id} | Initial interpretation`);
    const initial = await record(f, id);
    const commands = (() => { const entry = initial.inferences[0].id;
    return [
      [`reclassify ${id} confirm`, `behavior ${id} | Document arrived at 10:05`],
      [`behavior ${id} | Old observation`, `reclassify ${id} confirm`],
      [`interpretation ${id} remove ${entry} confirm`, `interpretation ${id} edit ${entry} | Revised interpretation`],
      [`clear ${id} situation confirm`, `edit ${id} | situation | Revised situation`],
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

test("actual saved/report continuations recover complete data and reject edits, including revision-ceiling removals", async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  for (let i=0;i<7;i++) await f.run(`inference ${id} | ${i} ${"漢😀".repeat(120)}`);
  const commands = [`show ${id}`, `draft ${id}`, `check ${id}`];
  for (const command of commands) {
    let next = command, body = "", count = 0, firstContinuation = "";
    do {
      const reply = await f.run(next); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed());
      const header = /\nPage (\d+)\/(\d+)\n/.exec(reply); assert.ok(header, reply);
      assert.equal(Number(header[1]), ++count);
      const more = Number(header[1]) < Number(header[2]);
      const footer = more ? /\nNext: \/nobo-help agent feedback-builder ([^\n]+)$/.exec(reply) : null;
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
    const restart = /Restart page 1: \/nobo-help agent feedback-builder ([^\n]+)/.exec(rejected); assert.ok(restart);
    assert.match(await f.run(restart[1]), /Page 1\//);
  }
  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const page = await f.run(`show ${id}`), issued = /\nNext: \/nobo-help agent feedback-builder ([^\n]+)$/.exec(page); assert.ok(issued);
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
  await f.run(`behavior ${id} | The document arrived at 10:03`); await f.run(`impact ${id} | I missed the review`); await f.run(`request ${id} | Share an outline for review`); await f.run(`positive ${id} | You shared an outline`); await f.run(`inference ${id} | I suspect a misunderstanding`);
  const command = `polish ${id}`, raw = f.backend.data.get(f.key("state"));
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
  for (const field of ["situation","behavior","impact","request","positive"]) await f.run(`edit ${id} | ${field} | ${"x".repeat(900)}`);
  const raw = f.backend.data.get(f.key("state")), reply = await f.run(`polish ${id}`);
  assert.match(reply, /complete exact content cannot fit/); assert.match(reply, /deterministic pages.*explicitly shorten/);
  assert.ok(reply.length <= 3500); assert.doesNotMatch(reply, /Page \d/);
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("finite composition discards a removal at the revision ceiling", async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
    entered.resolve(); await gate.promise; const { sources } = JSON.parse(input);
    return JSON.stringify({ sections: sources.map((s: { ref: string; quote: string }) => ({ ...s, text: s.quote })) });
  } } }), id = await create(f);

  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const pending = f.run(`polish ${id}`); await entered.promise;
  assert.match(await f.run(`clear ${id} title confirm`), /^Saved/);
  const raw = f.backend.data.get(f.key("state")); gate.resolve();
  assert.match(await pending, /stale result was discarded/); assert.equal(f.backend.data.get(f.key("state")), raw);
});

test("both finite layouts preserve complete feedback at the raw-output boundary", async () => {
  let compact=false, wire="";
  const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const {sources}=JSON.parse(input);wire=JSON.stringify({sections:sources.map((s:{ref:string;quote:string})=>({...s,text:s.quote})),...(compact?{layout:"compact"}: {})});return wire;}}});
  const id=await create(f);
  await f.run(`edit ${id} | situation | ${"S".repeat(1000)}`); await f.run(`behavior ${id} | B`);
  const baseline=await f.run(`polish ${id}`);assert.match(baseline,/unsaved suggestion/);
  const growth=Math.floor((4000-wire.length)/2), size=1+growth;assert.ok(size<=1000);
  await f.run(`behavior ${id} | ${"B".repeat(size)}`);
  const raw=f.backend.data.get(f.key("state")),calls=f.calls.generate;
  const spaced=await f.run(`polish ${id}`);assert.match(spaced,/unsaved suggestion/);assert.ok(wire.length===3999||wire.length===4000);assert.equal(f.calls.generate,calls+1);
  // Explicit layout metadata itself pushes this near-limit provider JSON over its cap.
  compact=true;assert.match(await f.run(`polish ${id}`),/Optional assistance unavailable/);assert.equal(f.calls.generate,calls+2);assert.equal(f.backend.data.get(f.key("state")),raw);
  compact=false;await f.run(`behavior ${id} | ${"B".repeat(size+1)}`);const over=f.backend.data.get(f.key("state"));
  assert.match(await f.run(`polish ${id}`),/complete exact content cannot fit/);assert.equal(f.calls.generate,calls+2);assert.equal(f.backend.data.get(f.key("state")),over);
  await f.run(`behavior ${id} | B`);const shortSpaced=await f.run(`polish ${id}`);compact=true;const shortCompact=await f.run(`polish ${id}`);assert.match(shortCompact,/unsaved suggestion/);assert.equal(shortCompact.length,shortSpaced.length+1);
});
