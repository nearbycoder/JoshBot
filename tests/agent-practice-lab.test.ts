import assert from 'node:assert/strict';
import test from 'node:test';

import feature from '../lib/agent-features/practice-lab.js';
import metadata from '../lib/agent-features/practice-lab.metadata.js';

import {createAgentFeatureFixture, createMemoryAgentBackend, deferred} from './helpers/agent-feature-fixture.js';

function savedId(reply: string): string {
  const id = reply.match(/[\da-f-]{36}/)?.[0];
  if (!id) throw new Error(reply);
  return id;
}
async function rejects(pending: Promise<string>, expected?: RegExp) {
  const reply = await pending;
  assert.match(reply, expected ?? /(?:could not be read|Next: \/nobo-help agent .* (?:help|list))/);
  assert.ok(!reply.startsWith('Saved privately:') && !reply.startsWith('Deleted privately.'));
  assert.ok(reply.length <= 3500);
}

const rid = async (f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) =>
    savedId(await f.run(cmd));
const create = async (f: ReturnType<typeof createAgentFeatureFixture>) =>
    rid(f, 'create Explain a technical tradeoff in two minutes');
const dim =
    async (f: ReturnType<typeof createAgentFeatureFixture>, id: string, label = 'Clarity', max = 5) =>
        rid(f, `rubric ${id} add ${label} | ${max} | State the decision and one reason`);
const attempt = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) =>
    rid(f, `attempt ${id} | I would use a queue because it separates request time from processing.`);
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) =>
    JSON.parse(await f.run(`export ${id}`)).record;
async function prepare(f: ReturnType<typeof createAgentFeatureFixture>) {
  const id = await create(f), x = await dim(f, id), a = await attempt(f, id);
  return {id, x, a};
}
async function pages(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) {
  let all = '', n = 0;
  do {
    const reply = await f.run(cmd);
    assert.ok(reply.length <= 3500 && reply.isWellFormed());
    all += reply;
    cmd =
        /Next: \/nobo-help agent practice-lab ((?:show|progress|next) \S+ page \d+ rev \d+:[a-f0-9]{64})/.exec(reply)
            ?.[1] ??
        '';
    assert.ok(++n < 60);
  } while (cmd);
  return all;
}

test(
    'catalog practice compares completed same-rubric attempts and selects lowest ratio for unequal maxima',
    async () => {
      const f = createAgentFeatureFixture(feature), id = await create(f), clarity = await dim(f, id),
            depth = await dim(f, id, 'Depth', 20), a = await attempt(f, id);
      await f.run(`score ${id} ${a} | ${clarity} | 3 | Reason clear; tradeoff missing`);
      let out = await pages(f, `progress ${id}`);
      assert.match(out, /INCOMPLETE/);
      assert.match(out, /Missing current scores:.*Depth/);
      assert.match(out, /unknown, never zero/);
      await f.run(`score ${id} ${a} | ${depth} | 8 | Only one alternative considered`);
      out = await pages(f, `progress ${id}`);
      assert.match(out, new RegExp(`Lowest relative dimension : ${depth} 8/20`));
      assert.match(await pages(f, `next ${id}`), new RegExp(`Focus ${depth}: Depth`));
      const b = await attempt(f, id);
      await f.run(`score ${id} ${b} | ${clarity} | 4 | Clearer`);
      assert.doesNotMatch(await pages(f, `progress ${id}`), /Same-rubric comparison/);
      await f.run(`score ${id} ${b} | ${depth} | 12 | More alternatives`);
      assert.match(await pages(f, `progress ${id}`), /8\/20 → 12\/20; user-score change 4/);
      await f.run(`rubric ${id} edit ${depth} | Depth | 20 | Explain three alternatives`);
      const c = await attempt(f, id);
      await f.run(`score ${id} ${c} | ${clarity} | 5 | Clear`);
      await f.run(`score ${id} ${c} | ${depth} | 20 | Three alternatives`);
      out = await pages(f, `progress ${id}`);
      assert.equal((out.match(/Same-rubric comparison/g) ?? []).length, 1);
      assert.match(out, /HISTORICAL; cannot assess current/);
      assert.deepEqual(f.calls, {generate: 0, search: 0, readContext: 0});
    });
test(
    'response edits preserve stale scoring evidence and all fields have edit/removal paths',
    async () => {
      const f = createAgentFeatureFixture(feature), {id, x, a} = await prepare(f);
      await f.run(`score ${id} ${a} | ${x} | 3 | Original evidence`);
      await f.run(`attempt ${id} edit ${a} | Changed response`);
      let out = await pages(f, `progress ${id}`);
      assert.match(out, /INCOMPLETE/);
      assert.match(out, /STALE earlier response/);
      assert.match(out, /Original evidence/);
      await f.run(`score ${id} ${a} | ${x} | 4 | New evidence`);
      await f.run(`reopen ${id} ${a} confirm`);
      assert.match(await pages(f, `progress ${id}`), /INCOMPLETE/);
      await f.run(`unscore ${id} ${a} ${x} confirm`);
      await f.run(`attempt ${id} clear ${a} response confirm`);
      await f.run(`attempt ${id} edit ${a} | New response`);
      for (const field of ['label', 'maxScore', 'description'])
        await f.run(`rubric ${id} clear ${x} ${field} confirm`);
      await f.run(`rubric ${id} edit ${x} | New label | 10 | New observable criterion`);
      await f.run(`clear ${id} task confirm`);
      await f.run(`edit ${id} task | New task`);
      await f.run(`rubric ${id} remove ${x} confirm`);
      assert.equal(
          (await record(f, id)).attempts[0].rubric.task, 'Explain a technical tradeoff in two minutes');
      await f.run(`attempt ${id} remove ${a} confirm`);
      assert.equal((await record(f, id)).attempts.length, 0);
      assert.match(await f.run(`delete ${id} confirm`), /^Deleted privately\./);
    });
test('score CAS rejects changed response and safely retries across unrelated drills', async () => {
  let conflict = false, target = '';
  const backend = createMemoryAgentBackend({
    beforeCompareSet: (key, previous) => {
      if (conflict && previous) {
        conflict = false;
        const s = JSON.parse(previous), d = s.records.find((d: {id: string}) => d.id === target);
        d.revision++;
        if (d.attempts.length) {
          d.attempts[0].revision++;
          d.attempts[0].responseRevision++;
          d.attempts[0].response = 'Concurrent response';
        } else {
          d.rubricVersion++;
          d.task = 'Concurrent task';
        }
        backend.data.set(key, JSON.stringify(s));
      }
    }
  });
  const f = createAgentFeatureFixture(feature, {backend}), {id, x, a} = await prepare(f),
        other = await create(f);
  target = id;
  conflict = true;
  await rejects(f.run(`score ${id} ${a} | ${x} | 5 | Obsolete evidence`), /changed/);
  assert.equal((await record(f, id)).attempts[0].scores.length, 0);
  target = other;
  conflict = true;
  await f.run(`score ${id} ${a} | ${x} | 2 | Current evidence`);
  assert.equal((await record(f, other)).task, 'Concurrent task');
  assert.equal(backend.calls.conflicts, 2);
});
test(
    'optional feedback binds exact snapshot dimension/rubric and response quotes, never scores',
    async () => {
      let mode = 'valid';
      const f = createAgentFeatureFixture(feature, {
        services: {
          generate: async ({input, instructions}) => {
            assert.ok(Buffer.byteLength(input) <= 16000 && Buffer.byteLength(instructions) <= 4000);
            const r = JSON.parse(input), d = r.dimensions[0], item = {
              dimensionId: d.id,
              rubricQuote: d.description,
              responseQuote: 'I would use a queue',
              note: 'Describe the tradeoff'
            };
            if (mode === 'id') item.dimensionId = '00000000-0000-4000-8000-000000000000';
            if (mode === 'rubric') item.rubricQuote = 'Made up';
            if (mode === 'response') item.responseQuote = 'Not the response';
            if (mode === 'huge') return 'x'.repeat(4001);
            if (mode === 'refusal') return 'Cannot provide feedback';
            if (mode === 'extra') return JSON.stringify({feedback: [{...item, score: 5}]});
            return JSON.stringify({feedback: [item]});
          }
        }
      });
      const {id, a} = await prepare(f), before = f.backend.data.get(f.key('state'));
      assert.match(await f.run(`feedback ${id} ${a}`), /UNSAVED MODEL OPINIONS/);
      for (mode of ['id', 'rubric', 'response', 'huge', 'refusal', 'extra'])
        assert.match(await f.run(`feedback ${id} ${a}`), /invalid or oversized complete/);
      assert.equal(f.backend.data.get(f.key('state')), before);
      assert.deepEqual(f.calls, {generate: 7, search: 0, readContext: 0});
    });
test('complete bounded model output rejects oversized rendering without fake continuation', async () => {
  const f = createAgentFeatureFixture(feature, {
    services: {
      generate: async ({input}) => {
        const r = JSON.parse(input);
        return JSON.stringify({
          feedback: r.dimensions.map((d: {id: string; description: string}) => ({
                                       dimensionId: d.id,
                                       rubricQuote: d.description,
                                       responseQuote: r.response,
                                       note: 'n'.repeat(350)
                                     }))
        });
      }
    }
  }),
        id = await create(f);
  for (let i = 0; i < 6; i++) await dim(f, id, `D${i}`);
  const a = await attempt(f, id);
  assert.match(await f.run(`feedback ${id} ${a}`), /oversized complete/);
  assert.equal(f.calls.generate, 1);
});
test(
    'feedback is discarded after edit/delete/abort and unavailable providers do not retry', async () => {
      for (const action of ['edit', 'delete', 'abort']) {
        const entered = deferred<void>(), gate = deferred<void>(), controller = new AbortController(),
              f = createAgentFeatureFixture(feature, {
                services: {
                  generate: async ({input}) => {
                    entered.resolve();
                    await gate.promise;
                    const r = JSON.parse(input), d = r.dimensions[0];
                    return JSON.stringify({
                      feedback: [{
                        dimensionId: d.id,
                        rubricQuote: d.description,
                        responseQuote: 'I would',
                        note: 'Opinion'
                      }]
                    });
                  }
                }
              }),
              {id, a} = await prepare(f),
              pending = f.run(`feedback ${id} ${a}`, {signal: controller.signal});
        await entered.promise;
        if (action === 'abort') {
          const rejected = assert.rejects(pending);
          controller.abort();
          gate.resolve();
          await rejected;
        } else {
          await f.run(
              action === 'edit' ? `attempt ${id} edit ${a} | New response` : `delete ${id} confirm`);
          gate.resolve();
          assert.match(await pending, /stale result discarded/);
        }
        assert.equal(f.calls.generate, 1);
      }
      const f = createAgentFeatureFixture(feature), {id, a} = await prepare(f);
      assert.match(await f.run(`feedback ${id} ${a}`), /unavailable/);
      assert.equal(f.calls.generate, 1);
    });
test(
    'count limits and dynamic reservations allow every remaining score and maximum response at saturation',
    async () => {
      const f = createAgentFeatureFixture(feature), ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await create(f));
      await assert.rejects(create(f), /Ten/);
      let rejected = false;
      for (const id of ids) {
        try {
          await dim(f, id);
        } catch (e) {
          assert.match(String(e), /quota/);
          rejected = true;
          break;
        }
      }
      for (const id of ids) {
        const d = await record(f, id);
        if (d.dimensions.length) await attempt(f, id);
      }
      for (const id of ids) {
        let d = await record(f, id);
        if (!d.dimensions.length) continue;
        for (let i = d.attempts.length; i < 6; i++) {
          try {
            await attempt(f, id);
          } catch (e) {
            assert.match(String(e), /quota/);
            rejected = true;
            break;
          }
        }
      }
      assert.ok(rejected);
      for (const id of ids) {
        const d = await record(f, id);
        for (const a of d.attempts) {
          assert.match(
              await f.run(`attempt ${id} edit ${a.id} | ${'"'.repeat(1200)}`), /^Saved privately:/);
          for (const x of a.rubric.dimensions)
            assert.match(
                await f.run(`score ${id} ${a.id} | ${x.id} | ${x.maxScore} | ${'"'.repeat(160)}`),
                /^Saved privately:/);
        }
        const out = await f.run(`export ${id}`);
        assert.ok(Buffer.byteLength(out) <= 24576);
        const all = await pages(f, `show ${id}`);
        for (const a of (await record(f, id)).attempts) assert.ok(all.includes(a.id));
      }
      assert.ok(
          Buffer.byteLength(f.backend.data.get(f.key('state'))!) > 32768,
          'legitimate lifecycle growth exceeds content admission');
      assert.ok(Buffer.byteLength(f.backend.data.get(f.key('state'))!) <= 49152);
      const retained = await record(f, ids[0]);
      assert.match(
          await f.run(`unscore ${ids[0]} ${retained.attempts[0].id} ${
              retained.attempts[0].rubric.dimensions[0].id} confirm`),
          /^Saved privately:/);
      assert.match(
          await f.run(`attempt ${ids[0]} remove ${retained.attempts[0].id} confirm`),
          /^Saved privately:/);
      for (const verb of ['show', 'progress', 'next'])
        await rejects(f.run(`${verb} ${ids[0]} page 1 rev ${retained.revision}`), /changed/);
      for (const id of ids) assert.match(await f.run(`delete ${id} confirm`), /^Deleted privately\./);
      const g = createAgentFeatureFixture(feature), id = await create(g);
      for (let i = 0; i < 6; i++) await dim(g, id, `Dimension ${i}`);
      await assert.rejects(dim(g, id), /six/);
      for (let i = 0; i < 6; i++) {
        try {
          await attempt(g, id);
        } catch (e) {
          assert.match(String(e), /quota/);
          break;
        }
      }
    });
test('six small attempts, invalid score maxima, snapshot corruption and tenant isolation', async () => {
  const f = createAgentFeatureFixture(feature), {id, x} = await prepare(f);
  for (let i = 1; i < 6; i++) await attempt(f, id);
  await assert.rejects(attempt(f, id), /six/);
  const d = await record(f, id), a = d.attempts[0].id, good = f.backend.data.get(f.key('state'))!;
  for (const cmd
           of [`score ${id} ${a} | ${x} | 6 | Too high`, `score ${id} ${a} | ${x} | -1 | Negative`,
               `attempt ${id} edit ${a} | ${'漢'.repeat(401)}`])
    await rejects(f.run(cmd));
  assert.equal(f.backend.data.get(f.key('state')), good);
  const corrupt = JSON.parse(good);
  corrupt.records[0].attempts[0].rubric.task = 'Changed snapshot';
  for (const bad of ['null', '{', good.replace('"version":1', '"version":2'), JSON.stringify(corrupt)]) {
    f.backend.data.set(f.key('state'), bad);
    await rejects(f.run(`delete ${id} confirm`));
    assert.equal(f.backend.data.get(f.key('state')), bad);
  }
  f.backend.data.set(f.key('state'), good);
  for (const owner
           of [{teamId: 'TOTHER', userId: f.owner.userId}, {teamId: f.owner.teamId, userId: 'UOTHER'}])
    await rejects(f.run(`show ${id}`, {owner}), /not found/);
});

async function erasureFixture(f: ReturnType<typeof createAgentFeatureFixture>) {
  assert.match(await f.run("create Explain a tradeoff"), /Saved/);
  const read = async () => (await f.store().read<any>("state"))!;
  const id = (await read()).records[0].id;
  for (let i = 0; i < 1; i++) assert.match(await f.run(`rubric ${id} add Clarity | 5 | State one reason`), /Saved/);
  for (let i = 0; i < 4; i++) assert.match(await f.run(`attempt ${id} | ${"R".repeat(1000)}`), /Saved/);
  return { id, read };
}

for (const ceiling of [false, true]) test(`selective erasure retains other children and invalidates complete pages (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const f = createAgentFeatureFixture(feature), {id, read} = await erasureFixture(f);
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  const before = (await read()).records[0], child = before.attempts[0].id;
  assert.deepEqual(JSON.parse(await f.run(`export ${id}`)).record, before);
  const first = await f.run(`show ${id}`), continuation = first.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1];
  assert.ok(continuation, "fixture exercises real continuation");
  assert.match(continuation, / rev \d+:[a-f0-9]{64}$/);
  assert.match(await f.run(continuation), /Page 2\//);
  assert.match(await f.run(`attempt ${id} remove ${child} confirm`), /Saved|Removed/);
  const after = (await read()).records[0];
  assert.equal(after.revision, ceiling ? Number.MAX_SAFE_INTEGER : before.revision + 1);
  assert.deepEqual(after.attempts, before.attempts.slice(1));
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
    const raw = f.backend.data.get(f.key("state")); assert.match(await f.run(`edit ${id} task | Changed`), /Revision limit/);
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
  await f.run("create Explain a tradeoff");
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; backend.data.set(f.key("state"), JSON.stringify(s)); }
  const original = backend.data.get(f.key("state"))!, r = (await read()).records[0], child = r.attempts[0].id;
  const remove = (child: string) => `attempt ${id} remove ${child} confirm`;
  // A real same-record removal wins while the original operation is awaiting CAS.
  for (const pending of [remove(child), `delete ${id} confirm`]) {
    backend.data.set(f.key("state"), original);
    action = async () => { assert.match(await f.run(remove(r.attempts[1].id)), /Saved|Removed/); };
    assert.match(await f.run(pending), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  }
  // A competing writer reintroduces the child ID with changed content. The exact
  // numeric revision can be unchanged; intent must still bind the full snapshot.
  backend.data.set(f.key("state"), original);
  action = async () => {
    assert.match(await f.run(remove(child)), /Saved|Removed/);
    const s = await read(), replacement = structuredClone(r.attempts[0]);
    replacement.response = "Reintroduced evidence";
    s.records[0].attempts.push(replacement); backend.data.set(f.key("state"), JSON.stringify(s));
    assert.equal(JSON.parse(await f.run(`export ${id}`)).record.attempts.at(-1).id, child);
  };
  assert.match(await f.run(remove(child)), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { await f.run(`delete ${id} confirm`); };
  assert.match(await f.run(remove(child)), /not found/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { const other = (await read()).records[1].id; await f.run(`delete ${other} confirm`); };
  assert.match(await f.run(remove(child)), /Saved|Removed/);
  const after = await read(); assert.equal(after.records.length, 1);
  assert.deepEqual(after.records[0].attempts, r.attempts.slice(1));
  assert.ok(backend.calls.conflicts >= 5);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

for (const ceiling of [false, true]) test(`pending generated opinion cannot repeat erased evidence (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const entered = deferred<void>(), gate = deferred<string>(), marker = "LATE_ERASED_OPINION_MARKER";
  const f = createAgentFeatureFixture(feature, {services:{generate:async () => { entered.resolve(); return gate.promise; }}});
  const {id} = await prepare(f);
  const read = async () => (await f.store().read<any>("state"))!;
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  const r = (await read()).records[0], pending = f.run(`feedback ${id} ${r.attempts[0].id}`); await entered.promise;
  assert.match(await f.run(`attempt ${id} remove ${r.attempts[0].id} confirm`), /Saved|Removed/);
  const raw = f.backend.data.get(f.key("state")), writes = f.backend.calls.writes;
  gate.resolve(JSON.stringify({feedback:[{dimensionId:r.dimensions[0].id,rubricQuote:r.dimensions[0].description,responseQuote:r.attempts[0].response,note:marker}]}));
  const reply = await pending; assert.match(reply, /changed|deleted|stale/i); assert.doesNotMatch(reply, new RegExp(marker));
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.backend.calls.writes, writes);
  assert.deepEqual(f.calls, {generate:1,search:0,readContext:0});
});

test("all field and relationship erasures remain valid at the root revision ceiling", async () => {
  const f = createAgentFeatureFixture(feature);
  const {id, x, a} = await prepare(f);
  await f.run(`score ${id} ${a} | ${x} | 3 | Exact evidence`);
  const s = (await f.store().read<any>("state"))!; s.records[0].revision = Number.MAX_SAFE_INTEGER;
  const original = JSON.stringify(s);
  for (const cmd of [`clear ${id} task confirm`,
    `rubric ${id} clear ${x} label confirm`,
    `rubric ${id} clear ${x} maxScore confirm`,
    `rubric ${id} clear ${x} description confirm`,
    `rubric ${id} remove ${x} confirm`,
    `attempt ${id} clear ${a} response confirm`,
    `reopen ${id} ${a} confirm`,
    `unscore ${id} ${a} ${x} confirm`]) {
    f.backend.data.set(f.key("state"), original);
    assert.match(await f.run(cmd), /Saved|Removed|Cleared/);
    assert.notEqual(f.backend.data.get(f.key("state")), original, cmd);
    const exported = JSON.parse(await f.run(`export ${id}`));
    assert.equal(exported.record.revision, Number.MAX_SAFE_INTEGER);
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 24576);
  }
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

test("semantic version exhaustion is an honest refusal with export/delete recovery, not corruption", async () => {
  const f = createAgentFeatureFixture(feature);
  const beforeHelp = {...f.backend.calls}, help = await f.run("help");
  assert.equal(feature.help, metadata.help); assert.equal(help, metadata.help);
  assert.match(help, /intentional finite limit/); assert.match(help, /changes\/removals needing a new version are refused/);
  assert.match(help, /export ID/); assert.match(help, /delete ID confirm/); assert.ok(help.length <= 3500);
  assert.deepEqual(f.backend.calls, beforeHelp, "finite-limit help stays stateless");
  const {id,x,a} = await prepare(f);
  await f.run(`score ${id} ${a} | ${x} | 3 | Preserved evidence`); await create(f);
  const read = async () => (await f.store().read<any>("state"))!;
  const s = await read(), r = s.records[0]; r.revision = Number.MAX_SAFE_INTEGER;
  r.rubricVersion = Number.MAX_SAFE_INTEGER;
  const raw = " \n" + JSON.stringify(s, null, 2) + "\t\n"; f.backend.data.set(f.key("state"), raw);
  const exported = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(exported) <= 24576);
  assert.deepEqual(JSON.parse(exported).record, r);
  const writes = f.backend.calls.writes, reply = await f.run(`rubric ${id} remove ${x} confirm`);
  assert.match(reply, /needs a new rubric version/); assert.match(reply, /finite history limit is exhausted/);
  assert.match(reply, /not applied/); assert.doesNotMatch(reply, /Invalid saved|corrupt|repair|retry|unavailable/i);
  assert.ok(reply.includes(`export ${id}`)); assert.ok(reply.includes(`delete ${id} confirm`));
  assert.ok(reply.length <= 3500);
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.backend.calls.writes, writes);
  assert.equal(await f.run(`export ${id}`), exported, "history and all associations are unchanged");
  assert.match(await f.run(`delete ${id} confirm`), /Deleted/);
    assert.deepEqual((await read()).records, s.records.slice(1));
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});
