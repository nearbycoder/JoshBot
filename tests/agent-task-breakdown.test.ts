import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/task-breakdown.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
const idFrom = (reply: string, prefix: string) => { const id = reply.match(new RegExp(`${prefix}-[0-9a-f-]{36}`))?.[0]; assert.ok(id, reply); return id; };
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;

for (const scenario of [
  { name: "completion versus edited work", completed: false,
    pending: "complete WORK STEP | Old installer passed",
    winning: ["step WORK edit STEP | Test new installer | 20 | New installer passes"],
    retry: "complete WORK STEP | New installer passed" },
  { name: "completion versus edit-and-restore", completed: false,
    pending: "complete WORK STEP | Old installer passed",
    winning: ["step WORK edit STEP | Test new installer | 20 | New installer passes", "step WORK edit STEP | Test old installer | 10 | Old installer passes"],
    retry: "complete WORK STEP | Retested installer" },
  { name: "completion correction versus reopen and edit", completed: true,
    pending: "completion-edit WORK STEP | Stale correction",
    winning: ["reopen WORK STEP confirm", "step WORK edit STEP | Test new installer | 20 | New installer passes"],
    retry: "complete WORK STEP | New installer passed" },
  { name: "completion correction versus newer evidence", completed: true,
    pending: "completion-edit WORK STEP | Stale correction",
    winning: ["completion-edit WORK STEP | Winning correction"],
    retry: "completion-edit WORK STEP | Reviewed correction" },
  { name: "reopen versus newer evidence", completed: true,
    pending: "reopen WORK STEP confirm",
    winning: ["completion-edit WORK STEP | Winning correction"],
    retry: "reopen WORK STEP confirm" },
  { name: "reopen versus a new completed attempt", completed: true,
    pending: "reopen WORK STEP confirm",
    winning: ["reopen WORK STEP confirm", "complete WORK STEP | Newly retested installer"],
    retry: "reopen WORK STEP confirm" },
  { name: "edit versus a newer work definition", completed: false,
    pending: "step WORK edit STEP | Test stale installer | 10 | Stale proof",
    winning: ["step WORK edit STEP | Test new installer | 20 | New installer passes"],
    retry: "step WORK edit STEP | Test reviewed installer | 20 | Reviewed proof" },
]) test(`CAS retry preserves winning ${scenario.name}; inspect and fresh retry recover`, { timeout: 5_000 }, async () => {
  const entered = deferred<void>(), release = deferred<void>(); let armed = false;
  const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
    if (armed && key.endsWith(":state")) { armed = false; entered.resolve(); await release.promise; }
  } });
  const f = createAgentFeatureFixture(feature, { backend });
  const work = idFrom(await f.run("create Write guide | Clean install | 30"), "work");
  const step = idFrom(await f.run(`step ${work} add Test old installer | 10 | Old installer passes`), "step");
  const command = (s: string) => s.replaceAll("WORK", work).replaceAll("STEP", step);
  if (scenario.completed) await f.run(command("complete WORK STEP | Old installer passed"));
  armed = true;
  const pending = f.run(command(scenario.pending)); await entered.promise;
  try { for (const winning of scenario.winning) assert.match(await f.run(command(winning)), /Saved privately/); }
  finally { release.resolve(); }
  const before = backend.data.get(f.key("state")), reply = await pending;
  assert.equal(backend.calls.conflicts, 1);
  assert.equal(backend.data.get(f.key("state")), before, "stale work must not alter the winning state or revision");
  assert.match(reply, /changed.*saving/); assert.ok(reply.includes(`show ${work}`)); assert.match(reply, /retry/);
  assert.match(await f.run(`show ${work}`), /revision/);
  assert.match(await f.run(command(scenario.retry)), /Saved privately/);
  assert.notEqual(backend.data.get(f.key("state")), before);
});

test("completion retries an unrelated-record CAS conflict without losing either write", { timeout: 5_000 }, async () => {
  const entered = deferred<void>(), release = deferred<void>(); let armed = false;
  const backend = createMemoryAgentBackend({ beforeCompareSet: async key => {
    if (armed && key.endsWith(":state")) { armed = false; entered.resolve(); await release.promise; }
  } });
  const f = createAgentFeatureFixture(feature, { backend });
  const work = idFrom(await f.run("create Write guide | Clean install | 30"), "work");
  const other = idFrom(await f.run("create Other | Other proof | 30"), "work");
  const step = idFrom(await f.run(`step ${work} add Test installer | 10 | Installer passes`), "step");
  armed = true; const pending = f.run(`complete ${work} ${step} | Installer passed`); await entered.promise;
  try { await f.run(`edit ${other} | Changed other | New proof | 20`); } finally { release.resolve(); }
  assert.match(await pending, /user-reported completion/); assert.equal(backend.calls.conflicts, 1);
  assert.equal((await record(f, work)).steps[0].completion, "Installer passed");
  assert.equal((await record(f, other)).title, "Changed other");
});

test("first example and full lifecycle expose effort, proof, next executable action and reported completion", async () => {
  const f = createAgentFeatureFixture(feature), work = idFrom(await f.run(feature.example!.split("task-breakdown ")[1]), "work");
  const draft = idFrom(await f.run(`step ${work} add Draft installation steps | 20 | A new user can follow all five steps`), "step");
  const verify = idFrom(await f.run(`step ${work} add Test the guide | 25 | Record a successful clean install`), "step");
  assert.match(await f.run(`check ${work}`), /remaining 45 minutes/);
  assert.match(await f.run(`next ${work}`), new RegExp(draft));
  assert.match(await f.run(`next ${work}`), /Proof to collect: A new user/);
  assert.equal((await record(f, work)).steps[0].status, "pending");
  await f.run(`complete ${work} ${draft} | Tested in a clean local folder`);
  assert.match(await f.run(`next ${work}`), new RegExp(verify));
  assert.equal((await record(f, work)).steps[0].completedAt, "2026-10-22T15:00:00.000Z");
  await f.run(`completion-edit ${work} ${draft} | Correction: tested with a new user`);
  assert.match(await f.run(`step ${work} edit ${draft} | Write draft | 10 | Saved`), /Reopen before editing/);
  await f.run(`reopen ${work} ${draft} confirm`);
  await f.run(`step ${work} edit ${draft} | Write draft | 10 | Saved guide`);
  await f.run(`move ${work} ${verify} | 1`); assert.match(await f.run(`next ${work}`), new RegExp(verify));
  await f.run(`edit ${work} | Publish guide v2 | Users can update the app | 15`);
  assert.match(await f.run(`check ${work}`), /25 minutes exceeds 15-minute session/);
  assert.match(await f.run(`next ${work}`), new RegExp(draft));
  await f.run(`step ${work} remove ${verify} confirm`);
  assert.equal((await record(f, work)).steps[0].completion, null);
  await f.run(`delete ${work} confirm`); assert.match(await f.run(`show ${work}`), /not found/);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});

test("oversized and vague steps are flagged without silently splitting or inferring completion", async () => {
  const f = createAgentFeatureFixture(feature), work = idFrom(await f.run("create Write guide | Reader succeeds | 30"), "work");
  const oversize = idFrom(await f.run(`step ${work} add Draft everything | 45 | All content written`), "step");
  const vague = idFrom(await f.run(`step ${work} add Installation | 5 | `), "step");
  assert.match(await f.run(`check ${work}`), /45 minutes exceeds 30-minute session/);
  assert.match(await f.run(`check ${work}`), /no recognized leading action verb/); assert.match(await f.run(`check ${work}`), /missing proof/);
  assert.match(await f.run(`next ${work}`), /No executable unfinished step/);
  assert.deepEqual((await record(f, work)).steps.map((s: { id: string }) => s.id), [oversize, vague]);
  const before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`complete ${work} ${oversize} | `), /required/);
  assert.match(await f.run(`step ${work} add Test | -1 | Proof`), /integer/);
  assert.equal(f.backend.data.get(f.key("state")), before);
});

test("optional suggestions make one bounded call, remain unsaved, and fail safely", async () => {
  let input = "", instructions = "";
  const f = createAgentFeatureFixture(feature, { services: { generate: async args => { input = args.input; instructions = args.instructions; return JSON.stringify({ steps: [{ action: "Draft outline", minutes: 10, proof: "Three sections" }] }); } } });
  const work = idFrom(await f.run("create Write guide | Reader succeeds | 30"), "work"), before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`suggest ${work}`), /unsaved model suggestions/);
  assert.equal(f.calls.generate, 1); assert.equal(f.backend.data.get(f.key("state")), before);
  assert.ok(Buffer.byteLength(input) <= 16000); assert.ok(Buffer.byteLength(instructions) <= 4000);
  const unavailable = createAgentFeatureFixture(feature), other = idFrom(await unavailable.run("create X | Y | 30"), "work");
  assert.match(await unavailable.run(`suggest ${other}`), /assistance unavailable/); assert.equal(unavailable.calls.generate, 1);
  const malformed = createAgentFeatureFixture(feature, { services: { generate: async () => '{"steps":[{"action":"Draft x","minutes":40,"proof":"p"}]}' } });
  const id = idFrom(await malformed.run("create X | Y | 30"), "work");
  assert.match(await malformed.run(`suggest ${id}`), /invalid or oversized/); assert.equal(malformed.calls.generate, 1);
});

test("a changed success definition or deletion invalidates an in-flight unsaved draft", async () => {
  for (const remove of [false, true]) {
    const started = deferred<void>(), generation = deferred<string>();
    const f = createAgentFeatureFixture(feature, { services: { generate: () => { started.resolve(); return generation.promise; } } });
    const work = idFrom(await f.run("create X | Original success | 30"), "work");
    const pending = f.run(`suggest ${work}`); await started.promise;
    await f.run(remove ? `delete ${work} confirm` : `edit ${work} | X | New success | 30`);
    const before = f.backend.data.get(f.key("state"));
    generation.resolve('{"steps":[{"action":"Draft x","minutes":10,"proof":"p"}]}');
    assert.match(await pending, /stale draft was discarded/); assert.equal(f.backend.data.get(f.key("state")), before);
  }
});

test("maximum root/step retrieval and Unicode quota reserve all mandatory completion reports", async () => {
  const f = createAgentFeatureFixture(feature), works: string[] = [];
  for (let i = 0; i < 12; i++) works.push(idFrom(await f.run(`create Work ${i} | ${"漢😀é".repeat(70)} | 30`), "work"));
  assert.ok((await f.run("list 2")).includes(works[11]));
  const accepted: [string, string][] = []; let refused = false;
  for (const work of works) {
    for (let i = 0; i < 20 && !refused; i++) {
      const before = f.backend.data.get(f.key("state")), reply = await f.run(`step ${work} add Draft ${"😀".repeat(50)} | 10 | ${"漢\"".repeat(40)}`);
      if (reply.includes("quota")) { refused = true; assert.equal(f.backend.data.get(f.key("state")), before); }
      else accepted.push([work, idFrom(reply, "step")]);
    }
  }
  assert.ok(refused); assert.ok(accepted.length >= 20);
  for (const [work, step] of accepted) assert.match(await f.run(`complete ${work} ${step} | ${'"'.repeat(256)}`), /user-reported/);
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 49152);
  const first = await f.run(`show ${works[0]}`), pages = Number(first.match(/Page 1\/(\d+)/)![1]); let all = "";
  for (let p = 1; p <= pages; p++) { const reply = await f.run(`show ${works[0]} ${p}`); assert.ok(reply.length <= 3500); assert.ok(reply.isWellFormed()); all += reply; }
  assert.ok(all.includes(accepted[19][1]));
  assert.equal((await record(f, works[0])).steps[19].completion, '"'.repeat(256));
  assert.ok(Buffer.byteLength(await f.run(`export ${works[0]}`)) <= 24576);
  const corrupt = JSON.parse(f.backend.data.get(f.key("state"))!); corrupt.records[0].steps[0].completedAt = null;
  f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const before = f.backend.data.get(f.key("state"));
  assert.match(await f.run(`delete ${works[0]} confirm`), /could not be read safely/); assert.equal(f.backend.data.get(f.key("state")), before);
});


test("optional drafts reject oversized, unknown-field and over-count results with no repair call", async () => {
  let response = "";
  const f = createAgentFeatureFixture(feature, { services: { generate: async () => response } });
  const work = idFrom(await f.run("create Guide | Reader succeeds | 30"), "work"), before = f.backend.data.get(f.key("state"));
  const step = { action: "Draft section", minutes: 10, proof: "Saved section" };
  const invalid = [
    JSON.stringify({ steps: Array.from({ length: 9 }, () => step) }),
    JSON.stringify({ steps: [{ ...step, sourceId: "invented" }] }),
    JSON.stringify({ steps: [{ ...step, action: "D".repeat(401) }] }),
    "not JSON",
    "😀".repeat(2001),
  ];
  for (const value of invalid) { response = value; assert.match(await f.run(`suggest ${work}`), /invalid or oversized/); assert.equal(f.backend.data.get(f.key("state")), before); }
  assert.equal(f.calls.generate, invalid.length); assert.equal(f.calls.search, 0); assert.equal(f.calls.readContext, 0);
});
