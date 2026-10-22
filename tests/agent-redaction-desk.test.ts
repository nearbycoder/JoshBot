import assert from "node:assert/strict";
import test from "node:test";
import feature from "../lib/agent-features/redaction-desk.js";
import { createAgentFeatureFixture, createMemoryAgentBackend } from "./helpers/agent-feature-fixture.js";
const root = (s: string) => { const m = s.match(/Saved privately: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const token = (s: string) => { const m = s.match(/Preview token: ([0-9a-f-]{36})/); assert.ok(m, s); return m[1]; };
const rec = async (f: ReturnType<typeof createAgentFeatureFixture>, id: string) => JSON.parse(await f.run(`export ${id}`)).record;
const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
async function all(f: ReturnType<typeof createAgentFeatureFixture>, cmd: string) { let out = "", n = 0; do { const reply = await f.run(cmd); assert.ok(reply.length <= 3500); out += reply; cmd = reply.match(/Next: \/nobo-help agent redaction-desk ([^\n]+)/)?.[1] ?? ""; assert.ok(++n < 100); } while (cmd); return out; }
test("catalog scan-preview-apply-undo retains complete original/current/prior text", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(feature.example!.split("redaction-desk ")[1])), original = (await rec(f, id)).current;
  const t = token(await f.run(`scan ${id} | email`)), p = await f.run(`preview ${id} ${t}`); assert.match(p, /maya@example.com/); assert.match(p, /Contact Maya at \[EMAIL\]/); assert.match(p, /cannot detect all secrets/);
  await f.run(`apply ${id} ${t}`); const applied = await rec(f, id); assert.equal(applied.original, original); assert.equal(applied.undo, original); assert.equal(applied.current, "Contact Maya at [EMAIL] about the launch."); assert.equal(applied.preview, null);
  await assert.rejects(f.run(`apply ${id} ${t}`), /Preview changed/); await f.run(`undo ${id}`); assert.equal((await rec(f, id)).current, original); assert.equal((await rec(f, id)).undo, null); await assert.rejects(f.run(`undo ${id}`), /No undo/); assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
test("literal/email overlaps merge exact offsets; touching spans remain separate and selections rotate tokens", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create Overlap | 😀 maya@example.com Call +1 (312) 555-0123. abcd"));
  await f.run(`literal ${id} add maya`); await f.run(`literal ${id} add ab`); await f.run(`literal ${id} add cd`);
  const t = token(await f.run(`scan ${id} | email,phone,literal`)); const r = await rec(f, id), spans = r.preview.spans; assert.equal(spans.length, 4); assert.deepEqual(spans[0], { start: 3, end: 19, categories: ["email", "literal"] }); assert.equal(r.current.slice(spans[1].start, spans[1].end), "+1 (312) 555-0123"); assert.equal(spans[2].end, spans[3].start);
  const next = token(await f.run(`select ${id} ${t} | 1,3`)); assert.notEqual(t, next); await assert.rejects(f.run(`apply ${id} ${t}`)); await f.run(`apply ${id} ${next}`); assert.equal((await rec(f, id)).current, "😀 [MIXED] Call +1 (312) 555-0123. [LITERAL]cd");
});
test("every accepted field edits/removes and invalidates preview; undo survives manual text edits", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create T | a@example.com")); await f.run(`literal ${id} add secret`); const lid = (await rec(f, id)).literals[0].id; await f.run(`literal ${id} edit ${lid} | changed`);
  const t = token(await f.run(`scan ${id} | email`)); await f.run(`apply ${id} ${t}`); await f.run(`revise ${id} | Manual version`); assert.equal((await rec(f, id)).undo, "a@example.com"); await f.run(`undo ${id}`); assert.equal((await rec(f, id)).current, "a@example.com");
  for (const cmd of [`title ${id} | New title`, `original ${id} | Corrected original`, `settings ${id} | phone`, `remove ${id} literal ${lid} confirm`]) { const old = token(await f.run(`scan ${id} | email`)); await f.run(cmd); await assert.rejects(f.run(`apply ${id} ${old}`), /Preview changed/); }
  for (const field of ["original", "current", "undo", "preview", "literals", "settings"]) await f.run(`clear ${id} ${field} confirm`); const r = await rec(f, id); assert.equal(r.original, ""); assert.equal(r.current, ""); assert.deepEqual(r.enabled, []); await f.run(`delete ${id}`); assert.ok(await rec(f, id)); await f.run(`delete ${id} confirm`); await assert.rejects(f.run(`show ${id}`), /not found/);
});
test("bounded scans reject 31 spans and oversized masked text atomically; overlapping floods stay bounded", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run(`create Many | ${Array(31).fill("a@b.co").join(" ")}`)); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`scan ${id} | email`), /More than 30 merged spans/); assert.equal(f.backend.data.get(f.key("state")), raw);
  await f.run(`revise ${id} | ${"x".repeat(6000)}`); await f.run(`literal ${id} add ${"x".repeat(300)}`); const t = token(await f.run(`scan ${id} | literal`)); assert.equal((await rec(f, id)).preview.spans.length, 1); await f.run(`apply ${id} ${t}`); assert.equal((await rec(f, id)).current, "[LITERAL]"); await f.run(`undo ${id}`);
  await f.run(`clear ${id} literals confirm`); await f.run(`revise ${id} | ${"x".repeat(5998)} a`); await f.run(`literal ${id} add a`); const before = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`scan ${id} | literal`)); assert.equal(f.backend.data.get(f.key("state")), before);
});
test("maximum literal configuration, exact Unicode export/pages, and no double escaping", async () => {
  const f = createAgentFeatureFixture(feature), source = '文😀 <&> "\\| '.repeat(130) + " maya@example.com", id = root(await f.run(`create Unicode | ${esc(source)}`));
  for (let i = 0; i < 20; i++) await f.run(`literal ${id} add literal-${i}`); await assert.rejects(f.run(`literal ${id} add twenty-first`));
  const t = token(await f.run(`scan ${id} | email`)); await all(f, `preview ${id} ${t}`); await f.run(`apply ${id} ${t}`); const output = await f.run(`export ${id}`), r = JSON.parse(output).record; assert.equal(r.original, source); assert.equal(r.undo, source); assert.ok(Buffer.byteLength(output) <= 24576); const shown = await all(f, `show ${id}`); assert.ok(shown.includes("<&>")); assert.ok(!shown.includes("&amp;")); for (const l of r.literals) assert.ok(shown.includes(l.id)); await all(f, `copy ${id}`); await f.run(`undo ${id}`); assert.equal((await rec(f, id)).current, source);
});
test("near-capacity admitted originals can all scan/apply/undo in any order", async () => {
  const f = createAgentFeatureFixture(feature), ids: string[] = [];
  for (let i = 0; i < 6; i++) { try { ids.push(root(await f.run(`create Draft ${i} | a@b.co ${"x".repeat(5800)}`))); } catch { break; } }
  assert.ok(ids.length >= 2); const tokens: string[] = []; for (const id of ids) tokens.push(token(await f.run(`scan ${id} | email`)));
  for (let i = ids.length - 1; i >= 0; i--) { await f.run(`apply ${ids[i]} ${tokens[i]}`); assert.ok(Buffer.byteLength(f.backend.data.get(f.key("state"))!) <= 65536); assert.ok(Buffer.byteLength(await f.run(`export ${ids[i]}`)) <= 24576); }
  for (const id of ids) { await f.run(`undo ${id}`); assert.match((await rec(f, id)).current, /^a@b.co/); await f.run(`delete ${id} confirm`); }
});
test("corrupt preview offsets cannot apply/delete; owner and stale preview edits are protected", async () => {
  const f = createAgentFeatureFixture(feature), id = root(await f.run("create T | a@b.co")), t = token(await f.run(`scan ${id} | email`)); await assert.rejects(f.run(`apply ${id} ${t}`, { owner: { teamId: "TOTHER", userId: "UOTHER" } }), /not found/);
  const corrupt = JSON.parse(f.backend.data.get(f.key("state"))!); corrupt.records[0].preview.spans[0].start = 1; f.backend.data.set(f.key("state"), JSON.stringify(corrupt)); const raw = f.backend.data.get(f.key("state")); await assert.rejects(f.run(`apply ${id} ${t}`), /Invalid\/stale/); await assert.rejects(f.run(`delete ${id} confirm`)); assert.equal(f.backend.data.get(f.key("state")), raw);
});
test("actual CAS conflict rejects apply after concurrent edit or deletion without resurrecting state", async () => {
  let action = ""; const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) { if (!action || !previous || !key.endsWith(":state")) return; const mode = action; action = ""; const s = JSON.parse(previous); if (mode === "delete") s.records = []; else { s.records[0].revision++; s.records[0].current = "New text"; s.records[0].preview = null; } backend.data.set(key, JSON.stringify(s)); } });
  const f = createAgentFeatureFixture(feature, { backend }), id = root(await f.run("create T | a@b.co")); let t = token(await f.run(`scan ${id} | email`)); action = "edit"; await assert.rejects(f.run(`apply ${id} ${t}`), /changed/); assert.equal((await rec(f, id)).current, "New text");
  await f.run(`revise ${id} | a@b.co`); t = token(await f.run(`scan ${id} | email`)); action = "delete"; await assert.rejects(f.run(`apply ${id} ${t}`), /not found/); assert.equal((await f.store().read<any>("state")).records.length, 0); assert.equal(backend.calls.conflicts, 2);
});
