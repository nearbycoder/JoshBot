import assert from "node:assert/strict";
import test from "node:test";
import { boundedText, pipeFields, parseInteger, parseDecimal, parsePage, renderText, paginateParts, pageAt } from "../lib/agent-features/feature-kit/command-and-display.js";
import { serializedBytes, assertStateVersion, assertRevision, assertQuota } from "../lib/agent-features/feature-kit/bounded-state.js";
import { captureEvidence } from "../lib/agent-features/feature-kit/evidence.js";
import { civilDate, addCivilDays, compareCivilDates, civilDaysBetween, normalizeInstant, dateInZone, civilRange, instantRange } from "../lib/agent-features/feature-kit/civil-time.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";
import type { AgentFeature, AgentContextItem } from "../lib/agent-features/types.js";

test("bounded parsers preserve complete decoded fields and reject ambiguous/partial input", () => {
  assert.equal(boundedText(" 😀界 ", { label: "Title", maxBytes: 9 }), "😀界");
  assert.throws(() => boundedText(" 😀界 ", { label: "Title", maxBytes: 8 }), /too long/);
  assert.throws(() => boundedText("😀", { label: "Title", maxBytes: 4, maxUnits: 1 }), /too long/);
  for (const value of ["\ud800", "\udc00", "a\u0000b", "\u007f"]) assert.throws(() => boundedText(value, { label: "Input", maxBytes: 100 }), /valid text/);
  const fields = [{ label: "Title", maxBytes: 40 }, { label: "Body", maxBytes: 40, trim: false }];
  assert.deepEqual(pipeFields(String.raw`a\|b | c\\d`, fields), ["a|b", String.raw` c\d`]);
  for (const value of ["a|b|c", "a", "a||", "a|", String.raw`a\q|b`, "a|b\\"]) assert.throws(() => pipeFields(value, fields));
  assert.equal(parseInteger("-12", { min: -20, max: 20 }), -12);
  assert.equal(parseDecimal("0.25", { min: 0, max: 1 }), 0.25);
  for (const value of ["+1", "01", "-0", "1e2", "NaN", "Infinity", " 1", "1x", "9007199254740992", "1.2"]) assert.throws(() => parseInteger(value, { min: -100, max: Number.MAX_SAFE_INTEGER }));
  for (const value of [".5", "1.", "1e-2", "01.2", "-0.0"]) assert.throws(() => parseDecimal(value, { min: -2, max: 2 }));
  assert.equal(parsePage(), 1);
  for (const value of ["", "0", "01", "2 page 3", "10001"]) assert.throws(() => parsePage(value));
});

test("plain and mrkdwn pages preserve exact text with escaped dynamic headers and next commands", () => {
  const input = "😀<&>e\u0301 ".repeat(140);
  assert.equal(renderText("<tag> & https://example.com/?a=1&b=2", "plain"), "<tag> & https://example.com/?a=1&b=2");
  assert.equal(renderText("<tag>&", "mrkdwn"), "&lt;tag&gt;&amp;");
  for (const mode of ["plain", "mrkdwn"] as const) {
    const command = (page: number) => `/nobo-help agent sample show item-42 page ${page}${page >= 10 ? " &filter" : ""}`;
    const pages = paginateParts([{ text: input }], { mode, title: "Detail <&>", command, maxUnits: 140 });
    assert.ok(pages.length > 10);
    assert.equal(pages.map(page => page.body).join(""), input);
    pages.forEach((page, index) => {
      assert.ok(page.text.length <= 140, page.text.length.toString());
      assert.ok(page.body.isWellFormed() && page.text.isWellFormed());
      assert.ok(page.text.startsWith(renderText("Detail <&>", mode)));
      assert.equal(pageAt(pages, index + 1), page);
      if (index < pages.length - 1) {
        assert.equal(page.nextCommand, command(index + 2));
        assert.ok(page.text.endsWith(renderText(`Next: ${command(index + 2)}`, mode)));
      } else assert.equal(page.nextCommand, undefined);
    });
    assert.throws(() => pageAt(pages, 0), /page 1/);
    assert.throws(() => pageAt(pages, pages.length + 1), /page 1/);
  }
});

test("maximum retained detail and final item remain reachable; atomic values never split", () => {
  const id = "item-11111111-1111-4111-8111-111111111111";
  const url = "https://example.com/a%2Fb?q=`raw`&next=%26&repeated=1&repeated=2#part";
  let body = "😀界\"\\& ".repeat(1_200);
  body += "x".repeat(24_576 - serializedBytes({ id, body, url }));
  assert.equal(serializedBytes({ id, body, url }), 24_576, "The complete record occupies its exact maximum byte budget");
  const parts = Array.from({ length: 12 }, (_, index) => ({ text: `\n${id}-${index + 1}\n`, atomic: true }));
  const pages = paginateParts([{ text: body }, { text: url, atomic: true }, ...parts], { mode: "plain", command: page => `/nobo-help agent sample show ${id} page ${page}` });
  assert.equal(pages.map(page => page.body).join(""), body + url + parts.map(part => part.text).join(""));
  assert.ok(pages.some(page => page.body.includes(`${id}-12`)));
  assert.ok(pages.some(page => page.body.includes(url)));
  for (const page of pages) assert.ok(page.text.length <= 3_500);
  const auto = paginateParts([{ text: `Intro\n${url}\n/nobo-help agent sample show ${id}\n${body}` }], { mode: "plain", command: p => `/nobo-help agent sample show ${id} page ${p}`, maxUnits: 250 });
  assert.ok(auto.some(page => page.body.includes(url)));
  assert.ok(auto.some(page => page.body.includes(`/nobo-help agent sample show ${id}`)));
  assert.throws(() => paginateParts([{ text: "https://example.com/" + "a".repeat(3_500), atomic: true }], { mode: "plain", command: p => `show page ${p}` }), /atomic.*not split or dropped/);
});

test("invalid and tiny pagination budgets fail boundedly instead of clipping or looping", () => {
  for (const maxUnits of [0, -1, 31, 3_501, NaN, Infinity, 32.5]) {
    assert.throws(() => paginateParts([{ text: "x" }], { mode: "plain", maxUnits, command: () => "show" }), /reply budget/);
  }
  assert.throws(() => paginateParts([{ text: "x".repeat(200) }], { mode: "mrkdwn", title: "&".repeat(10), maxUnits: 32, command: () => "show" }), /no detail space/);
  assert.throws(() => paginateParts([{ text: "\ud800" }], { mode: "plain", command: () => "show" }), /Unicode/);
  assert.throws(() => paginateParts([{ text: "x".repeat(262_145) }], { mode: "plain", command: () => "show" }), /Too much detail/);
  assert.equal(paginateParts([], { mode: "plain", command: () => "show" }).length, 1);
});

test("serialized UTF-8 measurement rejects lossy/unsupported JSON and matches escaping exactly", () => {
  const value = { title: "界😀e\u0301\"\\\n\t", nil: null, nested: [true, 1.25] };
  assert.equal(serializedBytes(value), Buffer.byteLength(JSON.stringify(value)));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { assert.fail("getters must not execute"); } });
  for (const invalid of [undefined, NaN, Infinity, 1n, new Date(), new Map(), { missing: undefined }, { x: "\ud800" }, [undefined], new Array(3), cycle, getter, { toJSON() { assert.fail("toJSON must not execute"); } }]) {
    assert.throws(() => serializedBytes(invalid));
  }
  assert.equal(serializedBytes({ a: value, b: value }), Buffer.byteLength(JSON.stringify({ a: value, b: value })), "Repeated references without cycles are valid JSON");
});

type RecordValue = { id: string; text: string; revision: number; status: string };
type State = { version: 1; records: RecordValue[] };
const initial: State = { version: 1, records: [] };
const limits = { maxBytes: 500, contentBytes: 300, maxRecordBytes: 420, maxRecords: 2 };
const validate = (value: unknown): State => {
  assertStateVersion(value, 1);
  if (!Array.isArray(value.records) || value.records.some(record => !record || typeof record !== "object" || typeof record.id !== "string" || typeof record.text !== "string" || !Number.isSafeInteger(record.revision) || typeof record.status !== "string")) throw new Error("Malformed domain state");
  return value as State;
};
const feature: AgentFeature = {
  id: "kit-fixture", title: "Kit fixture", description: "Local tests", help: "Kit fixture help",
  async execute(command, context) {
    return context.store.update<State, string>("state", initial, raw => {
      const current = validate(raw);
      const record = { id: `item-${current.records.length + 1}`, text: command, revision: 1, status: "open" };
      const value = { ...current, records: [...current.records, record] };
      const future = { ...value, records: value.records.map(item => ({ ...item, revision: Number.MAX_SAFE_INTEGER, status: "completed", completion: "界".repeat(20) })) };
      assertQuota(value, { kind: "content", limits, records: value.records, future: { value: future, records: future.records } });
      return { value, result: record.id };
    });
  },
};

test("atomic content admission proves the supplied lifecycle projection, preserves prior state on failure", async () => {
  const fixture = createAgentFeatureFixture(feature);
  assert.equal(await fixture.run("界".repeat(50)), "item-1");
  const raw = fixture.backend.data.get(fixture.key("state"));
  assert.ok(raw);
  await assert.rejects(fixture.run("界".repeat(50)), /quota/);
  assert.equal(fixture.backend.data.get(fixture.key("state")), raw);
  const store = fixture.store();
  await store.update<State, void>("state", initial, current => {
    const value = { ...current, records: current.records.map(item => ({ ...item, status: "completed", revision: Number.MAX_SAFE_INTEGER, completion: "界".repeat(20) })) };
    assertQuota(value, { kind: "lifecycle", records: value.records, limits });
    return { value, result: undefined };
  });
  assert.ok(Buffer.byteLength(fixture.backend.data.get(fixture.key("state"))!) <= limits.maxBytes);
  assert.equal((await store.read<State>("state"))?.records[0].status, "completed");
  assert.deepEqual(fixture.calls, { generate: 0, search: 0, readContext: 0 });
});

test("quota checks include exact JSON boundary, per-record limits and dynamic reserve", () => {
  const value = { records: [{ text: "界😀\"\\\n" }] };
  const bytes = serializedBytes(value), recordBytes = serializedBytes(value.records[0]);
  const exact = { maxBytes: bytes, contentBytes: bytes, maxRecordBytes: recordBytes, maxRecords: 1 };
  assertQuota(value, { kind: "content", records: value.records, limits: exact, future: { value, records: value.records } });
  assert.throws(() => assertQuota(value, { kind: "lifecycle", records: value.records, limits: { ...exact, maxRecordBytes: recordBytes - 1 } }), /quota/);
  assert.throws(() => assertQuota(value, { kind: "content", records: value.records, limits: { ...exact, contentBytes: bytes - 1 }, future: { value, records: value.records } }), /quota/);
  const future = { records: [{ ...value.records[0], completion: "😀" }] };
  assert.throws(() => assertQuota(value, { kind: "content", records: value.records, limits: exact, future: { value: future, records: future.records } }), /quota/);
  assert.throws(() => assertQuota(value, { kind: "lifecycle", records: value.records, limits: { ...exact, maxRecords: 0 } }), /Record quota/);
  assert.throws(() => assertQuota(value, { kind: "lifecycle", records: value.records, limits: { maxBytes: 512_001 } }), /shared ceiling/);
});

test("malformed JSON, unsupported versions and domain-invalid state never reset through runtime", async () => {
  const fixture = createAgentFeatureFixture(feature);
  for (const raw of ["{broken", "null", '{"version":2,"records":[]}', '{"version":1,"records":"broken"}']) {
    fixture.backend.data.set(fixture.key("state"), raw);
    const before = { ...fixture.backend.calls };
    if (raw === "{broken" || raw === "null") {
      const reply = await fixture.run("new value");
      assert.match(reply, /could not be read safely/);
      assert.match(reply, /operator.*state-recovery\.md/);
      assert.doesNotMatch(reply, /No saved|\{broken|Next: .*list/);
      assert.equal(fixture.backend.calls.gets, before.gets + 1);
    } else await assert.rejects(fixture.run("new value"));
    assert.equal(fixture.backend.calls.compareSets, before.compareSets);
    assert.deepEqual(fixture.calls, { generate: 0, search: 0, readContext: 0 });
    assert.equal(fixture.backend.data.get(fixture.key("state")), raw);
    assert.equal(await fixture.run("help"), feature.help);
  }
  assert.throws(() => assertRevision(2, 1), /changed/);
  assert.throws(() => assertRevision(0, 0), /invalid revision/);
  assertRevision(2, 2);
});

test("fixture uses scoped real store, exact CAS and real byte ceilings", async () => {
  const fixture = createAgentFeatureFixture(feature);
  await fixture.run("private");
  assert.equal(await fixture.store({ teamId: "TOTHER", userId: "UFIXTURE" }).read("state"), null);
  assert.equal(await fixture.store({ teamId: "TFIXTURE", userId: "UOTHER" }).read("state"), null);
  await assert.rejects(() => fixture.store().update("oversized", "", () => ({ value: "界".repeat(171_000), result: true })), /storage is full/);
  assert.equal(fixture.backend.data.has(fixture.key("oversized")), false);
  await assert.rejects(() => fixture.services.readContext(["note"]), /Unexpected readContext/);
});

test("runtime retry keeps both edits and one logical generation; duplicate receipt does not replay", async () => {
  let injected = false;
  const backend = createMemoryAgentBackend({ beforeCompareSet(key, previous) {
    if (!key.endsWith(":state") || injected) return;
    injected = true;
    assert.equal(previous, null);
    backend.data.set(key, JSON.stringify({ values: ["other edit"] }));
  } });
  const generated: AgentFeature = { ...feature, async execute(_command, context) {
    const suggestion = await context.services.generate({ instructions: "Test", input: "Test" });
    return context.store.update("state", { values: [] as string[] }, current => ({ value: { values: [...current.values, suggestion] }, result: "saved" }));
  } };
  const fixture = createAgentFeatureFixture(generated, { backend, services: { generate: async () => "one suggestion" } });
  assert.equal(await fixture.run("draft", { requestId: "same-request" }), "saved");
  assert.match(await fixture.run("draft", { requestId: "same-request" }), /already received/);
  assert.deepEqual(await fixture.store().read("state"), { values: ["other edit", "one suggestion"] });
  assert.equal(fixture.calls.generate, 1);
  assert.equal(backend.calls.conflicts, 2, "one state conflict, one duplicate receipt");
});

test("real runtime cancels deferred service work without a late write", { timeout: 2_000 }, async () => {
  const started = deferred<void>(), result = deferred<string>();
  const generated: AgentFeature = { ...feature, async execute(_command, context) {
    const value = await context.services.generate({ instructions: "Test", input: "Test" });
    await context.store.update("state", "", () => ({ value, result: true }));
    return "saved";
  } };
  const fixture = createAgentFeatureFixture(generated, { services: { generate: async () => { started.resolve(); return result.promise; } } });
  const abort = new AbortController();
  const running = fixture.run("draft", { signal: abort.signal });
  await started.promise;
  abort.abort(new Error("fixture stop"));
  await assert.rejects(running, /fixture stop/);
  result.resolve("late output");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await fixture.store().read("state"), null);
  assert.equal(fixture.backend.calls.writes, 0);
});

const source: AgentContextItem = {
  id: "toolbox:goals:g1", kind: "goal", title: "A goal", text: "Measured progress", dueAt: "2026-10-22", status: "open",
  updatedAt: "2026-10-21T10:00:00-05:00", sourceUrl: "https://example.com/a%2Fb?a=1&a=2&b=%26#part",
  metadata: { current: 2, target: 10, history: [{ at: "2026-10-20", value: 2 }], coverage: "excerpt", titleTruncated: false, textTruncated: true, readAt: "2026-10-22T15:00:00Z" },
};
const evidenceOptions = { kinds: ["goal", "note"] as const, metadataKeys: ["current", "target", "history"] };

test("evidence canonicalizes selected keys/sources, preserving exact refs, civil dates and coverage", () => {
  const other = { id: "toolbox:notes:n1", kind: "note", title: "Note", text: "Note text" };
  const first = captureEvidence([source, other], evidenceOptions);
  const reordered = { ...source, metadata: { textTruncated: true, readAt: "2099-01-01T00:00:00Z", target: 10, titleTruncated: false, coverage: "excerpt", history: [{ value: 2, at: "2026-10-20" }], current: 2 } };
  assert.equal(captureEvidence([other, reordered], evidenceOptions).fingerprint, first.fingerprint);
  assert.match(first.fingerprint, /^e1:[a-f0-9]{64}$/);
  const saved = first.sources.find(item => item.id === source.id)!;
  assert.equal(saved.dueAt, "2026-10-22");
  assert.equal(saved.sourceUrl, source.sourceUrl);
  assert.equal(saved.updatedAt, "2026-10-21T15:00:00.000Z");
  assert.equal(saved.metadata?.textTruncated, true);
  assert.equal(saved.metadata?.coverage, "excerpt");
  assert.equal(saved.metadata?.readAt, undefined);
  (reordered.metadata.history[0]).value = 99;
  assert.deepEqual(saved.metadata?.history, [{ at: "2026-10-20", value: 2 }]);
});

test("fingerprints detect changed content/status/dates/URL/metadata and scope", () => {
  const baseline = captureEvidence([source], evidenceOptions).fingerprint;
  const changes = [
    { text: "Changed" }, { title: "Changed" }, { status: "completed" }, { dueAt: "2026-10-23" },
    { updatedAt: "2026-10-22T15:00:00Z" }, { sourceUrl: source.sourceUrl + "-new" },
    { metadata: { ...source.metadata, current: 3 } }, { metadata: { ...source.metadata, textTruncated: false } },
  ];
  for (const change of changes) assert.notEqual(captureEvidence([{ ...source, ...change }], evidenceOptions).fingerprint, baseline);
  assert.notEqual(captureEvidence([source], { ...evidenceOptions, kinds: ["goal"] }).fingerprint, baseline);
});

test("evidence rejects invalid, foreign, ambiguous, cyclic and oversized source shapes", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const bad = [
    { ...source, id: "a b" }, { ...source, kind: "event" }, { ...source, teamId: "TFOREIGN" }, { ...source, text: 42 },
    { ...source, dueAt: "2026-02-30" }, { ...source, updatedAt: "2026-10-22" },
    { ...source, sourceUrl: "https://user:pass@example.com/" }, { ...source, sourceUrl: "javascript:alert(1)" },
    { ...source, metadata: cycle }, { ...source, metadata: { current: NaN } },
    { ...source, metadata: { textTruncated: "yes" } }, { ...source, metadata: { current: undefined } },
  ];
  for (const value of bad) assert.throws(() => captureEvidence([value], evidenceOptions));
  assert.throws(() => captureEvidence([source, source], evidenceOptions), /Duplicate/);
  assert.throws(() => captureEvidence([source, { ...source, kind: "note" }], evidenceOptions), /ambiguous/);
  assert.throws(() => captureEvidence([source], { ...evidenceOptions, maxItems: 0 }), /bounds/);
  assert.throws(() => captureEvidence([source], { ...evidenceOptions, maxBytes: 64 }), /no sources were clipped/);
  assert.throws(() => captureEvidence([source], { ...evidenceOptions, metadataKeys: ["readAt"] }), /read time/);
});

test("civil arithmetic keeps Gregorian labels across leap days, century rules and DST dates", () => {
  for (const value of ["2024-02-29", "2000-02-29", "0000-02-29", "9999-12-31"]) assert.equal(civilDate(value), value);
  for (const value of ["2023-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-10-2", "2026-10-22T00:00Z"]) assert.throws(() => civilDate(value));
  assert.equal(addCivilDays("2024-02-28", 2), "2024-03-01");
  assert.equal(addCivilDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addCivilDays("2026-11-01", -1), "2026-10-31");
  assert.equal(civilDaysBetween("2026-03-07", "2026-03-09"), 2);
  assert.equal(civilDaysBetween("2026-03-09", "2026-03-07"), -2);
  assert.equal(compareCivilDates("2026-01-01", "2026-12-31"), -1);
  assert.throws(() => addCivilDays("9999-12-31", 1), /outside/);
  assert.throws(() => addCivilDays("0000-01-01", -1), /outside/);
});

test("offset instants normalize strictly; caller dates, point events and exclusive ends remain explicit", () => {
  assert.equal(normalizeInstant("2026-11-01T01:30-05:00"), "2026-11-01T06:30:00.000Z");
  assert.equal(normalizeInstant("2026-11-01T01:30-06:00"), "2026-11-01T07:30:00.000Z");
  for (const value of ["2026-11-01T01:30", "2026-02-30T10:00Z", "2026-10-22T24:00Z", "2026-10-22T10:00:60Z", "2026-10-22T10:00+14:30", "2026-10-22T10:00-00:00", "2026-10-22T10:00:00.0001Z"]) assert.throws(() => normalizeInstant(value));
  const now = new Date("2026-01-01T03:00:00Z");
  assert.equal(dateInZone(now, "America/Chicago"), "2025-12-31");
  assert.equal(dateInZone(now, "Asia/Tokyo"), "2026-01-01");
  assert.equal(dateInZone(new Date("0000-01-02T12:00:00Z"), "UTC"), "0000-01-02");
  assert.throws(() => dateInZone(now, "Unknown/Zone"), /valid IANA/);
  assert.throws(() => dateInZone(new Date(NaN), "UTC"));
  assert.deepEqual(civilRange("2026-03-08", "2026-03-09"), { start: "2026-03-08", endExclusive: "2026-03-09" });
  assert.throws(() => civilRange("2026-03-08", "2026-03-08"), /exclusive end/);
  assert.deepEqual(instantRange("2026-10-22T10:00-05:00", "2026-10-22T15:00Z"), { start: "2026-10-22T15:00:00.000Z", end: "2026-10-22T15:00:00.000Z", point: true });
  assert.equal(instantRange("2026-10-22T15:00Z").point, true);
  assert.equal(instantRange("2026-10-22T15:00Z", "2026-10-22T15:30Z").point, false);
  assert.throws(() => instantRange("2026-10-22T15:00Z", "2026-10-22T14:00Z"), /precede/);
});

test("production adapter evidence accepts absent optional fields through the real runtime", async () => {
  const { createAgentFeatureServices, createProductionContextAdapters } = await import("../lib/agent-features/services.js");
  const { runAgentFeature } = await import("../lib/agent-features/runtime.js");
  const backend = createMemoryAgentBackend();
  const owner = { teamId: "TEVIDENCE", userId: "UEVIDENCE", channelId: "CEVIDENCE" };
  const now = new Date("2026-10-22T15:00:00Z"), at = now.toISOString();
  for (const [tool, data] of [["notes", {}], ["goals", { current: 1, target: 2, due: "2026-10-23" }], ["bookmarks", { url: "https://example.com/a%2Fb?q=1&q=2#part" }]] as const) {
    backend.data.set(`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:${tool}`, JSON.stringify({ entries: [{ id: "one", title: "Atlas", body: "Launch details", createdAt: at, updatedAt: at, data }] }));
  }
  const indexes: Record<string, string[]> = {};
  for (const [kind, prefix, index, field] of [["follow-up", "follow-ups:record:", "follow-ups:user:", "task"], ["reminder", "schedules:job:", "schedules:user:", "task"], ["monitor", "monitors:job:", "monitors:user:", "query"], ["digest", "channel-digests:subscription:", "channel-digests:user:", "focus"]] as const) {
    indexes[index + owner.userId] = [kind];
    backend.data.set(prefix + kind, JSON.stringify({ id: kind, ownerUserId: owner.userId, createdByUserId: owner.userId, channel: owner.channelId, createdAt: at, [field]: "Atlas launch" }));
  }
  const adapters = createProductionContextAdapters({ redis: async () => ({ eval: async (_, options) => indexes[options.keys[0]] ?? [] }), evaluateAccess: async () => ({ allowed: true }) });
  const services = createAgentFeatureServices(backend, owner, new AbortController().signal, { now, timezone: "UTC" }, adapters);
  const kinds = ["note", "goal", "bookmark", "follow-up", "reminder", "monitor", "digest"] as const;
  const before = new Map(backend.data);
  const probe: AgentFeature = { ...feature, async execute(_, context) {
    const items = await context.services.readContext([...kinds]);
    const note = items.find(item => item.kind === "note")!;
    assert.ok(Object.hasOwn(note, "dueAt") && note.dueAt === undefined);
    const snapshot = captureEvidence(items, { kinds, metadataKeys: ["current", "target", "createdAt", "nextRunAt", "schedule", "monitorSource"] });
    assert.equal(snapshot.sources.length, 7);
    assert.equal(snapshot.fingerprint, captureEvidence(JSON.parse(JSON.stringify(items)), { kinds, metadataKeys: ["current", "target", "createdAt", "nextRunAt", "schedule", "monitorSource"] }).fingerprint);
    assert.equal(snapshot.sources.find(item => item.kind === "note")?.text, "Launch details\n{}");
    assert.equal(snapshot.sources.find(item => item.kind === "goal")?.dueAt, "2026-10-23");
    assert.equal(snapshot.sources.find(item => item.kind === "goal")?.status, "open");
    assert.equal(snapshot.sources.find(item => item.kind === "bookmark")?.sourceUrl, "https://example.com/a%2Fb?q=1&q=2#part");
    assert.equal(snapshot.sources.find(item => item.kind === "monitor")?.metadata?.coverage, "owner/current-channel");
    return context.store.update("evidence", null, () => ({ value: snapshot, result: snapshot.fingerprint }));
  } };
  assert.match(await runAgentFeature(probe, "capture", owner, { backend, services, now, timezone: "UTC" }), /^e1:/);
  for (const [key, raw] of before) assert.equal(backend.data.get(key), raw);
  assert.equal(backend.calls.writes, 1);
});

test("source optional projection never invokes accessors or hides malformed/unsupported values", () => {
  const absent = { ...source, updatedAt: undefined, dueAt: undefined, status: undefined, sourceUrl: undefined, metadata: undefined };
  assert.doesNotThrow(() => captureEvidence([absent], evidenceOptions));
  assert.throws(() => serializedBytes(absent), /lossless JSON/, "stored-state validation remains strict");
  for (const key of ["updatedAt", "dueAt", "status", "sourceUrl", "metadata"]) {
    const accessor = Object.defineProperty({ ...source }, key, { enumerable: true, get() { assert.fail("Optional getters must not execute"); } });
    assert.throws(() => captureEvidence([accessor], evidenceOptions), /properties/);
    for (const invalid of [NaN, Infinity, () => "value", 1n]) assert.throws(() => captureEvidence([{ ...source, [key]: invalid }], evidenceOptions));
  }
  const metadata = Object.defineProperty({}, "createdAt", { enumerable: true, get() { assert.fail("Metadata getters must not execute"); } });
  assert.throws(() => captureEvidence([{ ...source, metadata }], evidenceOptions), /properties/);
  assert.throws(() => captureEvidence([{ ...source, text: undefined }], evidenceOptions));
  assert.throws(() => captureEvidence([{ ...source, metadata: { current: undefined } }], evidenceOptions));
  assert.throws(() => captureEvidence([{ ...source, metadata: { createdAt: NaN } }], evidenceOptions));
});
