import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import feature from '../lib/agent-features/learning-transfer.js';

import {createAgentFeatureFixture, createMemoryAgentBackend} from './helpers/agent-feature-fixture.js';

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

const create = async (f: ReturnType<typeof createAgentFeatureFixture>) => savedId(
    await f.run('create Use smaller PRs | Workshop notes | Keep each change focused on one purpose'));
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) =>
    JSON.parse(await f.run(`export ${id}`)).record;
const prepare = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => {
  await f.run(`apply ${id} | Next bug fix | Split refactor from behavior`);
  await f.run(`predict ${id} | Reviewer can assess each PR in one sitting`);
};

test(
    'catalog learning loop stays planned until reported, retains evidence, and marks changed plans stale',
    async () => {
      const f = createAgentFeatureFixture(feature), id = await create(f);
      assert.match(await f.run(`review ${id}`), /planned/);
      await rejects(f.run(`observe ${id} | It worked`), /Complete/);
      await prepare(f, id);
      await f.run(`observe ${id} | Reviewer completed both reviews without clarification`);
      assert.match(await f.run(`review ${id}`), /tried/);
      await f.run(`reflect ${id} | Keep split; add dependency note`);
      assert.match(await f.run(`review ${id}`), /reviewed/);
      await f.run(`edit ${id} action | Bundle all changes`);
      const review = await f.run(`review ${id}`);
      assert.match(review, /planned/);
      assert.match(review, /STALE/);
      assert.match(review, /without clarification/);
      await rejects(f.run(`reflect ${id} | Pretend unchanged`), /Observe the current/);
      assert.deepEqual(f.calls, {generate: 0, search: 0, readContext: 0});
    });
test('all accepted fields, observation dates and reflection have edit and removal paths', async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  await prepare(f, id);
  await f.run(`observe ${id} | Report`);
  const oid = (await record(f, id)).observations[0].id;
  await f.run(`reflect ${id} | Adjustment`);
  await f.run(`observation ${id} edit ${oid} | 2024-02-29 | Corrected report`);
  assert.match(await f.run(`review ${id}`), /STALE/);
  for (const field
           of ['lesson', 'sourceLabel', 'sourceExcerpt', 'opportunity', 'action', 'prediction']) {
    await f.run(`edit ${id} ${field} | literal \\| <@UOTHER> & C:\\\\notes`);
    assert.equal((await record(f, id))[field], 'literal | <@UOTHER> & C:\\notes');
    await f.run(`clear ${id} ${field} confirm`);
    assert.equal((await record(f, id))[field], '');
  }
  await f.run(`clear ${id} reflection confirm`);
  await f.run(`observation ${id} remove ${oid} confirm`);
  assert.equal((await record(f, id)).observations.length, 0);
  await f.run(`delete ${id}`);
  assert.ok(await record(f, id));
  assert.match(await f.run(`delete ${id} confirm`), /^Deleted privately\./);
  assert.match(await f.run('list'), /No saved/);
});
test('assessment CAS retries reject changed work, while unrelated applications can change', async () => {
  let target = '', conflict = false;
  const backend = createMemoryAgentBackend({
    beforeCompareSet: (key, previous) => {
      if (conflict && previous) {
        conflict = false;
        const s = JSON.parse(previous);
        const a = s.records.find((a: {id: string}) => a.id === target);
        a.action = 'Concurrent action';
        a.revision++;
        a.planRevision++;
        backend.data.set(key, JSON.stringify(s));
      }
    }
  });
  const f = createAgentFeatureFixture(feature, {backend}), first = await create(f),
        second = await create(f);
  await prepare(f, first);
  await prepare(f, second);
  target = first;
  conflict = true;
  await rejects(f.run(`observe ${first} | Obsolete evidence`), /changed/);
  assert.equal((await record(f, first)).observations.length, 0);
  await f.run(`observe ${first} | Current report`);
  target = first;
  conflict = true;
  await rejects(f.run(`reflect ${first} | Obsolete reflection`), /changed/);
  target = second;
  conflict = true;
  await f.run(`observe ${first} | Independent report`);
  assert.equal((await record(f, first)).observations.length, 2);
  assert.equal((await record(f, second)).action, 'Concurrent action');
  assert.equal(backend.calls.conflicts, 3);
});
test('invalid state is never reset; raw corrupt bytes survive even attempted deletion', async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f),
        good = f.backend.data.get(f.key('state'))!;
  for (
      const bad of
          ['{', 'null', '{"version":2,"records":[]}',
           good.replace('"planRevision":1', '"planRevision":0'),
           good.replace('"records":', '"extra":true,"records":'),
           good.replace(
               '"reflection":null',
               '"reflection":{"text":"Unsupported reflection","planRevision":1,"observationRevision":1}')]) {
    f.backend.data.set(f.key('state'), bad);
    await rejects(f.run(`delete ${id} confirm`));
    assert.equal(f.backend.data.get(f.key('state')), bad);
    assert.ok((await f.run('help')).length <= 3500);
  }
  // Baseline reads conflate null with absence; parent 6725cde returns a scoped diagnosis.
  // Both paths must preserve the corrupt bytes and prevent a successful mutation.
  f.backend.data.set(f.key('state'), 'null');
  await rejects(f.run('create A | B | C'));
  assert.equal(f.backend.data.get(f.key('state')), 'null');
});
test('field boundaries, civil dates, owner isolation and exact export', async () => {
  const f = createAgentFeatureFixture(feature), id = await create(f);
  await f.run(`edit ${id} sourceExcerpt | ${'漢'.repeat(600)}`);
  const before = f.backend.data.get(f.key('state'));
  await rejects(f.run(`edit ${id} sourceExcerpt | ${'漢'.repeat(601)}`));
  assert.equal(f.backend.data.get(f.key('state')), before);
  await prepare(f, id);
  await f.run(`observe ${id} | Evidence`);
  const oid = (await record(f, id)).observations[0].id;
  await rejects(f.run(`observation ${id} edit ${oid} | 2026-02-29 | Invalid`));
  for (const owner
           of [{teamId: 'TOTHER', userId: f.owner.userId}, {teamId: f.owner.teamId, userId: 'UOTHER'}])
    await rejects(f.run(`show ${id}`, {owner}), /not found/);
  assert.equal((await record(f, id)).sourceExcerpt, '漢'.repeat(600));
});
test(
    'Unicode saturation reserves every remaining observation and reflection; pages recover all fields',
    async () => {
      const f = createAgentFeatureFixture(feature), ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        try {
          ids.push(await create(f));
        } catch (e) {
          assert.match(String(e), /quota/);
          break;
        }
      }
      assert.ok(ids.length > 1 && ids.length < 20);
      for (const id of ids) {
        assert.match(
            await f.run(`apply ${id} | ${'"'.repeat(180)} | ${'"'.repeat(300)}`), /^Saved privately:/);
        assert.match(await f.run(`predict ${id} | ${'"'.repeat(240)}`), /^Saved privately:/);
        for (let i = 0; i < 5; i++)
          assert.match(await f.run(`observe ${id} | ${'"'.repeat(240)}`), /^Saved privately:/);
        assert.match(await f.run(`reflect ${id} | ${'"'.repeat(240)}`), /^Saved privately:/);
        await rejects(f.run(`observe ${id} | sixth`), /Five/);
        const out = await f.run(`export ${id}`);
        assert.ok(Buffer.byteLength(out) <= 24576);
        let cmd = `show ${id}`, all = '', pages = 0;
        do {
          const reply = await f.run(cmd);
          assert.ok(reply.length <= 3500);
          assert.ok(reply.isWellFormed());
          all += reply;
          cmd = /Next: \/nobo-help agent learning-transfer (.*)/.exec(reply)?.[1] ?? '';
          assert.ok(++pages < 20);
        } while (cmd);
        for (const o of (await record(f, id)).observations) assert.ok(all.includes(o.id));
      }
      assert.ok(
          Buffer.byteLength(f.backend.data.get(f.key('state'))!) > 32768,
          'legitimate lifecycle growth exceeds content admission');
      assert.ok(Buffer.byteLength(f.backend.data.get(f.key('state'))!) <= 49152);
      const retained = await record(f, ids[0]);
      assert.match(await f.run(`clear ${ids[0]} reflection confirm`), /^Saved privately:/);
      assert.match(
          await f.run(`observation ${ids[0]} remove ${retained.observations[0].id} confirm`),
          /^Saved privately:/);
      for (const verb of ['show', 'review'])
        await rejects(f.run(`${verb} ${ids[0]} page 1 rev ${retained.revision}`), /changed/);
      for (const id of ids) assert.match(await f.run(`delete ${id} confirm`), /^Deleted privately\./);
    });

test(
    'stale edit and delete CAS cannot overwrite or erase the winning application revision', async () => {
      let conflict = false, remove = false;
      const backend = createMemoryAgentBackend({
        beforeCompareSet: (key, previous) => {
          if (conflict && previous) {
            conflict = false;
            const s = JSON.parse(previous);
            if (remove)
              s.records = [];
            else {
              s.records[0].revision++;
              s.records[0].planRevision++;
              s.records[0].action = 'Winning edit';
            }
            backend.data.set(key, JSON.stringify(s));
          }
        }
      });
      const f = createAgentFeatureFixture(feature, {backend}), id = await create(f);
      await prepare(f, id);
      conflict = true;
      await rejects(f.run(`delete ${id} confirm`), /changed/);
      assert.equal((await record(f, id)).action, 'Winning edit');
      conflict = true;
      remove = true;
      await rejects(f.run(`edit ${id} action | Stale overwrite`), /not found/);
      assert.match(await f.run('list'), /No saved/);
    });

test(
    'readable legacy list continuations bind the full originating state without resetting it',
    async () => {
      const f = createAgentFeatureFixture(feature), id = await create(f);
      const template = await record(f, id);
      // A valid older state may exceed today's future reservation. Reads/removals still work.
      const records =
          Array.from({length: 20}, (_, i) => ({...template, id: randomUUID(), lesson: `Lesson ${i}`}));
      f.backend.data.set(f.key('state'), JSON.stringify({version: 1, records}));
      const first = await f.run('list');
      const next = /Next: \/nobo-help agent learning-transfer (.*)/.exec(first)![1];
      assert.match(next, /snapshot [0-9a-f]{64}/);
      const last = await f.run(next);
      assert.ok(first.length <= 3500 && last.length <= 3500);
      for (const r of records) assert.ok((first + last).includes(r.id));
      assert.match(await f.run(`delete ${records[0].id} confirm`), /^Deleted privately\./);
      await rejects(f.run(next), /changed/);
      assert.equal(JSON.parse(f.backend.data.get(f.key('state'))!).records.length, 19);
    });

async function erasureFixture(f: ReturnType<typeof createAgentFeatureFixture>) {
  assert.match(await f.run("create Smaller PRs | Workshop | " + "\"".repeat(600)), /Saved/);
  const read = async () => (await f.store().read<any>("state"))!;
  const id = (await read()).records[0].id;
  for (let i = 0; i < 1; i++) assert.match(await f.run(`apply ${id} | ${"\"".repeat(180)} | ${"\"".repeat(300)}`), /Saved/);
  for (let i = 0; i < 1; i++) assert.match(await f.run(`predict ${id} | ${"\"".repeat(240)}`), /Saved/);
  for (let i = 0; i < 4; i++) assert.match(await f.run(`observe ${id} | ${"\"".repeat(240)}`), /Saved/);
  for (let i = 0; i < 1; i++) assert.match(await f.run(`reflect ${id} | ${"\"".repeat(240)}`), /Saved/);
  return { id, read };
}

for (const ceiling of [false, true]) test(`selective erasure retains other children and invalidates complete pages (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const f = createAgentFeatureFixture(feature), {id, read} = await erasureFixture(f);
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  const before = (await read()).records[0], child = before.observations[0].id;
  assert.deepEqual(JSON.parse(await f.run(`export ${id}`)).record, before);
  const first = await f.run(`show ${id}`), continuation = first.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1];
  assert.ok(continuation, "fixture exercises real continuation");
  assert.match(continuation, / rev \d+:[a-f0-9]{64}$/);
  assert.match(await f.run(continuation), /Page 2\//);
  assert.match(await f.run(`observation ${id} remove ${child} confirm`), /Saved|Removed/);
  const after = (await read()).records[0];
  assert.equal(after.revision, ceiling ? Number.MAX_SAFE_INTEGER : before.revision + 1);
  assert.deepEqual(after.observations, before.observations.slice(1));
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
    const raw = f.backend.data.get(f.key("state")); assert.match(await f.run(`edit ${id} lesson | Changed`), /Revision limit/);
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
  await f.run("create Smaller PRs | Workshop | " + "\"".repeat(600));
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; backend.data.set(f.key("state"), JSON.stringify(s)); }
  const original = backend.data.get(f.key("state"))!, r = (await read()).records[0], child = r.observations[0].id;
  const remove = (child: string) => `observation ${id} remove ${child} confirm`;
  // A real same-record removal wins while the original operation is awaiting CAS.
  for (const pending of [remove(child), `delete ${id} confirm`]) {
    backend.data.set(f.key("state"), original);
    action = async () => { assert.match(await f.run(remove(r.observations[1].id)), /Saved|Removed/); };
    assert.match(await f.run(pending), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  }
  // A competing writer reintroduces the child ID with changed content. The exact
  // numeric revision can be unchanged; intent must still bind the full snapshot.
  backend.data.set(f.key("state"), original);
  action = async () => {
    assert.match(await f.run(remove(child)), /Saved|Removed/);
    const s = await read(), replacement = structuredClone(r.observations[0]);
    replacement.text = "Reintroduced evidence";
    s.records[0].observations.push(replacement); backend.data.set(f.key("state"), JSON.stringify(s));
    assert.equal(JSON.parse(await f.run(`export ${id}`)).record.observations.at(-1).id, child);
  };
  assert.match(await f.run(remove(child)), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { await f.run(`delete ${id} confirm`); };
  assert.match(await f.run(remove(child)), /not found/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { const other = (await read()).records[1].id; await f.run(`delete ${other} confirm`); };
  assert.match(await f.run(remove(child)), /Saved|Removed/);
  const after = await read(); assert.equal(after.records.length, 1);
  assert.deepEqual(after.records[0].observations, r.observations.slice(1));
  assert.ok(backend.calls.conflicts >= 5);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

test("all field and relationship erasures remain valid at the root revision ceiling", async () => {
  const f = createAgentFeatureFixture(feature);
  const id = await create(f); await prepare(f,id);
  await f.run(`observe ${id} | First evidence`); await f.run(`observe ${id} | Second evidence`);
  await f.run(`reflect ${id} | Adjustment`);
  const s = (await f.store().read<any>("state"))!; s.records[0].revision = Number.MAX_SAFE_INTEGER;
  const original = JSON.stringify(s);
  for (const cmd of [`clear ${id} lesson confirm`,
    `clear ${id} sourceLabel confirm`,
    `clear ${id} sourceExcerpt confirm`,
    `clear ${id} opportunity confirm`,
    `clear ${id} action confirm`,
    `clear ${id} prediction confirm`,
    `clear ${id} reflection confirm`]) {
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
  const id = await create(f); await prepare(f,id);
  await f.run(`observe ${id} | Preserved evidence`); await f.run(`reflect ${id} | Prior reflection`); await create(f);
  const read = async () => (await f.store().read<any>("state"))!;
  const s = await read(), r = s.records[0]; r.revision = Number.MAX_SAFE_INTEGER;
  r.observationRevision = Number.MAX_SAFE_INTEGER;
  const raw = " \n" + JSON.stringify(s, null, 2) + "\t\n"; f.backend.data.set(f.key("state"), raw);
  const exported = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(exported) <= 24576);
  assert.deepEqual(JSON.parse(exported).record, r);
  const writes = f.backend.calls.writes, reply = await f.run(`observation ${id} remove ${r.observations[0].id} confirm`);
  assert.match(reply, /needs a new observation\/reflection version/); assert.match(reply, /finite history limit is exhausted/);
  assert.match(reply, /not applied/); assert.doesNotMatch(reply, /Invalid saved|corrupt|repair|retry|unavailable/i);
  assert.ok(reply.includes(`export ${id}`)); assert.ok(reply.includes(`delete ${id} confirm`));
  assert.ok(reply.length <= 3500);
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.backend.calls.writes, writes);
  assert.equal(await f.run(`export ${id}`), exported, "history and all associations are unchanged");
  assert.match(await f.run(`delete ${id} confirm`), /Deleted/);
    assert.deepEqual((await read()).records, s.records.slice(1));
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});
