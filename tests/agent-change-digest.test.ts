import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/change-digest.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const rec = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
async function all(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) { let out = "", n = 0; do { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); out += reply; cmd = reply.match(/Next: \/nobo-help agent change-digest ([^\n]+)/)?.[1] ?? ""; assert.ok(++n < 200); } while (cmd); return out; }
const hids = (s: string) => [...new Set([...s.matchAll(/[0-9a-f-]{36}:r\d+:h\d+/g)].map(m => m[0]))];
test("catalog comparison exposes exact changed dates/numbers and reviewed digest categories", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.split("change-digest ")[1])); assert.match(await f.run(`compare ${id}`), /After version not supplied/);
  await f.run(`after ${id} | Launch on November 6 with 20 users.`); const report = await f.run(`compare ${id}`), hid = hids(report)[0]; assert.ok(hid); assert.match(report, /old date \[10,20\): "October 30"/); assert.match(report, /new date \[10,20\): "November 6"/); assert.match(report, /old number.*"10"/); assert.match(report, /new number.*"20"/);
  await f.run(`classify ${id} ${hid} | substantive | Launch date and audience changed`); const digest = await f.run(`digest ${id}`); assert.match(digest, /SUBSTANTIVE: 1/); assert.match(digest, /COSMETIC: 0/); assert.match(digest, /UNREVIEWED: 0/); assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("repeated lines, insertions/deletions and Unicode reconstruct exactly from reported hunks", async () => {
  const f = createAgentFeatureFixture(feature);
  for (const [before, after] of [["same\nA\nsame\nB\nsame", "same\nB\nsame\nA\nsame"], ["one\n文😀\ntwo", "zero\none\n文😀\nthree"], ["old", ""], ["", "new"], ["unchanged", "unchanged"]]) {
    const id = root(await f.run(`create Compare | before | ${before}`)); await f.run(`after ${id} | ${after}`); const report = await all(f, `compare ${id}`);
    const re = /before \[(\d+),(\d+)\).*\nDeleted exact span: ("(?:\\.|[^"\\])*")\nInserted exact span: ("(?:\\.|[^"\\])*")/g;
    const patches = [...report.matchAll(re)].map(m => ({ start: Number(m[1]), end: Number(m[2]), old: JSON.parse(m[3]), next: JSON.parse(m[4]) })); let rebuilt = before;
    for (const p of patches.reverse()) { assert.equal(before.slice(p.start, p.end), p.old); rebuilt = rebuilt.slice(0, p.start) + p.next + rebuilt.slice(p.end); }
    assert.equal(rebuilt, after); if (before === after) assert.match(report, /No changes/); await f.run(`delete ${id} confirm`);
  }
});
test("classification edits preserve hunk IDs; every version/label edit invalidates classifications", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create T | old label | Alpha\nkeep\nBeta")); await f.run(`after ${id} | Alpha!\nkeep\nBeta!`); let hs = hids(await f.run(`compare ${id}`)); assert.equal(hs.length, 2);
  await f.run(`classify ${id} ${hs[0]} | cosmetic | punctuation`); await f.run(`classify ${id} ${hs[0]} | substantive | changed emphasis`); assert.deepEqual(hids(await f.run(`compare ${id}`)), hs); assert.match(await f.run(`digest ${id}`), /UNREVIEWED: 1/);
  await f.run(`unclassify ${id} ${hs[0]} confirm`); assert.equal((await rec(f, id)).classifications.length, 0);
  for (const command of [`before ${id} | Before`, `after ${id} | After`, `labels ${id} | Original draft | Revised draft`, `title ${id} | New title`]) { hs = hids(await f.run(`compare ${id}`)); await f.run(`classify ${id} ${hs[0]} | substantive | rationale`); await f.run(command); assert.equal((await rec(f, id)).classifications.length, 0); await assert.rejects(f.run(`classify ${id} ${hs[0]} | cosmetic | stale`), /Hunk changed/); }
  await f.run(`clear ${id} classifications confirm`); await f.run(`clear ${id} before confirm`); assert.match(await f.run(`compare ${id}`), /INSERTION/); await f.run(`clear ${id} after confirm`); assert.equal((await rec(f, id)).after, null); await f.run(`delete ${id} confirm`);
});
test("number signs, duplicate quantities, lexical name/date and whitespace hints do not auto-classify", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Hints | old | Maya recorded -5% and 10 then 10 on 2026-10-22.\nkeep\na  b")); await f.run(`after ${id} | Noah recorded 5% and 10 on 2026-10-23.\nkeep\na b`);
  const r = await f.run(`compare ${id}`); assert.match(r, /old number.*"-5%"/); assert.match(r, /old number.*"10"/); assert.match(r, /old date.*"2026-10-22"/); assert.match(r, /new name\?.*"Noah"/); assert.match(r, /Whitespace-only hint/); assert.equal((await rec(f, id)).classifications.length, 0); assert.match(await f.run(`digest ${id}`), /UNREVIEWED: 2/);
});
test("120 lines/60 hunks support all reserved maximum escaped rationales and complete retrieval", async () => {
  const f = createAgentFeatureFixture(feature), before = Array.from({ length: 120 }, (_, i) => i % 2 === 0 ? `old${i}` : `same${i}`).join("\n"), after = Array.from({ length: 120 }, (_, i) => i % 2 === 0 ? `new${i}` : `same${i}`).join("\n");
  const id = root(await f.run(`create Maximum | old | ${before}`)); await f.run(`after ${id} | ${after}`); const hs = hids(await all(f, `compare ${id}`)); assert.equal(hs.length, 60);
  const note = '"\\'.repeat(48); for (const hid of hs) await f.run(`classify ${id} ${hid} | substantive | ${esc(note)}`);
  const exported = await f.run(`export ${id}`); assert.ok(Buffer.byteLength(exported) <= 24576); const r = JSON.parse(exported).record; assert.equal(r.classifications.length, 60); assert.ok(r.classifications.every((c: any) => c.note === note)); assert.equal(r.before, before); assert.equal(r.after, after);
  const shown = await all(f, `show ${id}`); for (const hid of hs) assert.ok(shown.includes(hid)); const digest = await all(f, `digest ${id}`); assert.match(digest, /SUBSTANTIVE: 60/); assert.match(digest, /UNREVIEWED: 0/); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`after ${id} | ${Array(121).fill("x").join("\n")}`)); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("maximum 6000-unit sources and escaped Unicode remain exact; reply pages reject stale revisions", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(`create Long | before | ${"x".repeat(6000)}`)); await f.run(`after ${id} | ${"y".repeat(6000)}`); await all(f, `compare ${id}`); const revision = (await rec(f, id)).revision;
  const value = '<@UOTHER> & "\\| 文😀 é'.repeat(100); await f.run(`before ${id} | ${esc(value)}`); await f.run(`after ${id} | ${esc(value + " changed")}`); assert.equal((await rec(f, id)).before, value); assert.ok((await all(f, `show ${id}`)).includes("<@UOTHER> &")); await assert.rejects(f.run(`compare ${id} page 2 rev ${revision}`), /changed/); await assert.rejects(f.run(`after ${id} | ${"x".repeat(6001)}`));
});
test("near-state quota reserves classifications; invalid state and foreign owners cannot mutate", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 6; i++) { try { const id = root(await f.run(`create Draft ${i} | old | ${"文".repeat(2100)}`)); ids.push(id); await f.run(`after ${id} | ${"界".repeat(2100)}`); } catch { break; } }
  assert.ok(ids.length >= 3); for (const id of ids) { const hs = hids(await all(f, `compare ${id}`)); for (const h of hs) await f.run(`classify ${id} ${h} | substantive | ${esc('"'.repeat(96))}`); }
  assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 65536); await assert.rejects(f.run(`show ${ids[0]}`, { owner: { teamId: "TOTHER", userId: "UOTHER" } }), /not found/);
  const invalid = JSON.parse(f.backend.data.get(f.key("state"))!); invalid.records[0].classifications[0].hunkId = `${ids[0]}:r999:h1`; f.backend.data.set(f.key("state"), JSON.stringify(invalid)); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`delete ${ids[0]} confirm`), /Invalid or stale/); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("actual CAS text edit wins over classification and leaves no stale review", async () => {
  let armed = false; const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) { if (!armed || !previous || !key.endsWith(":state")) return; armed = false; const s = JSON.parse(previous); s.records[0].after = "Concurrent edit"; s.records[0].revision++; s.records[0].diffRevision++; s.records[0].classifications = []; backend.data.set(key, JSON.stringify(s)); } });
  const f = createAgentFeatureFixture(feature, { backend }), id = root(await f.run("create T | old | Before")); await f.run(`after ${id} | After`); const h = hids(await f.run(`compare ${id}`))[0]; armed = true; await assert.rejects(f.run(`classify ${id} ${h} | cosmetic | stale`), /changed/); assert.equal((await rec(f, id)).after, "Concurrent edit"); assert.equal((await rec(f, id)).classifications.length, 0); assert.equal(backend.calls.conflicts, 1);
});

test("clearing before above content quota preserves remaining hunk lifecycle capacity", async () => {
  for (const remaining of [null, "removable before", "changed after", ""]) {
    const f = createAgentFeatureFixture(feature), ids: string[] = [];
    const before = Array.from({ length: 120 }, (_, i) => i % 2 ? `s${i}` : `a${i}`).join("\n");
    const after = Array.from({ length: 120 }, (_, i) => i % 2 ? `s${i}` : `b${i}`).join("\n");
    for (let i = 0; i < 3; i++) {
      const id = root(await f.run(`create T${i} | old | ${before}`)); ids.push(id);
      await f.run(`after ${id} | ${after}`);
    }
    const small = root(await f.run("create Small | old | removable before"));
    if (remaining !== null) await f.run(`after ${small} | ${remaining}`);
    const note = '"'.repeat(96);
    for (const id of ids) {
      const hs = hids(await all(f, `compare ${id}`)); assert.equal(hs.length, 60);
      for (const h of hs) await f.run(`classify ${id} ${h} | substantive | ${note}`);
    }
    const previous = await rec(f, small), bytes = Buffer.byteLength(f.backend.data.get(f.key("state"))!);
    assert.ok(bytes > 49152);
    assert.match(await f.run(`clear ${small} before confirm`), /^Saved/);
    const cleared = await rec(f, small);
    assert.equal(cleared.before, ""); assert.equal(cleared.after, remaining);
    assert.equal(cleared.diffRevision, previous.diffRevision + 1); assert.deepEqual(cleared.classifications, []);
    const report = await f.run(`compare ${small}`), hs = hids(report);
    assert.equal(hs.length, remaining ? 1 : 0);
    if (remaining) { assert.match(report, /INSERTION/); assert.ok(report.includes(JSON.stringify(remaining))); }
    for (const h of hs) await f.run(`classify ${small} ${h} | substantive | ${note}`);
    for (const id of [...ids, small]) assert.ok(Buffer.byteLength(await f.run(`export ${id}`)) <= 24576);
    assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 65536);
    for (const id of ids) assert.equal((await rec(f, id)).classifications.length, 60);
    assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  }
});
