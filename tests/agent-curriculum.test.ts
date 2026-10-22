import assert from 'node:assert/strict';
import test from 'node:test';

import feature from '../lib/agent-features/curriculum.js';

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

const create = async (f: ReturnType<typeof createAgentFeatureFixture>, settings = '3 | 25') =>
    savedId(await f.run(`create Learn SQL joins | ${settings}`));
const unit = async (
    f: ReturnType<typeof createAgentFeatureFixture>, c: string, name: string, sessions = 2) =>
    savedId(await f.run(`unit ${c} add ${name} | ${sessions} | Explain ${name} with a worked example`));
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, c: string) =>
    JSON.parse(await f.run(`export ${c}`)).record;
async function pages(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) {
  let all = '', n = 0;
  do {
    const reply = await f.run(cmd);
    assert.ok(reply.length <= 3500 && reply.isWellFormed());
    all += reply;
    cmd = /Next: \/nobo-help agent curriculum (.*)/.exec(reply)?.[1] ?? '';
    assert.ok(++n < 60);
  } while (cmd);
  return all;
}

test('catalog prerequisites, shared closure and evidence unlock without inferred mastery', async () => {
  const f = createAgentFeatureFixture(feature), c = await create(f),
        inner = await unit(f, c, 'Inner joins'), left = await unit(f, c, 'Left joins'),
        outer = await unit(f, c, 'Outer joins');
  await f.run(`requires ${c} ${left} | ${inner}`);
  await f.run(`requires ${c} ${outer} | ${inner},${left}`);
  const p = await pages(f, `plan ${c}`);
  assert.match(p, /6\/36 whole sessions allocated, 150 minutes/);
  assert.match(p, /BLOCKED/);
  assert.match(p, /CONDITIONAL/);
  assert.equal(p.match(new RegExp(`Unit ${inner}:`, 'g'))?.length, 1);
  await rejects(f.run(`demonstrate ${c} ${left} | Guessed`), /Blocked/);
  await f.run(`demonstrate ${c} ${inner} | Explained matching rows correctly`);
  assert.match(await pages(f, `plan ${c}`), new RegExp(`Next eligible unit: ${left}`));
  await f.run(`demonstrate ${c} ${left} | Explained unmatched left rows`);
  await f.run(`demonstrate ${c} ${outer} | Explained all unmatched rows`);
  await f.run(`unit ${c} edit ${inner} | Inner joins | 2 | Explain duplicate matches`);
  const stale = await pages(f, `plan ${c}`);
  assert.equal((stale.match(/Evidence \(STALE\)/g) ?? []).length, 3);
  assert.match(stale, /Explained matching rows correctly/);
  assert.deepEqual(f.calls, {generate: 0, search: 0, readContext: 0});
});
test(
    'cycle/unknown edges rejected, 12-week horizon bounds whole sessions, unknown differs from blocked',
    async () => {
      const f = createAgentFeatureFixture(feature), c = await create(f, '1 | 30'),
            a = await unit(f, c, 'A', 13), b = await unit(f, c, 'B', 3);
      await f.run(`requires ${c} ${b} | ${a}`);
      const before = f.backend.data.get(f.key('state'));
      await rejects(f.run(`requires ${c} ${a} | ${b}`), /cycle/);
      assert.equal(f.backend.data.get(f.key('state')), before);
      await rejects(f.run(`requires ${c} ${a} | 00000000-0000-4000-8000-000000000000`), /Missing/);
      const p = await pages(f, `plan ${c}`);
      assert.match(p, /12\/12 whole sessions allocated, 360 minutes; 4 known sessions unallocated/);
      assert.doesNotMatch(p, /week 13/);
      await f.run(`unit ${c} clear ${a} readinessTest confirm`);
      assert.match(await pages(f, `plan ${c}`), /UNKNOWN/);
      await rejects(f.run(`demonstrate ${c} ${a} | Evidence`), /Unknown/);
    });
test(
    'all fields and evidence can be edited, removed and reopened with dependent invalidation',
    async () => {
      const f = createAgentFeatureFixture(feature), c = await create(f), a = await unit(f, c, 'A'),
            b = await unit(f, c, 'B');
      await f.run(`requires ${c} ${b} | ${a}`);
      await f.run(`demonstrate ${c} ${a} | First evidence`);
      await f.run(`evidence ${c} ${a} | 2024-02-29 | Corrected evidence`);
      assert.equal((await record(f, c)).units[0].demonstration.date, '2024-02-29');
      await f.run(`demonstrate ${c} ${b} | Second evidence`);
      await f.run(`reopen ${c} ${a} confirm`);
      assert.match(await pages(f, `plan ${c}`), /STALE/);
      for (const field of ['target', 'sessionsPerWeek', 'sessionMinutes']) {
        await f.run(`clear ${c} ${field} confirm`);
        await f.run(`edit ${c} ${field} | ${field === 'target' ? 'New target' : '4'}`);
      }
      for (const field of ['label', 'estimateSessions', 'readinessTest'])
        await f.run(`unit ${c} clear ${a} ${field} confirm`);
      await f.run(`unit ${c} edit ${a} | New unit | 3 | Observable criterion`);
      await f.run(`requires ${c} ${b} clear confirm`);
      await f.run(`requires ${c} ${b} | ${a}`);
      await f.run(`unit ${c} remove ${a} confirm`);
      const r = await record(f, c);
      assert.equal(r.units.length, 1);
      assert.deepEqual(r.units[0].prerequisites, []);
      assert.ok(r.units[0].demonstration.unitRevision < r.units[0].revision);
      assert.match(await f.run(`delete ${c} confirm`), /^Deleted privately\./);
      assert.match(await f.run('list'), /No saved/);
    });
test(
    'demonstration CAS never certifies changed readiness and unrelated course retries survive',
    async () => {
      let conflict = false, target = '';
      const backend = createMemoryAgentBackend({
        beforeCompareSet: (key, previous) => {
          if (conflict && previous) {
            conflict = false;
            const s = JSON.parse(previous), c = s.records.find((x: {id: string}) => x.id === target);
            c.revision++;
            c.units[0].revision++;
            c.units[0].readinessTest = 'Concurrent criterion';
            backend.data.set(key, JSON.stringify(s));
          }
        }
      });
      const f = createAgentFeatureFixture(feature, {backend}), c = await create(f),
            a = await unit(f, c, 'A'), other = await create(f);
      await unit(f, other, 'Other');
      target = c;
      conflict = true;
      await rejects(f.run(`demonstrate ${c} ${a} | Obsolete evidence`), /changed/);
      assert.equal((await record(f, c)).units[0].demonstration, null);
      target = other;
      conflict = true;
      await f.run(`demonstrate ${c} ${a} | Current evidence`);
      assert.ok((await record(f, c)).units[0].demonstration);
      assert.equal(backend.calls.conflicts, 2);
    });
test('maximum units, Unicode lifecycle reservation and complete paginated export', async () => {
  const f = createAgentFeatureFixture(feature), courses: string[] = [];
  let stopped = false;
  for (let i = 0; i < 8; i++) {
    let c: string;
    try {
      c = await create(f);
    } catch (e) {
      assert.match(String(e), /quota/);
      break;
    }
    courses.push(c);
    for (let j = 0; j < 24; j++) {
      try {
        await unit(f, c, `Unit ${j}`);
      } catch (e) {
        assert.match(String(e), /quota/);
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }
  assert.ok(stopped);
  const first = await record(f, courses[0]);
  assert.equal(first.units.length, 24);
  await assert.rejects(unit(f, courses[0], '25th'), /24/);
  for (const c of courses) {
    for (const u of (await record(f, c)).units)
      assert.match(await f.run(`demonstrate ${c} ${u.id} | ${'"'.repeat(240)}`), /^Saved privately:/);
    const out = await f.run(`export ${c}`);
    assert.ok(Buffer.byteLength(out) <= 24576);
    const all = await pages(f, `show ${c}`);
    for (const u of (await record(f, c)).units) assert.ok(all.includes(u.id));
  }
  assert.ok(
      Buffer.byteLength(f.backend.data.get(f.key('state'))!) > 32768,
      'legitimate lifecycle growth exceeds content admission');
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key('state'))!) <= 49152);
  const retained = await record(f, courses[0]);
  assert.match(await f.run(`reopen ${courses[0]} ${retained.units[0].id} confirm`), /^Saved privately:/);
  assert.match(
      await f.run(`unit ${courses[0]} remove ${retained.units[0].id} confirm`), /^Saved privately:/);
  for (const verb of ['show', 'plan'])
    await rejects(f.run(`${verb} ${courses[0]} page 1 rev ${retained.revision}`), /changed/);
  for (const c of courses) assert.match(await f.run(`delete ${c} confirm`), /^Deleted privately\./);
});
test(
    'schema corruption/invalid inputs preserve bytes and foreign owners cannot retrieve courses',
    async () => {
      const f = createAgentFeatureFixture(feature), c = await create(f), a = await unit(f, c, 'A'),
            good = f.backend.data.get(f.key('state'))!;
      for (const bad
               of ['null', '{', good.replace('"version":1', '"version":2'),
                   good.replace('"prerequisites":[]', `"prerequisites":["${a}"]`)]) {
        f.backend.data.set(f.key('state'), bad);
        await rejects(f.run(`delete ${c} confirm`));
        assert.equal(f.backend.data.get(f.key('state')), bad);
      }
      f.backend.data.set(f.key('state'), good);
      for (const cmd
               of ['create Bad | 15 | 20', 'create Bad | 1 | 181', `unit ${c} add X | 169 | Y`,
                   `evidence ${c} ${a} | 2026-02-29 | X`])
        await rejects(f.run(cmd));
      assert.equal(f.backend.data.get(f.key('state')), good);
      for (const owner
               of [{teamId: 'TOTHER', userId: f.owner.userId},
                   {teamId: f.owner.teamId, userId: 'UOTHER'}])
        await rejects(f.run(`show ${c}`, {owner}), /not found/);
    });

test(
    'eight courses and exactly sixty DAG edges are accepted; the next edge is rejected atomically',
    async () => {
      const f = createAgentFeatureFixture(feature), ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await create(f));
      await assert.rejects(create(f), /Eight/);
      const c = ids[0], units: string[] = [];
      for (let i = 0; i < 12; i++) units.push(await unit(f, c, `U${i}`));
      let count = 0;
      for (let i = 1; i < 12; i++) {
        const predecessors = units.slice(0, Math.min(i, 60 - count));
        if (predecessors.length) {
          assert.match(
              await f.run(`requires ${c} ${units[i]} | ${predecessors.join(',')}`), /^Saved privately:/);
          count += predecessors.length;
        }
      }
      assert.equal(count, 60);
      const before = f.backend.data.get(f.key('state'));
      await rejects(
          f.run(`requires ${c} ${units[11]} | ${units.slice(0, 6).join(',')}`), /60 prerequisite/);
      assert.equal(f.backend.data.get(f.key('state')), before);
    });
