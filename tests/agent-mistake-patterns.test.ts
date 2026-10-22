import assert from 'node:assert/strict';
import test from 'node:test';

import feature from '../lib/agent-features/mistake-patterns.js';

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

const rid = async (f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) =>
    savedId(await f.run(cmd));
const rule = async (f: ReturnType<typeof createAgentFeatureFixture>) =>
    rid(f, 'rule add Before review, list three boundary cases | testing | 2026-10-23');
const record = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) =>
    JSON.parse(await f.run(`export ${id}`)).record;
async function pages(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) {
  let all = '', n = 0;
  do {
    const reply = await f.run(cmd);
    assert.ok(reply.length <= 3500 && reply.isWellFormed());
    all += reply;
    cmd = /Next: \/nobo-help agent mistake-patterns (.*)/.exec(reply)?.[1] ?? '';
    assert.ok(++n < 60);
  } while (cmd);
  return all;
}

test(
    'catalog civil recurrence, inclusive intervention boundary and truthful exposure denominators',
    async () => {
      const f = createAgentFeatureFixture(feature), r = await rule(f);
      await f.run('record 2026-10-22 | Review | Missed an edge case | testing');
      await f.run('record 2026-10-23 | Review | Boundary day error | testing');
      let out = await pages(f, `review ${r}`);
      assert.match(out, /BEFORE.*1 recorded incidents; opportunity denominator unknown/);
      assert.match(out, /AFTER.*1 recorded incidents; opportunity denominator unknown/);
      assert.match(out, /MISSING FOLLOW-UP/);
      await f.run(`opportunity ${r} | 2026-10-22 | failure | Missed empty input`);
      assert.match(await pages(f, `review ${r}`), /MISSING FOLLOW-UP/);
      assert.match(await pages(f, 'patterns testing'), /MISSING FOLLOW-UP/);
      await f.run(`opportunity ${r} | 2026-10-23 | success | Boundary list caught an empty input bug`);
      await f.run(`opportunity ${r} | 2026-10-24 | failure | Missed null path`);
      out = await pages(f, `review ${r}`);
      assert.match(out, /BEFORE.*failure fraction 1\/1/);
      assert.match(
          out,
          /AFTER.*2 recorded opportunities, 1 successes, 1 failures; reported failure fraction 1\/2/);
      await rule(f);
      assert.match(await pages(f, `review ${r}`), /Overlapping/);
      assert.match(await pages(f, 'patterns testing'), /MISSING FOLLOW-UP/);
      assert.deepEqual(f.calls, {generate: 0, search: 0, readContext: 0});
    });
test(
    'rule edits stale assessments; all case/rule/opportunity fields can be edited or removed',
    async () => {
      const f = createAgentFeatureFixture(feature), r = await rule(f),
            c = await rid(f, 'record 2024-02-29 | Review | Error | testing');
      await f.run(`link ${c} | ${r}`);
      await f.run(`opportunity ${r} | 2026-10-24 | success | Evidence`);
      const o = (await record(f, r)).opportunities[0].id;
      await f.run(`edit ${r} text | Different prevention rule`);
      assert.match(await pages(f, `review ${r}`), /1 stale opportunities excluded/);
      await f.run(`opportunity ${r} edit ${o} | 2026-10-25 | failure | Revised evidence`);
      assert.match(await pages(f, `review ${r}`), /failure fraction 1\/1/);
      await rejects(f.run(`edit ${r} category | other`), /unlink/);
      await f.run(`unlink ${c} confirm`);
      for (const [id, fields] of [
               [c, ['date', 'situation', 'observableError', 'category']],
               [r, ['text', 'category', 'startDate']]] as const) {
        for (const field of fields) {
          await f.run(`clear ${id} ${field} confirm`);
          await f.run(`edit ${id} ${field} | ${
              field === 'date' || field === 'startDate' ? '2026-10-20' : 'Corrected'}`);
        }
      }
      await f.run(`opportunity ${r} remove ${o} confirm`);
      assert.equal((await record(f, r)).opportunities.length, 0);
      await f.run(`link ${c} | ${r}`);
      await f.run(`delete ${r} confirm`);
      assert.equal((await record(f, c)).preventionRuleId, null);
    });
test('opportunity CAS rejects changed rule and preserves unrelated case edits', async () => {
  let conflict = false, target = '';
  const backend = createMemoryAgentBackend({
    beforeCompareSet: (key, previous) => {
      if (conflict && previous) {
        conflict = false;
        const s = JSON.parse(previous), r = s.records.find((r: {id: string}) => r.id === target);
        r.revision++;
        if (r.kind === 'rule') {
          r.ruleRevision++;
          r.text = 'Changed rule';
        } else
          r.observableError = 'Concurrent error';
        backend.data.set(key, JSON.stringify(s));
      }
    }
  });
  const f = createAgentFeatureFixture(feature, {backend}), r = await rule(f),
        c = await rid(f, 'record 2026-10-22 | Situation | Error | testing');
  target = r;
  conflict = true;
  await rejects(f.run(`opportunity ${r} | 2026-10-24 | success | Old rule evidence`), /changed/);
  assert.equal((await record(f, r)).opportunities.length, 0);
  target = c;
  conflict = true;
  await f.run(`opportunity ${r} | 2026-10-24 | success | Current evidence`);
  assert.equal((await record(f, r)).opportunities.length, 1);
  assert.equal((await record(f, c)).observableError, 'Concurrent error');
});
test(
    'maximum case list reaches last full ID and rule first follow-ups remain reserved at saturation',
    async () => {
      const f = createAgentFeatureFixture(feature), rs: string[] = [];
      for (let i = 0; i < 12; i++) rs.push(await rule(f));
      await assert.rejects(rule(f), /quota/);
      for (let i = 0; i < 60; i++) await f.run(`record 2026-10-22 | S${i} | E | testing`);
      await rejects(f.run('record 2026-10-22 | S | E | testing'), /quota/);
      const state = await f.store().read<{records: {id: string; kind: string}[]}>('state'),
            all = await pages(f, 'list');
      for (const r of state!.records) assert.ok(all.includes(r.id));
      let rejected = false;
      for (const c of state!.records.filter(r => r.kind === 'case')) {
        try {
          const reply = await f.run(`edit ${c.id} observableError | ${'"'.repeat(300)}`);
          if (!reply.startsWith('Saved privately:')) throw new Error(reply);
        } catch (e) {
          assert.match(String(e), /quota/);
          rejected = true;
          break;
        }
      }
      assert.ok(rejected);
      for (const r of rs) {
        assert.match(
            await f.run(`opportunity ${r} | 2026-10-23 | failure | ${'"'.repeat(160)}`),
            /^Saved privately:/);
        const first = (await record(f, r)).opportunities[0].id;
        assert.match(
            await f.run(`opportunity ${r} edit ${first} | 2026-10-24 | success | ${'"'.repeat(160)}`),
            /^Saved privately:/);
        const out = await f.run(`export ${r}`);
        assert.ok(Buffer.byteLength(out) <= 24576);
        await pages(f, `show ${r}`);
      }
      assert.ok(
          Buffer.byteLength(f.backend.data.get(f.key('state'))!) > 32768,
          'legitimate lifecycle growth exceeds content admission');
      assert.ok(Buffer.byteLength(f.backend.data.get(f.key('state'))!) <= 49152);
      const retained = await record(f, rs[0]);
      assert.match(
          await f.run(`opportunity ${rs[0]} remove ${retained.opportunities[0].id} confirm`),
          /^Saved privately:/);
      for (const r of state!.records)
        assert.match(await f.run(`delete ${r.id} confirm`), /^Deleted privately\./);
    });
test(
    'exact 60 opportunity cap, clear dates retain unknown buckets and snapshot navigation rejects changed cases',
    async () => {
      const f = createAgentFeatureFixture(feature), r = await rule(f);
      for (let i = 0; i < 60; i++) await f.run(`opportunity ${r} | 2026-10-23 | success | E${i}`);
      await rejects(f.run(`opportunity ${r} | 2026-10-23 | success | 61`));
      const c = await rid(f, 'record 2026-10-22 | Situation | Error | testing');
      await f.run(`clear ${c} date confirm`);
      assert.match(await pages(f, `review ${r}`), /1 undated cases/);
      const first = await f.run(`review ${r}`),
            next = /Next: \/nobo-help agent mistake-patterns (.*)/.exec(first)![1];
      await f.run(`edit ${c} observableError | Changed case`);
      await rejects(f.run(next), /changed/);
    });
test(
    'invalid civil labels, unknown outcomes and corrupt state preserve bytes; owner isolation',
    async () => {
      const f = createAgentFeatureFixture(feature), r = await rule(f),
            good = f.backend.data.get(f.key('state'))!;
      for (const cmd
               of ['record 2026-02-29 | S | E | C', `opportunity ${r} | 2026-10-24 | unknown | E`,
                   `edit ${r} text | ${'漢'.repeat(81)}`])
        await rejects(f.run(cmd));
      assert.equal(f.backend.data.get(f.key('state')), good);
      for (const bad
               of ['null', '{', good.replace('"version":1', '"version":2'),
                   good.replace('"ruleRevision":1', '"ruleRevision":2')]) {
        f.backend.data.set(f.key('state'), bad);
        await rejects(f.run(`delete ${r} confirm`));
        assert.equal(f.backend.data.get(f.key('state')), bad);
      }
      f.backend.data.set(f.key('state'), good);
      for (const owner
               of [{teamId: 'TOTHER', userId: f.owner.userId},
                   {teamId: f.owner.teamId, userId: 'UOTHER'}])
        await rejects(f.run(`show ${r}`, {owner}), /not found/);
    });

test(
    'derived patterns and list continuations bind their originating state; opportunity enums do not coerce',
    async () => {
      const f = createAgentFeatureFixture(feature), r = await rule(f);
      for (let i = 0; i < 20; i++)
        await f.run(`record 2026-10-22 | Situation ${i} | ${'x'.repeat(300)} | testing`);
      const list = await f.run('list'), summary = await f.run('patterns testing');
      const listNext = /Next: \/nobo-help agent mistake-patterns (.*)/.exec(list)![1];
      const summaryNext = /Next: \/nobo-help agent mistake-patterns (.*)/.exec(summary)![1];
      assert.match(listNext, /snapshot [0-9a-f]{64}/);
      assert.match(summaryNext, /snapshot [0-9a-f]{64}/);
      await f.run(`opportunity ${r} | 2026-10-24 | success | Evidence`);
      await rejects(f.run(listNext), /changed/);
      await rejects(f.run(summaryNext), /changed/);
      const literal = 'page 2 \\| C:\\\\notes';
      const before = JSON.parse(f.backend.data.get(f.key('state'))!);
      for (const c of before.records.filter((x: {kind: string}) => x.kind === 'case'))
        assert.match(await f.run(`edit ${c.id} category | ${literal}`), /^Saved privately:/);
      const filtered = await pages(f, `patterns | ${literal}`);
      assert.ok(filtered.includes('Category page 2 | C:\\notes: 20 cases'));
      for (const c of before.records.filter((x: {kind: string}) => x.kind === 'case'))
        assert.ok(filtered.includes(c.id));
      const raw = JSON.parse(f.backend.data.get(f.key('state'))!);
      raw.records.find((x: {id: string}) => x.id === r).opportunities[0].outcome = ['success'];
      const bad = JSON.stringify(raw);
      f.backend.data.set(f.key('state'), bad);
      await rejects(f.run(`delete ${r} confirm`), /Invalid saved/);
      assert.equal(f.backend.data.get(f.key('state')), bad);
    });

async function erasureFixture(f: ReturnType<typeof createAgentFeatureFixture>) {
  assert.match(await f.run("rule add Check boundaries | testing | 2026-10-23"), /Saved/);
  const read = async () => (await f.store().read<any>("state"))!;
  const id = (await read()).records[0].id;
  for (let i = 0; i < 20; i++) assert.match(await f.run(`opportunity ${id} | 2026-10-24 | success | ${"E".repeat(150)}`), /Saved/);
  return { id, read };
}

for (const ceiling of [false, true]) test(`selective erasure retains other children and invalidates complete pages (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  const f = createAgentFeatureFixture(feature), {id, read} = await erasureFixture(f);
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; f.backend.data.set(f.key("state"), JSON.stringify(s)); }
  const before = (await read()).records[0], child = before.opportunities[0].id;
  assert.deepEqual(JSON.parse(await f.run(`export ${id}`)).record, before);
  const first = await f.run(`show ${id}`), continuation = first.match(/\nNext: \/nobo-help agent [\w-]+ ([^\n]+)$/)?.[1];
  assert.ok(continuation, "fixture exercises real continuation");
  assert.match(continuation, / rev \d+:[a-f0-9]{64}$/);
  assert.match(await f.run(continuation), /Page 2\//);
  assert.match(await f.run(`opportunity ${id} remove ${child} confirm`), /Saved|Removed/);
  const after = (await read()).records[0];
  assert.equal(after.revision, ceiling ? Number.MAX_SAFE_INTEGER : before.revision + 1);
  assert.deepEqual(after.opportunities, before.opportunities.slice(1));
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
    const raw = f.backend.data.get(f.key("state")); assert.match(await f.run(`edit ${id} text | Changed`), /Revision limit/);
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
  await f.run("rule add Check boundaries | testing | 2026-10-23");
  if (ceiling) { const s = await read(); s.records[0].revision = Number.MAX_SAFE_INTEGER; backend.data.set(f.key("state"), JSON.stringify(s)); }
  const original = backend.data.get(f.key("state"))!, r = (await read()).records[0], child = r.opportunities[0].id;
  const remove = (child: string) => `opportunity ${id} remove ${child} confirm`;
  // A real same-record removal wins while the original operation is awaiting CAS.
  for (const pending of [remove(child), `delete ${id} confirm`]) {
    backend.data.set(f.key("state"), original);
    action = async () => { assert.match(await f.run(remove(r.opportunities[1].id)), /Saved|Removed/); };
    assert.match(await f.run(pending), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  }
  // A competing writer reintroduces the child ID with changed content. The exact
  // numeric revision can be unchanged; intent must still bind the full snapshot.
  backend.data.set(f.key("state"), original);
  action = async () => {
    assert.match(await f.run(remove(child)), /Saved|Removed/);
    const s = await read(), replacement = structuredClone(r.opportunities[0]);
    replacement.evidence = "Reintroduced evidence";
    s.records[0].opportunities.push(replacement); backend.data.set(f.key("state"), JSON.stringify(s));
    assert.equal(JSON.parse(await f.run(`export ${id}`)).record.opportunities.at(-1).id, child);
  };
  assert.match(await f.run(remove(child)), /changed/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { await f.run(`delete ${id} confirm`); };
  assert.match(await f.run(remove(child)), /not found/); assert.equal(backend.data.get(f.key("state")), winning);
  backend.data.set(f.key("state"), original);
  action = async () => { const other = (await read()).records[1].id; await f.run(`delete ${other} confirm`); };
  assert.match(await f.run(remove(child)), /Saved|Removed/);
  const after = await read(); assert.equal(after.records.length, 1);
  assert.deepEqual(after.records[0].opportunities, r.opportunities.slice(1));
  assert.ok(backend.calls.conflicts >= 5);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

for (const ceiling of [false, true]) test(`linked rule deletion protects case/rule snapshots (${ceiling ? "ceiling" : "ordinary"})`, async () => {
  let action: (() => Promise<void>) | undefined, winning: string | undefined;
  const backend = createMemoryAgentBackend({async beforeCompareSet(key) {
    if (key.endsWith(":state") && action) { const work = action; action = undefined; await work(); winning = backend.data.get(key); }
  }});
  const f = createAgentFeatureFixture(feature, {backend});
  await f.run("record 2026-10-22 | Review | Retain observable evidence | testing");
  const rid = await rule(f);
  const read = async () => (await f.store().read<any>("state"))!;
  const cid = (await read()).records[0].id;
  await f.run(`link ${cid} | ${rid}`);
  await f.run(`opportunity ${rid} | 2026-10-24 | success | Keep other evidence`);
  if (ceiling) { const s = await read(); for (const r of s.records) r.revision = Number.MAX_SAFE_INTEGER; backend.data.set(f.key("state"), JSON.stringify(s)); }
  const original = backend.data.get(f.key("state"))!, before = (await read()).records[0];
  for (const target of ["case", "rule", "new-link"]) {
    backend.data.set(f.key("state"), original);
    action = async () => {
      if (target === "case") await f.run(`clear ${cid} situation confirm`);
      else if (target === "rule") { const r = (await read()).records[1]; await f.run(`opportunity ${rid} remove ${r.opportunities[0].id} confirm`); }
      else {
        await f.run("record 2026-10-22 | Added case | New evidence | testing");
        const s = await read();
        // Model a valid concurrent legacy writer introducing a link to the same rule.
        s.records[2].preventionRuleId = rid; backend.data.set(f.key("state"), JSON.stringify(s));
        assert.equal(JSON.parse(await f.run(`export ${s.records[2].id}`)).record.preventionRuleId, rid);
      }
    };
    assert.match(await f.run(`delete ${rid} confirm`), /changed/i);
    assert.equal(backend.data.get(f.key("state")), winning);
  }
  backend.data.set(f.key("state"), original);
  assert.match(await f.run(`delete ${rid} confirm`), /Deleted/);
  const after = (await read()).records;
  assert.deepEqual(after, [{...before,preventionRuleId:null,revision:ceiling ? Number.MAX_SAFE_INTEGER : before.revision + 1}]);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});

test("all field and relationship erasures remain valid at the root revision ceiling", async () => {
  const f = createAgentFeatureFixture(feature);
  const id = await rule(f);
  await f.run(`opportunity ${id} | 2026-10-24 | success | Evidence`);
  const s = (await f.store().read<any>("state"))!; s.records[0].revision = Number.MAX_SAFE_INTEGER;
  const original = JSON.stringify(s);
  for (const cmd of [`clear ${id} text confirm`,
    `clear ${id} category confirm`,
    `clear ${id} startDate confirm`]) {
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
  const id = await rule(f);
  await f.run(`opportunity ${id} | 2026-10-24 | success | Preserved evidence`);
  await f.run("record 2026-10-22 | Keep case | Keep observable evidence | testing");
  const cid = (await f.store().read<any>("state"))!.records[1].id;
  await f.run(`link ${cid} | ${id}`); await rule(f);
  const read = async () => (await f.store().read<any>("state"))!;
  const s = await read(), r = s.records[0]; r.revision = Number.MAX_SAFE_INTEGER;
  r.ruleRevision = Number.MAX_SAFE_INTEGER; s.records[1].revision = Number.MAX_SAFE_INTEGER;
  const raw = " \n" + JSON.stringify(s, null, 2) + "\t\n"; f.backend.data.set(f.key("state"), raw);
  const exported = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(exported) <= 24576);
  assert.deepEqual(JSON.parse(exported).record, r);
  const writes = f.backend.calls.writes, reply = await f.run(`clear ${id} text confirm`);
  assert.match(reply, /needs a new rule\/evidence version/); assert.match(reply, /finite history limit is exhausted/);
  assert.match(reply, /not applied/); assert.doesNotMatch(reply, /Invalid saved|corrupt|repair|retry|unavailable/i);
  assert.ok(reply.includes(`export ${id}`)); assert.ok(reply.includes(`delete ${id} confirm`));
  assert.ok(reply.length <= 3500);
  assert.equal(f.backend.data.get(f.key("state")), raw); assert.equal(f.backend.calls.writes, writes);
  assert.equal(await f.run(`export ${id}`), exported, "history and all associations are unchanged");
  assert.match(await f.run(`delete ${id} confirm`), /Deleted/);
    const expected = s.records.slice(1).map((record:any) => record.id === cid ? {...record,preventionRuleId:null} : record);
  assert.deepEqual((await read()).records, expected);
  assert.deepEqual(f.calls, {generate:0,search:0,readContext:0});
});
