import assert from "node:assert/strict";
import test from "node:test";
import { readAgentOwnedContext, readAgentToolboxContext, type AgentContextAdapters, type AgentContextRequest } from "../lib/agent-features/context.js";
import { LEGACY_INDEX_LIMIT, LEGACY_SOURCES, type LegacyContextKind } from "../lib/agent-features/context/legacy.js";
import { createAgentFeatureServices, createProductionContextAdapters } from "../lib/agent-features/services.js";
import { createAgentFeatureStore, type AgentStateBackend } from "../lib/agent-features/store.js";
import type { AgentContextKind, AgentFeatureContext } from "../lib/agent-features/types.js";
import { eventId, type CalendarEvent } from "../lib/agent-features/calendar/ics.js";
import { feature as memoryReview } from "../lib/agent-features/memory-review.js";
import { feature as meetingPrep } from "../lib/agent-features/meeting-prep.js";
import { feature as dayPlanner } from "../lib/agent-features/day-planner.js";
import { feature as weeklyReview } from "../lib/agent-features/weekly-review.js";
import { goals } from "../lib/toolbox/goals.js";
import { runFeature } from "../lib/toolbox/core.js";

const NOW = "2026-10-22T15:00:00.000Z";
const owner = { teamId: "TCONTEXT", userId: "UCONTEXT", channelId: "CCONTEXT" };
const request: AgentContextRequest = { now: new Date(NOW), timezone: "America/Chicago" };
const sourceKey = (feature: string, key: string, who = owner) => `nobo:agents:v1:${who.teamId}:${who.userId}:${feature}:${key}`;
const toolboxKey = (tool: string, who = owner) => `nobo:toolbox:v1:${who.teamId}:${who.userId}:${tool}`;
const entry = (id: string, data: Record<string, unknown> = {}) => ({ id, title: `Atlas ${id}`, body: "Atlas source text", createdAt: NOW, updatedAt: NOW, data });
const timed = (uid: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: eventId(uid), uid, title: `Atlas ${uid}`, location: "Desk", busy: true, updatedAt: NOW,
  allDay: false, startAt: "2026-10-23T14:00:00.000Z", endAt: "2026-10-23T15:00:00.000Z", timezone: "UTC", ...overrides,
} as CalendarEvent);

function fixture() {
  const data = new Map<string, string>(), indexes = new Map<string, string[]>();
  const reads: string[] = [], indexReads: string[] = [], policies: unknown[] = [];
  let writes = 0;
  const backend: AgentStateBackend = {
    get: async key => { reads.push(key); return data.get(key) ?? null; },
    compareSet: async (key, previous, next) => {
      writes++;
      if ((data.get(key) ?? null) !== previous) return false;
      data.set(key, next); return true;
    },
  };
  const adapters: AgentContextAdapters = {
    readOwnerIndex: async (key, limit) => { assert.equal(limit, LEGACY_INDEX_LIMIT); indexReads.push(key); return [...indexes.get(key) ?? []]; },
    authorizeChannel: async who => { policies.push(who); },
  };
  const read = (kinds?: AgentContextKind[], options: Partial<AgentContextRequest> = {}, who = owner) => readAgentOwnedContext(backend, who, { ...request, ...options }, adapters, kinds);
  const put = (key: string, value: unknown) => data.set(key, JSON.stringify(value));
  const legacy = (kind: LegacyContextKind, id: string, extra: Record<string, unknown> = {}) => {
    const keys = LEGACY_SOURCES[kind], index = `${keys.index}${owner.userId}`;
    indexes.set(index, [...indexes.get(index) ?? [], id]);
    put(`${keys.record}${id}`, { id, ownerUserId: owner.userId, createdByUserId: owner.userId, channel: owner.channelId, createdAt: NOW,
      task: "Atlas follow through", query: "Atlas launch", focus: "Atlas decisions", kind: "daily", frequency: "daily",
      hour: 9, minute: 15, timezone: "America/Chicago", nextRunAt: "2026-10-23T14:15:00.000Z", ...extra });
  };
  const calendar = (events: CalendarEvent[]) => put(sourceKey("calendar", "calendar-v1"), { version: 1, revision: 1, events, pending: null });
  const context = (feature: string): AgentFeatureContext => ({ ...owner, ...request,
    store: createAgentFeatureStore(backend, owner, feature),
    services: { readContext: kinds => read(kinds, { featureId: feature }), generate: async () => { throw new Error("No model"); }, search: async () => { throw new Error("No web"); } },
  });
  return { data, indexes, reads, indexReads, policies, backend, adapters, read, put, legacy, calendar, context, writes: () => writes };
}

async function approvedMemory(f: ReturnType<typeof fixture>) {
  const ctx = f.context("memory-review");
  const reply = await memoryReview.execute("capture me | project | Atlas launch needs a checklist | My notes", ctx);
  const id = reply.match(/mr_[0-9a-f-]{36}/)?.[0]; assert.ok(id, reply);
  await memoryReview.execute(`confirm ${id} 1`, ctx);
  return id;
}

test("real scoped source mappings include review history, completion times and honest automation metadata", async () => {
  const f = fixture();
  f.put(toolboxKey("notes"), { entries: [entry("note")] });
  const history = [{ at: "2026-10-21T11:00:00-05:00", value: 3, note: "Read a book" }];
  f.put(toolboxKey("goals"), { entries: [entry("goal", { target: 10, current: 3, due: "2026-10-25", history })] });
  f.put(toolboxKey("habits"), { entries: [entry("habit", { target: 5, days: ["2026-10-20", "2026-10-20", "2026-10-21"] })] });
  f.put(toolboxKey("journal"), { entries: [entry("journal", { day: "2026-10-21", mood: 4, wins: "Shipped Atlas", lesson: "Start small" })] });
  f.put(toolboxKey("bookmarks"), { entries: [entry("bookmark", { url: "https://example.com/atlas" })] });
  f.legacy("follow-up", "open", { status: "open", dueAt: "2026-10-23T09:00:00-05:00" });
  f.legacy("follow-up", "done", { status: "done", completedAt: "2026-10-22T16:00:00Z" });
  f.legacy("reminder", "reminder", { kind: "weekly", weekday: 5 });
  f.legacy("monitor", "monitor", { kind: "interval", intervalMs: 3_600_000, lastCheckedAt: NOW,
    lastObservation: "DO NOT EXPOSE OBSERVATIONS", lastAlertFingerprint: "DO NOT EXPOSE FINGERPRINTS" });
  f.legacy("digest", "digest");
  f.calendar([timed("meeting")]);
  const card = await approvedMemory(f);
  const before = f.writes();
  const items = await f.read();
  assert.equal(items.length, 12);
  const byId = new Map(items.map(item => [item.id, item]));
  const goal = byId.get("toolbox:goals:goal")!;
  assert.equal(goal.status, "open"); assert.equal(goal.dueAt, "2026-10-25");
  assert.deepEqual(goal.metadata?.history, [{ ...history[0], at: "2026-10-21T16:00:00.000Z" }]);
  assert.equal(goal.metadata?.completedAt, undefined);
  assert.deepEqual(byId.get("toolbox:habits:habit")?.metadata?.days, ["2026-10-20", "2026-10-21"]);
  assert.equal(byId.get("toolbox:journal:journal")?.metadata?.lesson, "Start small");
  assert.equal(byId.get("toolbox:journal:journal")?.metadata?.mood, 4);
  assert.equal(byId.get("toolbox:bookmarks:bookmark")?.sourceUrl, "https://example.com/atlas");
  assert.equal(byId.get("follow-up:done")?.metadata?.completedAt, "2026-10-22T16:00:00.000Z");
  assert.equal(byId.get("follow-up:done")?.updatedAt, "2026-10-22T16:00:00.000Z");
  assert.equal(byId.get("follow-up:done")?.status, "completed");
  assert.equal(byId.get("follow-up:open")?.dueAt, "2026-10-23T14:00:00.000Z");
  assert.equal(byId.get("reminder:reminder")?.metadata?.schedule, "weekly Friday 09:15");
  assert.equal(byId.get("reminder:reminder")?.metadata?.destination, "current channel CCONTEXT");
  assert.equal(byId.get("reminder:reminder")?.metadata?.nextRunAt, "2026-10-23T14:15:00.000Z");
  assert.equal(byId.get("reminder:reminder")?.updatedAt, undefined);
  assert.equal(byId.get("reminder:reminder")?.metadata?.lastRunAt, undefined);
  assert.equal(byId.get("monitor:monitor")?.metadata?.lastRunAt, NOW);
  assert.equal(byId.get("monitor:monitor")?.metadata?.lastRunStatus, undefined);
  assert.equal(byId.get("monitor:monitor")?.metadata?.schedule, "every 3600000 ms");
  assert.equal(byId.get("digest:digest")?.metadata?.schedule, "daily 09:15");
  assert.equal(byId.get(`memory-review:${card}`)?.status, "user-confirmed");
  assert.ok(!JSON.stringify(items).includes("DO NOT EXPOSE"));
  assert.equal(f.writes(), before, "context reads cannot write or migrate sources");
  const review = await weeklyReview.execute("review 2026-10-22", f.context("weekly-review"));
  assert.match(review, /follow-up:done/); assert.match(review, /Shipped Atlas/);
});

test("toolbox command goals flow to meeting commitments as open/done without invented completion dates", async () => {
  const f = fixture();
  for (const title of ["Atlas pending", "Atlas finished"]) {
    await runFeature(goals, `create ${title} | 10 | tasks | 2026-10-30`, owner, undefined, f.backend, request.now);
  }
  const saved = JSON.parse(f.data.get(toolboxKey("goals"))!);
  const finished = saved.entries.find((item: { title: string }) => item.title === "Atlas finished");
  await runFeature(goals, `progress ${finished.id} | 10 | Finished delivery`, owner, undefined, f.backend, request.now);
  const items = await f.read(["goal"]);
  assert.equal(items.find(item => item.title === "Atlas pending")?.status, "open");
  assert.equal(items.find(item => item.title === "Atlas finished")?.status, "done");
  assert.ok(items.every(item => item.metadata?.completedAt === undefined));
  const reply = await meetingPrep.execute("prepare Atlas planning | purpose: Review Atlas tasks", f.context("meeting-prep"));
  const commitments = reply.split("Open commitments — source-reported")[1].split("Proposed agenda")[0];
  assert.match(commitments, /Atlas pending/); assert.doesNotMatch(commitments, /Atlas finished|Verify status/);
});

test("requested kinds cause only relevant reads; empty kind list performs no IO", async () => {
  const f = fixture();
  f.put(toolboxKey("notes"), { entries: [entry("note")] });
  assert.deepEqual(await f.read([]), []); assert.deepEqual(f.reads, []);
  assert.deepEqual(f.indexReads, []); assert.deepEqual(f.policies, []);
  const items = await f.read(["note", "note"]);
  assert.deepEqual(items.map(item => item.kind), ["note"]);
  assert.deepEqual(f.reads, [toolboxKey("notes")]);
  assert.deepEqual(f.indexReads, []);
  f.reads.length = 0;
  assert.deepEqual(await f.read(["artifact"]), []); assert.deepEqual(f.reads, []);
});

test("workspace/user scoped notes, imported calendars and approved cards never cross owners", async () => {
  const f = fixture(); f.put(toolboxKey("notes"), { entries: [entry("note")] });
  f.calendar([timed("private")]); await approvedMemory(f);
  for (const who of [{ ...owner, teamId: "TOTHER" }, { ...owner, userId: "UOTHER" }]) {
    assert.deepEqual(await f.read(["note", "event", "memory"], {}, who), []);
  }
  f.put(toolboxKey("notes"), { entries: [{ ...entry("mismatch"), teamId: "TOTHER" }] });
  assert.deepEqual(await f.read(["note"]), []);
  await assert.rejects(() => f.read(["note"], {}, { ...owner, teamId: "../OTHER" }), /signed Slack/);
});

test("legacy records require owner AND signed current channel, reject contradictory team IDs and enforce access", async () => {
  const f = fixture();
  for (const kind of Object.keys(LEGACY_SOURCES) as LegacyContextKind[]) {
    f.legacy(kind, `${kind}-yes`);
    f.legacy(kind, `${kind}-other-channel`, { channel: "COTHER" });
    f.legacy(kind, `${kind}-other-owner`, { ownerUserId: "UOTHER", createdByUserId: "UOTHER" });
    f.legacy(kind, `${kind}-other-team`, { teamId: "TOTHER" });
    f.legacy(kind, `${kind}-null-team`, { teamId: null });
    f.legacy(kind, `${kind}-missing-channel`, { channel: undefined });
  }
  f.legacy("follow-up", "assigned", { createdByUserId: "UOTHER", assigneeUserId: owner.userId });
  const kinds = Object.keys(LEGACY_SOURCES) as LegacyContextKind[];
  assert.equal((await f.read(kinds)).length, 5);
  assert.equal(f.policies.length, 1);
  const noChannel = { teamId: owner.teamId, userId: owner.userId };
  const indexCount = f.indexReads.length;
  assert.deepEqual(await readAgentOwnedContext(f.backend, noChannel, request, f.adapters, kinds), []);
  assert.equal(f.indexReads.length, indexCount);
  f.adapters.authorizeChannel = async () => { throw new Error("Denied"); };
  await assert.rejects(() => f.read(kinds), /could not be read completely/);
  assert.equal(f.indexReads.length, indexCount, "policy failure must precede index access");
});

test("fresh reads retain stable IDs after edits and drop deleted records without index mutation", async () => {
  const f = fixture(); f.legacy("reminder", "job");
  f.put(toolboxKey("notes"), { entries: [entry("note")] });
  const first = await f.read(["reminder", "note"]);
  f.legacy("reminder", "changed", { nextRunAt: "2026-10-22T12:00:00Z" });
  f.put(toolboxKey("notes"), { entries: [{ ...entry("note"), body: "Changed content", updatedAt: "2026-10-22T16:00:00Z" }] });
  const next = await f.read(["note", "reminder"]);
  assert.equal(next.find(item => item.kind === "note")?.id, first.find(item => item.kind === "note")?.id);
  assert.match(next.find(item => item.kind === "note")!.text, /Changed content/);
  assert.equal(next[0].id, "reminder:changed");
  f.data.delete("schedules:job:job"); f.data.delete(toolboxKey("notes"));
  assert.deepEqual((await f.read(["note", "reminder"])).map(item => item.id), ["reminder:changed"]);
  assert.equal(f.writes(), 0);
});

test("legacy indexes and source ordering are deterministic and do not truncate oversized sources", async () => {
  const f = fixture();
  f.legacy("reminder", "z", { nextRunAt: "2026-10-23T20:00:00Z" });
  f.legacy("reminder", "a"); f.legacy("monitor", "b");
  const first = await f.read(["monitor", "reminder"]);
  for (const ids of f.indexes.values()) ids.reverse();
  assert.deepEqual(await f.read(["reminder", "monitor"]), first);
  f.indexes.set(`schedules:user:${owner.userId}`, Array.from({ length: 201 }, (_, i) => `job-${i}`));
  await assert.rejects(() => f.read(["reminder"]), /could not be read completely/);
  f.put(toolboxKey("notes"), { entries: Array.from({ length: 101 }, (_, i) => entry(`note-${i}`)) });
  await assert.rejects(() => f.read(["note"]), /could not be read completely/);
});

test("malformed dates, source IDs, duplicates, numeric goals and provider failures cannot masquerade as no data", async () => {
  for (const data of [{ current: "10", target: 10 }, { current: -1, target: 10 }, { due: "2026-02-30" }, { history: [{ at: "yesterday", value: 1 }] }]) {
    const f = fixture(); f.put(toolboxKey("goals"), { entries: [entry("bad", data)] });
    await assert.rejects(() => f.read(["goal"]), /could not be read completely/);
  }
  const f = fixture(); f.put(toolboxKey("notes"), { entries: [entry("same"), entry("same")] });
  await assert.rejects(() => f.read(["note"]), /could not be read completely/);
  f.legacy("reminder", "date", { nextRunAt: "2026-02-30T12:00:00Z" });
  await assert.rejects(() => f.read(["reminder"]), /could not be read completely/);
  f.indexes.set(`schedules:user:${owner.userId}`, ["../secret"]);
  f.reads.length = 0;
  await assert.rejects(() => f.read(["reminder"]), /could not be read completely/); assert.deepEqual(f.reads, []);
  f.indexes.set(`schedules:user:${owner.userId}`, ["date"]);
  f.put("schedules:job:date", { id: "other-id", ownerUserId: owner.userId, channel: owner.channelId });
  await assert.rejects(() => f.read(["reminder"]), /could not be read completely/);
  f.adapters.readOwnerIndex = async () => { throw new Error("Private provider error"); };
  await assert.rejects(() => f.read(["digest"]), error => error instanceof Error && !error.message.includes("Private") && error.cause instanceof Error);
  f.data.set(sourceKey("calendar", "calendar-v1"), "invalid json");
  await assert.rejects(() => f.read(["event"]), /calendar.*could not be read completely/);
  f.put(sourceKey("memory-review", "cards"), { version: 999 });
  await assert.rejects(() => f.read(["memory"]), /approved memory.*could not be read completely/);
});

test("calendar preserves UTC exclusive ranges, all-day DST duration, free and instantaneous events", async () => {
  const f = fixture();
  const allDay: CalendarEvent = { id: eventId("all-day"), uid: "all-day", title: "All day", location: "", busy: true, updatedAt: NOW,
    allDay: true, startDate: "2026-11-01", endDate: "2026-11-02" };
  f.calendar([timed("free", { busy: false }), allDay, timed("instant", { endAt: "2026-10-23T14:00:00.000Z" })]);
  const items = await f.read(["event"]);
  const day = items.find(item => item.id === `calendar:${eventId("all-day")}`)!;
  assert.equal(day.metadata?.startAt, "2026-11-01T05:00:00.000Z");
  assert.equal(day.metadata?.endAt, "2026-11-02T06:00:00.000Z");
  assert.equal(day.metadata?.allDay, true); assert.equal(day.metadata?.busy, true);
  assert.equal(day.metadata?.endDate, "2026-11-02");
  const free = items.find(item => item.id === `calendar:${eventId("free")}`)!;
  assert.equal(free.status, "free"); assert.equal(free.metadata?.busy, false);
  const instant = items.find(item => item.id === `calendar:${eventId("instant")}`)!;
  assert.equal(instant.metadata?.startAt, instant.metadata?.endAt);
  assert.equal(instant.metadata?.busy, true, "source semantics are preserved for consumer handling");
  f.calendar(Array.from({ length: 101 }, (_, i) => timed(`over-${i}`)));
  await assert.rejects(() => f.read(["event"]), /could not be read completely/);
});

test("planner receives all 100 imported events and cannot schedule over the final busy interval", async () => {
  const f = fixture();
  f.calendar([...Array.from({ length: 99 }, (_, i) => timed(`old-${i}`, { startAt: "2026-10-20T14:00:00.000Z", endAt: "2026-10-20T15:00:00.000Z" })),
    timed("full-day", { endAt: "2026-10-23T22:00:00.000Z" })]);
  assert.equal((await f.read(["event"])).length, 100);
  const ctx = f.context("day-planner");
  await dayPlanner.execute("add Draft proposal | 60 | high", ctx);
  const reply = await dayPlanner.execute("plan 2026-10-23", ctx);
  assert.match(reply, /Scheduled: 0\/1 tasks/);
  const plan = await ctx.store.read<{ plan: { blocks: Array<{ kind: string }> } }>("state");
  assert.ok(plan); assert.ok(plan.plan.blocks.every(block => block.kind === "unavailable"));
  f.calendar([{ id: eventId("all-day"), uid: "all-day", title: "All day off", location: "", busy: true, updatedAt: NOW,
    allDay: true, startDate: "2026-11-01", endDate: "2026-11-02" }]);
  assert.match(await dayPlanner.execute("plan 2026-11-01", ctx), /Scheduled: 0\/1 tasks/);
});

test("automation unknown telemetry and malformed schedules never become invented facts", async () => {
  const f = fixture();
  f.legacy("reminder", "once", { kind: "once", status: "enabled" });
  f.legacy("reminder", "cancelled", { status: "canceled" });
  f.legacy("monitor", "unknown", { status: "error", kind: "mystery", timezone: undefined, nextRunAt: undefined, lastCheckedAt: undefined });
  f.legacy("digest", "generic", { focus: "" });
  const items = await f.read(["reminder", "monitor", "digest"]);
  assert.equal(items.find(item => item.id === "reminder:once")?.metadata?.schedule, "once");
  assert.equal(items.find(item => item.id === "reminder:once")?.status, "active");
  assert.equal(items.find(item => item.id === "reminder:cancelled")?.status, "cancelled");
  const unknown = items.find(item => item.id === "monitor:unknown")!;
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.dueAt, undefined);
  for (const key of ["schedule", "timezone", "nextRunAt", "lastRunAt", "lastRunStatus", "cadence"]) assert.equal(unknown.metadata?.[key], undefined);
  assert.equal(items.find(item => item.id === "digest:generic")?.title, "Channel digest");
});

test("approved memory is reread after changes and expiry; memory import never feeds back approved cards", async () => {
  const f = fixture(); const id = await approvedMemory(f);
  assert.equal((await f.read(["memory"])).length, 1);
  f.reads.length = 0;
  assert.deepEqual(await f.read(["memory"], { featureId: "memory-review" }), []);
  assert.deepEqual(f.reads, []);
  // Legacy global personal memory and shared channel memory are never read.
  f.put(`slack-memory:user:${owner.userId}`, { memories: ["Unscoped secret"] });
  assert.deepEqual(await f.read(["memory"], { now: new Date("2027-05-01T00:00:00Z") }), []);
  await memoryReview.execute(`correct ${id} 2 | Changed fact | New source`, f.context("memory-review"));
  assert.deepEqual(await f.read(["memory"]), [], "correction needs a fresh confirmation");
  await memoryReview.execute(`confirm ${id} 3`, f.context("memory-review"));
  assert.equal((await f.read(["memory"]))[0].text, "Changed fact");
  await memoryReview.execute(`forget ${id} 4 confirm`, f.context("memory-review"));
  assert.deepEqual(await f.read(["memory"]), []);
  assert.ok(f.reads.every((key: string) => key.startsWith("nobo:agents:")));
});

test("injected calendar/memory readers receive correct read-only namespaces, request clock and timezone", async () => {
  const f = fixture();
  f.adapters.readCalendar = async (store, timezone) => {
    assert.equal(timezone, request.timezone); await store.read("calendar-v1");
    await assert.rejects(() => store.update("state", {}, value => ({ value, result: null })), /read-only/);
    return [];
  };
  f.adapters.readApprovedMemory = async context => {
    assert.equal(context.now, request.now); assert.equal(context.timezone, request.timezone);
    await context.store.read("cards"); return [];
  };
  await f.read(["event", "memory"]);
  assert.deepEqual(f.reads, [sourceKey("calendar", "calendar-v1"), sourceKey("memory-review", "cards")]);
  assert.equal(f.writes(), 0);
});

test("active cancellation stops a pending source read and prevents subsequent source work", async () => {
  const f = fixture(), controller = new AbortController();
  let release!: (value: string | null) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.backend.get = async key => { f.reads.push(key); entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.read(undefined, { signal: controller.signal });
  await started;
  const reason = new Error("Stop source reads"); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  release(null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads.length, 1); assert.equal(f.indexReads.length, 0); assert.equal(f.writes(), 0);
  await assert.rejects(() => f.read([], { signal: controller.signal }), error => error === reason);
  assert.equal(f.reads.length, 1);
});

test("production services use injected source IO and bounded read-only Redis index commands", async () => {
  const f = fixture(); f.legacy("reminder", "live");
  const operations: string[] = [];
  const adapters = createProductionContextAdapters({
    redis: async () => ({ eval: async (script, options) => {
      assert.match(script, /SCARD/); assert.match(script, /SMEMBERS/);
      assert.doesNotMatch(script, /\b(?:SET|DEL|SCAN|KEYS)\s*['"]\s*[,)]/);
      assert.deepEqual(options.arguments, ["200"]);
      operations.push(...options.keys); return ["live"];
    } }),
    evaluateAccess: async subject => { assert.equal(subject.teamId, owner.teamId); assert.equal(subject.channelId, owner.channelId); return { allowed: true }; },
  });
  const services = createAgentFeatureServices(f.backend, owner, new AbortController().signal, request, adapters);
  assert.equal((await services.readContext(["reminder"]))[0].id, "reminder:live");
  assert.deepEqual(operations, [`schedules:user:${owner.userId}`]);
  const unavailable = createProductionContextAdapters({ redis: async () => null });
  await assert.rejects(() => unavailable.readOwnerIndex(`schedules:user:${owner.userId}`, 200), /Redis connection/);
  const oversized = createProductionContextAdapters({ redis: async () => ({ eval: async () => null }) });
  await assert.rejects(() => oversized.readOwnerIndex(`schedules:user:${owner.userId}`, 200), /complete-read limit/);
  const denied = createProductionContextAdapters({ evaluateAccess: async () => ({ allowed: false }) });
  await assert.rejects(() => denied.authorizeChannel(owner), /denied/);
});
