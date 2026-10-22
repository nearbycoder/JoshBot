import test from "node:test";
import assert from "node:assert/strict";
import feature from "../lib/agent-features/difficult-conversation.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
async function create(f:ReturnType<typeof createAgentFeatureFixture>){return /rehearsal-[\da-f-]{36}/.exec(await f.run(feature.example.split("difficult-conversation ")[1]))![0];}
async function record(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return JSON.parse(await f.run(`export ${id}`)).record;}
async function addCard(f:ReturnType<typeof createAgentFeatureFixture>,id:string){return /card-[\da-f-]{36}/.exec(await f.run(`objection ${id} add We need the whole report | Which section is essential for Friday?`))![0];}

test("catalog rehearsal hides the prepared response until review, records an attempt and boundary checklist",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);await f.run(`boundary ${id} | No weekend work`);const c=await addCard(f,id);
 const practice=await f.run(`practice ${id} ${c}`);assert.match(practice,/We need the whole report/);assert.match(practice,/Agree on a feasible scope/);assert.doesNotMatch(practice,/Which section is essential for Friday/);
 assert.match(await f.run(`review ${id} ${c}`),/Record an attempt before review/);
 const response="I can deliver the summary Friday and appendices Monday";const saved=await f.run(`respond ${id} | ${response}`);assert.match(saved,/active practice finished/);
 const review=await f.run(`review ${id} ${c}`);assert.ok(review.includes(response));assert.match(review,/Which section is essential for Friday/);assert.match(review,/Current boundary: No weekend work/);assert.match(review,/self-rating not recorded/);
 assert.equal((await record(f,id)).activeCard,null);assert.deepEqual(f.calls,{generate:0,search:0,readContext:0});
});
test("one active turn, explicit cancellation, two attempts and user self-ratings",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f),c=await addCard(f,id),c2=await addCard(f,id);
 await f.run(`practice ${id} ${c}`);assert.match(await f.run(`practice ${id} ${c2}`),/already active/);await f.run(`cancel ${id} confirm`);assert.match(await f.run(`respond ${id} | Orphan response`),/No active/);
 for(let i=0;i<2;i++){await f.run(`practice ${id} ${c}`);assert.match(await f.run(`respond ${id} | Attempt ${i}`),/^Saved/);}assert.match(await f.run(`practice ${id} ${c}`),/two retained attempts/);
 const a=(await record(f,id)).cards[0].attempts[1].id;await f.run(`rate ${id} ${c} ${a} | 4`);assert.equal((await record(f,id)).cards[0].attempts[1].rating,4);
 await f.run(`unrate ${id} ${c} ${a} confirm`);assert.equal((await record(f,id)).cards[0].attempts[1].rating,null);const raw=f.backend.data.get(f.key("state"));assert.match(await f.run(`rate ${id} ${c} ${a} | 6`),/from 1 to 5/);assert.equal(f.backend.data.get(f.key("state")),raw);
});
test("all preparation fields, cards, response attempts and ratings can be revised or removed",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);
 for(const field of ["title","goal","opening","boundary","concession","stop"]){await f.run(`edit ${id} | ${field} | Entered <label> & text`);assert.equal((await record(f,id))[field],"Entered <label> & text");await f.run(`clear ${id} ${field} confirm`);assert.equal((await record(f,id))[field],"");}
 await f.run(`edit ${id} | goal | A feasible agreement`);const c=await addCard(f,id);await f.run(`objection ${id} edit ${c} | New objection | New prepared response`);assert.equal((await record(f,id)).cards[0].response,"New prepared response");
 await f.run(`practice ${id} ${c}`);await f.run(`respond ${id} | Original attempt`);const a=(await record(f,id)).cards[0].attempts[0].id;
 assert.match(await f.run(`objection ${id} edit ${c} | Changed question | Changed answer`),/Remove retained attempts explicitly/);
 await f.run(`rate ${id} ${c} ${a} | 5`);await f.run(`attempt ${id} ${c} edit ${a} | Updated attempt`);const r=await record(f,id);assert.equal(r.cards[0].attempts[0].text,"Updated attempt");assert.equal(r.cards[0].attempts[0].rating,null);
 await f.run(`attempt ${id} ${c} remove ${a} confirm`);await f.run(`objection ${id} edit ${c} | Changed question | Changed answer`);assert.equal((await record(f,id)).cards[0].objection,"Changed question");
 await f.run(`objection ${id} remove ${c} confirm`);assert.equal((await record(f,id)).cards.length,0);await f.run(`delete ${id} confirm`);assert.match(await f.run("list"),/No saved items/);
});
test("maximal card and final attempt remain accessible through bounded complete detail/review",async()=>{
 const f=createAgentFeatureFixture(feature),id=await create(f);for(let i=0;i<12;i++)assert.match(await f.run(`objection ${id} add Objection ${i} | Prepared response ${i}`),/^Saved/);
 let r=await record(f,id);assert.equal(r.cards.length,12);assert.match(await f.run(`objection ${id} add Excess | Excess`),/Maximum 12/);
 const last=r.cards[11].id;for(let i=0;i<2;i++){await f.run(`practice ${id} ${last}`);await f.run(`respond ${id} | ${"🧭".repeat(80)}`);}r=await record(f,id);assert.equal(r.cards[11].attempts.length,2);
 let cmd=`show ${id}`,all="",n=0;do{const reply=await f.run(cmd);assert.ok(reply.length<=3500);all+=reply;cmd=/Next: \/nobo-help agent difficult-conversation (show [^\n]+)/.exec(reply)?.[1]??"";n++;}while(cmd&&n<30);
 assert.ok(all.includes(r.cards[11].attempts[1].id));assert.ok(all.includes(r.cards[11].attempts[1].text));assert.ok(Buffer.byteLength(await f.run(`export ${id}`))<=24576);
 assert.match(await f.run(`review ${id} ${last}`),/Prepared response 11/);
});
test("near-capacity admission reserves every mandatory worst-case escaped attempt and rating",async()=>{
 const f=createAgentFeatureFixture(feature),ids:string[]=[];for(let i=0;i<12;i++)ids.push(await create(f));
 const cards:{id:string;card:string}[]=[];let rejected=false;
 for(const id of ids){const reply=await f.run(`objection ${id} add ${"漢".repeat(300)} | ${"界".repeat(300)}`);const match=/Card (card-[\da-f-]{36}) saved/.exec(reply);if(match)cards.push({id,card:match[1]});else {assert.match(reply,/quota/);rejected=true;}}
 // Fill remaining admission room using optional text; rejection preserves bytes.
 for(const id of ids){for(const field of ["opening","boundary","concession","stop"]){const before=f.backend.data.get(f.key("state"));const reply=await f.run(`${field} ${id} | ${'"'.repeat(1000)}`);if(!reply.startsWith("Saved")){assert.match(reply,/quota/);assert.equal(f.backend.data.get(f.key("state")),before);rejected=true;}}}
 assert.ok(rejected);assert.ok(cards.length>=8);
 for(const {id,card} of cards){for(let i=0;i<2;i++){assert.match(await f.run(`practice ${id} ${card}`),/^Saved/);assert.match(await f.run(`respond ${id} | ${'"'.repeat(320)}`),/^Saved/);}const r=await record(f,id);assert.equal(r.cards[0].attempts.length,2);for(const a of r.cards[0].attempts)assert.match(await f.run(`rate ${id} ${card} ${a.id} | 5`),/^Saved/);}
 const bytes=Buffer.byteLength(f.backend.data.get(f.key("state"))!);assert.ok(bytes>44000,`filled state ${bytes}`);assert.ok(bytes<=49152);
 for(const id of ids)assert.match(await f.run(`delete ${id} confirm`),/^Deleted/);
});
test("CAS retry refuses a response when the active card changes instead of attaching it to another objection",async()=>{
 let conflict=false,other="";const backend=createMemoryAgentBackend({beforeCompareSet:(key,previous)=>{if(conflict&&previous&&key.endsWith(":state")){conflict=false;const s=JSON.parse(previous);s.records[0].activeCard=other;s.records[0].revision++;backend.data.set(key,JSON.stringify(s));}}});const f=createAgentFeatureFixture(feature,{backend}),id=await create(f),first=await addCard(f,id);other=await addCard(f,id);
 await f.run(`practice ${id} ${first}`);conflict=true;assert.match(await f.run(`respond ${id} | Must belong to first card`),/changed before.*Inspect/);const r=await record(f,id);assert.equal(r.activeCard,other);assert.equal(r.cards[0].attempts.length,0);assert.equal(r.cards[1].attempts.length,0);assert.equal(backend.calls.conflicts,1);
});
test("simulation is one unsaved hypothetical turn with validated references and no automatic practice",async()=>{
 let mode="valid";const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{const source=JSON.parse(input).sources.find((s:{ref:string})=>s.ref==="objection");const sections=[{...source,text:"Which part would be useful to discuss first?"}];if(mode==="unknown")sections[0].ref="someone-else";if(mode==="quote")sections[0].quote="Not entered";if(mode==="extra")sections[0].sender="real person";if(mode==="huge")return "x".repeat(4001);return JSON.stringify({sections});}}});
 const id=await create(f),raw=f.backend.data.get(f.key("state"));const reply=await f.run(`simulate ${id} | We need the whole report`);assert.match(reply,/Hypothetical rehearsal only/);assert.match(reply,/not a prediction or statement by another person/);assert.ok(reply.length<=3500);
 for(mode of ["unknown","quote","extra","huge"])assert.match(await f.run(`simulate ${id} | We need the whole report`),/Optional assistance unavailable/);assert.equal(f.backend.data.get(f.key("state")),raw);assert.equal(f.calls.generate,5);assert.equal(f.calls.readContext,0);assert.equal(f.calls.search,0);
});
test("pending simulation is discarded after edit/deletion; abort and foreign owners preserve privacy",async()=>{
 for(const action of ["edit","delete","abort"]){const gate=deferred<void>(),entered=deferred<void>(),controller=new AbortController();const f=createAgentFeatureFixture(feature,{services:{generate:async({input})=>{entered.resolve();await gate.promise;const s=JSON.parse(input).sources.find((s:{ref:string})=>s.ref==="objection");return JSON.stringify({sections:[{...s,text:"Hypothetical response"}]});}}});
 const id=await create(f),pending=f.run(`simulate ${id} | An objection`,{signal:controller.signal});await entered.promise;
 if(action==="abort"){const rejected=assert.rejects(pending);controller.abort();gate.resolve();await rejected;}else{await f.run(action==="edit"?`boundary ${id} | No extra work`:`delete ${id} confirm`);gate.resolve();assert.match(await pending,/stale result was discarded/);}
 assert.match(await f.run(`show ${id}`,{owner:{teamId:"TOTHER",userId:"UOTHER"}}),/not found/);
 }
});

// These races pause the real backend CAS and complete a newer real command first.
test("mutation intent rejects same-record races, preserves deletions, and retries unrelated records", async () => {
  for (let scenario = 0; scenario < 7; scenario++) {
    let compete: (() => Promise<void>) | undefined;
    const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
      if (key.endsWith(":state") && compete) { const run = compete; compete = undefined; await run(); }
    } });
    const f = createAgentFeatureFixture(feature, { backend }), id = await create(f);
    await f.run(`objection ${id} add Question | Answer`); const c = (await record(f,id)).cards[0].id; await f.run(`practice ${id} ${c}`); await f.run(`respond ${id} | Original attempt`);
    const initial = await record(f, id);
    const commands = (() => { const c = initial.cards[0].id, a = initial.cards[0].attempts[0].id;
    return [
      [`rate ${id} ${c} ${a} | 5`, `attempt ${id} ${c} edit ${a} | NEW unrated attempt`],
      [`unrate ${id} ${c} ${a} confirm`, `rate ${id} ${c} ${a} | 4`],
      [`attempt ${id} ${c} remove ${a} confirm`, `rate ${id} ${c} ${a} | 3`],
      [`cancel ${id} confirm`, `practice ${id} ${c}`],
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
  for (let i=0;i<5;i++) await f.run(`objection ${id} add ${i} ${"x".repeat(700)} | ${"y".repeat(500)}`); for (const field of ["boundary","concession","stop"]) await f.run(`${field} ${id} | ${"z".repeat(1000)}`); const c = (await record(f,id)).cards[0].id; await f.run(`practice ${id} ${c}`); await f.run(`respond ${id} | ${"r".repeat(320)}`);
  const commands = [`show ${id}`, `prepare ${id}`, `review ${id} ${c}`];
  for (const command of commands) {
    let next = command, body = "", count = 0, firstContinuation = "";
    do {
      const reply = await f.run(next); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed());
      const header = /\nPage (\d+)\/(\d+)\n/.exec(reply); assert.ok(header, reply);
      assert.equal(Number(header[1]), ++count);
      const more = Number(header[1]) < Number(header[2]);
      const footer = more ? /\nNext: \/nobo-help agent difficult-conversation ([^\n]+)$/.exec(reply) : null;
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
    const restart = /Restart page 1: \/nobo-help agent difficult-conversation ([^\n]+)/.exec(rejected); assert.ok(restart);
    assert.match(await f.run(restart[1]), /Page 1\//);
  }
  const state = await f.store().read<any>("state"); state.records[0].revision = 999_999_999;
  f.backend.data.set(f.key("state"), JSON.stringify(state));
  const page = await f.run(`show ${id}`), issued = /\nNext: \/nobo-help agent difficult-conversation ([^\n]+)$/.exec(page); assert.ok(issued);
  assert.match(await f.run(`clear ${id} title confirm`), /^Saved/);
  assert.equal((await record(f,id)).revision, 999_999_999);
  assert.match(await f.run(issued[1]), /stale continuation rejected/);
  assert.match(await f.run(`show ${id} 1 rev invalid`), /Invalid revision token/);
});

test("pending assistance binds full target content through ceiling removals, edits, deletes and unrelated changes", async () => {
  for (const action of ["ceiling-removal", "edit", "delete", "unrelated-edit", "unrelated-create"]) {
    const entered = deferred<void>(), release = deferred<void>();
    const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => {
      const { sources } = JSON.parse(input); entered.resolve(); await release.promise;
      return JSON.stringify({ sections: sources.map((s: { ref: string; quote: string }) => ({ ...s, text: s.quote })) });
    } } }), id = await create(f), removed = "SECRET REMOVED: no weekend work";
    await f.run(`boundary ${id} | ${removed}`);
    const other = await create(f);
    if (action === "ceiling-removal") {
      const state = await f.store().read<any>("state"); state.records.find((r: { id: string }) => r.id === id).revision = 999_999_999;
      f.backend.data.set(f.key("state"), JSON.stringify(state));
    }
    const pending = f.run(`simulate ${id} | Please discuss scope`); await entered.promise;
    try {
      if (action === "ceiling-removal") {
        assert.match(await f.run(`clear ${id} boundary confirm`), /^Saved/);
        const current = await record(f,id); assert.equal(current.boundary, ""); assert.equal(current.revision, 999_999_999);
      } else if (action === "edit") assert.match(await f.run(`boundary ${id} | Changed boundary`), /^Saved/);
      else if (action === "delete") assert.match(await f.run(`delete ${id} confirm`), /^Deleted/);
      else if (action === "unrelated-edit") assert.match(await f.run(`edit ${other} | title | Unrelated winning edit`), /^Saved/);
      else await create(f);
    } finally { release.resolve(); }
    const winningRaw = f.backend.data.get(f.key("state")), result = await pending;
    if (action.startsWith("unrelated-")) {
      assert.match(result, /unsaved suggestion/); assert.ok(result.includes(removed));
    } else { assert.match(result, /stale result was discarded/); assert.ok(!result.includes(removed)); }
    assert.equal(f.backend.data.get(f.key("state")), winningRaw);
    assert.deepEqual(f.calls, { generate: 1, search: 0, readContext: 0 });
  }
});
