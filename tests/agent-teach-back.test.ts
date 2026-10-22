import assert from 'node:assert/strict';
import test from 'node:test';

import feature from '../lib/agent-features/teach-back.js';

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

const source = 'Cached data must be refreshed when the source changes.';
const rid = async (f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) =>
    savedId(await f.run(cmd));
const create = async (f: ReturnType<typeof createAgentFeatureFixture>) =>
    rid(f, `create Explain cache invalidation | ${source}`);
const concept = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) =>
    rid(f, `concept ${id} add Freshness | source,changes | ${source}`);
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) =>
    JSON.parse(await f.run(`export ${id}`)).record;
async function prepare(f: ReturnType<typeof createAgentFeatureFixture>) {
  const id = await create(f), c = await concept(f, id);
  await f.run(`explain ${id} | A cache is a saved copy that needs updating.`);
  return {id, c};
}
async function pages(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) {
  let all = '', n = 0;
  do {
    const reply = await f.run(cmd);
    assert.ok(reply.length <= 3500 && reply.isWellFormed());
    all += reply;
    cmd = /Next: \/nobo-help agent teach-back (.*)/.exec(reply)?.[1] ?? '';
    assert.ok(++n < 50);
  } while (cmd);
  return all;
}

test(
    'catalog exact-span concepts, lexical hints and self-ratings remain distinct from comprehension',
    async () => {
      const f = createAgentFeatureFixture(feature), {id, c} = await prepare(f);
      let review = await f.run(`review ${id}`);
      assert.match(review, /0\/2 terms present; gaps: source, changes/);
      assert.match(review, /Synonyms/);
      assert.ok(review.includes(source));
      await f.run(`self-rate ${id} ${c} | partial | Need to explain how changes are detected`);
      review = await f.run(`review ${id}`);
      assert.match(review, /partial \(current\)/);
      await f.run(`explain ${id} | I repeat source and changes`);
      assert.match(await f.run(`review ${id}`), /2\/2 terms present/);
      assert.match(await f.run(`review ${id}`), /STALE earlier explanation/);
      assert.match(
          await f.run(`review ${id}`), /neither term coverage nor self-rating proves comprehension/);
      const before = f.backend.data.get(f.key('state'));
      await rejects(f.run(`concept ${id} add Invalid | term | Not in the source`), /verbatim/);
      assert.equal(f.backend.data.get(f.key('state')), before);
      assert.deepEqual(f.calls, {generate: 0, search: 0, readContext: 0});
    });
test(
    'all source/rubric/explanation/rating fields are editable/removable with explicit rebinding',
    async () => {
      const f = createAgentFeatureFixture(feature), {id, c} = await prepare(f);
      await f.run(`self-rate ${id} ${c} | clear | My report`);
      await f.run(`source ${id} | New source evidence`);
      assert.match(await f.run(`review ${id}`), /STALE or missing/);
      await rejects(f.run(`self-rate ${id} ${c} | clear | Old source`), /rebind/);
      await f.run(`concept ${id} edit ${c} | Revised label | New,evidence | New source evidence`);
      await f.run(`self-rate ${id} ${c} | missing | Need practice`);
      await f.run(`self-rate ${id} ${c} clear confirm`);
      for (const field of ['label', 'requiredTerms', 'sourceSpan'])
        await f.run(`concept ${id} clear ${c} ${field} confirm`);
      for (const field of ['title', 'source', 'explanation']) {
        await f.run(`clear ${id} ${field} confirm`);
        await f.run(`edit ${id} ${field} | Restored text`);
      }
      await f.run(`concept ${id} remove ${c} confirm`);
      assert.equal((await record(f, id)).concepts.length, 0);
      assert.match(await f.run(`delete ${id} confirm`), /^Deleted privately\./);
      assert.match(await f.run('list'), /No saved/);
    });
test(
    'self-rating CAS rechecks intended explanation/rubric on every retry; unrelated sessions survive',
    async () => {
      let conflict = false, target = '';
      const backend = createMemoryAgentBackend({
        beforeCompareSet: (key, previous) => {
          if (conflict && previous) {
            conflict = false;
            const s = JSON.parse(previous), r = s.records.find((r: {id: string}) => r.id === target);
            r.revision++;
            r.contentRevision++;
            r.explanation = 'Changed explanation';
            backend.data.set(key, JSON.stringify(s));
          }
        }
      });
      const f = createAgentFeatureFixture(feature, {backend}), {id, c} = await prepare(f),
            other = await create(f);
      target = id;
      conflict = true;
      await rejects(f.run(`self-rate ${id} ${c} | clear | Old explanation`), /changed/);
      assert.equal((await record(f, id)).concepts[0].selfRating, null);
      target = other;
      conflict = true;
      await f.run(`self-rate ${id} ${c} | partial | Current explanation`);
      assert.equal((await record(f, id)).concepts[0].selfRating.value, 'partial');
      assert.equal((await record(f, other)).explanation, 'Changed explanation');
    });
test(
    'optional critique validates exact concept IDs, quotes, question count and complete response without saving',
    async () => {
      let mode = 'valid';
      const f = createAgentFeatureFixture(feature, {
        services: {
          generate: async ({input, instructions}) => {
            assert.ok(Buffer.byteLength(input) <= 16000);
            assert.ok(Buffer.byteLength(instructions) <= 4000);
            const r = JSON.parse(input), c = r.concepts[0], critique = {
              conceptId: c.conceptId,
              quote: c.quote,
              note: 'Explain how a source change is detected'
            },
                  questions =
                      [{conceptId: c.conceptId, quote: c.quote, question: 'What triggers refresh?'}];
            if (mode === 'id') critique.conceptId = '00000000-0000-4000-8000-000000000000';
            if (mode === 'quote') critique.quote = 'Invented excerpt';
            if (mode === 'count') questions.push(...Array.from({length: 3}, () => questions[0]));
            if (mode === 'oversize') return 'x'.repeat(4001);
            if (mode === 'refusal') return 'I cannot provide this critique';
            return JSON.stringify({critique, questions});
          }
        }
      });
      const {id} = await prepare(f), before = f.backend.data.get(f.key('state'));
      assert.match(await f.run(`coach ${id}`), /UNSAVED MODEL OPINION/);
      for (mode of ['id', 'quote', 'count', 'oversize', 'refusal'])
        assert.match(await f.run(`coach ${id}`), /invalid or oversized complete/);
      assert.equal(f.backend.data.get(f.key('state')), before);
      assert.deepEqual(f.calls, {generate: 6, search: 0, readContext: 0});
    });
test(
    'complete unsaved suggestion cannot be clipped or advertised as regenerated continuation',
    async () => {
      const quote = 'q'.repeat(600);
      const f = createAgentFeatureFixture(feature, {
        services: {
          generate: async ({input}) => {
            const c = JSON.parse(input).concepts[0];
            return JSON.stringify({
              critique: {conceptId: c.conceptId, quote: c.quote, note: 'n'.repeat(500)},
              questions: Array.from(
                  {length: 3},
                  () => ({conceptId: c.conceptId, quote: c.quote, question: 'Q'.repeat(150)}))
            });
          }
        }
      });
      const id = await rid(f, `create Full output | ${quote}`);
      await rid(f, `concept ${id} add Concept | q | ${quote}`);
      await f.run(`explain ${id} | q`);
      const out = await f.run(`coach ${id}`);
      assert.match(out, /oversized complete/);
      assert.doesNotMatch(out, /Next:.*coach/);
      assert.equal(f.calls.generate, 1);
    });
test(
    'late coach after edit/delete/abort is discarded, and failure never repairs or retries',
    async () => {
      for (const action of ['edit', 'delete', 'abort']) {
        const entered = deferred<void>(), gate = deferred<void>(), controller = new AbortController(),
              f = createAgentFeatureFixture(feature, {
                services: {
                  generate: async ({input}) => {
                    entered.resolve();
                    await gate.promise;
                    const c = JSON.parse(input).concepts[0];
                    return JSON.stringify({
                      critique: {conceptId: c.conceptId, quote: c.quote, note: 'Opinion'},
                      questions: []
                    });
                  }
                }
              }),
              {id} = await prepare(f), pending = f.run(`coach ${id}`, {signal: controller.signal});
        await entered.promise;
        if (action === 'abort') {
          const rejected = assert.rejects(pending);
          controller.abort();
          gate.resolve();
          await rejected;
        } else {
          await f.run(action === 'edit' ? `explain ${id} | New explanation` : `delete ${id} confirm`);
          gate.resolve();
          assert.match(await pending, /stale result discarded/);
        }
        assert.equal(f.calls.generate, 1);
      }
      const f = createAgentFeatureFixture(feature), {id} = await prepare(f);
      assert.match(await f.run(`coach ${id}`), /unavailable/);
      assert.equal(f.calls.generate, 1);
    });
test(
    'worst-case Unicode explanation and escaped ratings fit every admitted concept; full pages and export',
    async () => {
      const f = createAgentFeatureFixture(feature), ids: string[] = [];
      let rejected = false;
      for (let i = 0; i < 8; i++) {
        let id: string;
        try {
          id = await create(f);
        } catch (e) {
          assert.match(String(e), /quota/);
          rejected = true;
          break;
        }
        ids.push(id);
        for (let j = 0; j < 12; j++) {
          try {
            await concept(f, id);
          } catch (e) {
            assert.match(String(e), /quota/);
            rejected = true;
            break;
          }
        }
        if (rejected) break;
      }
      assert.ok(rejected);
      assert.equal((await record(f, ids[0])).concepts.length, 12);
      await assert.rejects(concept(f, ids[0]), /12/);
      for (const id of ids) {
        assert.match(await f.run(`explain ${id} | ${'漢'.repeat(3000)}`), /^Saved privately:/);
        for (const c of (await record(f, id)).concepts)
          assert.match(
              await f.run(`self-rate ${id} ${c.id} | partial | ${'"'.repeat(160)}`),
              /^Saved privately:/);
        const out = await f.run(`export ${id}`);
        assert.ok(Buffer.byteLength(out) <= 24576);
        const all = await pages(f, `show ${id}`);
        for (const c of (await record(f, id)).concepts) assert.ok(all.includes(c.id));
      }
      assert.ok(
          Buffer.byteLength(f.backend.data.get(f.key('state'))!) > 49152,
          'legitimate lifecycle growth exceeds content admission');
      assert.ok(Buffer.byteLength(f.backend.data.get(f.key('state'))!) <= 65536);
      const retained = await record(f, ids[0]);
      assert.match(
          await f.run(`self-rate ${ids[0]} ${retained.concepts[0].id} clear confirm`),
          /^Saved privately:/);
      assert.match(
          await f.run(`concept ${ids[0]} remove ${retained.concepts[0].id} confirm`),
          /^Saved privately:/);
      for (const verb of ['show', 'review'])
        await rejects(f.run(`${verb} ${ids[0]} page 1 rev ${retained.revision}`), /changed/);
      for (const id of ids) assert.match(await f.run(`delete ${id} confirm`), /^Deleted privately\./);
    });
test('exact character/byte boundaries, corruption and cross-owner access', async () => {
  const f = createAgentFeatureFixture(feature), id = await rid(f, `create Long | ${'s'.repeat(6000)}`);
  await f.run(`explain ${id} | ${'e'.repeat(3000)}`);
  let good = f.backend.data.get(f.key('state'))!;
  for (const cmd
           of [`source ${id} | ${'s'.repeat(6001)}`, `explain ${id} | ${'e'.repeat(3001)}`,
               `edit ${id} title | ${'漢'.repeat(41)}`])
    await rejects(f.run(cmd));
  assert.equal(f.backend.data.get(f.key('state')), good);
  for (const bad
           of ['null', '{', good.replace('"version":1', '"version":2'),
               good.replace('"sourceRevision":1', '"sourceRevision":900')]) {
    f.backend.data.set(f.key('state'), bad);
    await rejects(f.run(`delete ${id} confirm`));
    assert.equal(f.backend.data.get(f.key('state')), bad);
  }
  f.backend.data.set(f.key('state'), good);
  for (const owner
           of [{teamId: 'TOTHER', userId: f.owner.userId}, {teamId: f.owner.teamId, userId: 'UOTHER'}])
    await rejects(f.run(`show ${id}`, {owner}), /not found/);
});

test(
    'model input admission rejects the complete oversized source set before spending a call',
    async () => {
      const f = createAgentFeatureFixture(feature),
            id = await rid(f, `create Large supplied source | ${'s'.repeat(6000)}`);
      for (let i = 0; i < 6; i++)
        await rid(f, `concept ${id} add Concept ${i} | s | ${'s'.repeat(600)}`);
      assert.match(await f.run(`explain ${id} | ${'漢'.repeat(3000)}`), /^Saved privately:/);
      const before = f.backend.data.get(f.key('state'));
      assert.match(await f.run(`coach ${id}`), /input exceeds 16000/);
      assert.equal(f.calls.generate, 0);
      assert.equal(f.backend.data.get(f.key('state')), before);
    });

test('persisted self-rating enum must be an exact string, never a coercible array', async () => {
  const f = createAgentFeatureFixture(feature), {id, c} = await prepare(f);
  await f.run(`self-rate ${id} ${c} | clear | Reported understanding`);
  const raw = JSON.parse(f.backend.data.get(f.key('state'))!);
  raw.records[0].concepts[0].selfRating.value = ['clear'];
  const bad = JSON.stringify(raw);
  f.backend.data.set(f.key('state'), bad);
  await rejects(f.run(`delete ${id} confirm`), /Invalid saved/);
  assert.equal(f.backend.data.get(f.key('state')), bad);
});
