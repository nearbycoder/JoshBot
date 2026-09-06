import assert from "node:assert/strict";
import test from "node:test";
import { performWidgetAction, submitWidgetWorkflow, validateWidgetSubmission, type WidgetIO } from "../lib/slack-widget-workflows.js";
import { queueWidgetApproval } from "../lib/slack-approvals.js";
import { saveWidget, type WidgetRecord, type WidgetStore } from "../lib/slack-widgets.js";
import { getIssueDestinations } from "../lib/issue-drafts.js";

const target = { teamId: "T123", channelId: "C123", threadTs: "1.1", userId: "U123" };
function db() {
  const values = new Map<string, string>();
  const store: WidgetStore = { get: async (key) => values.get(key) ?? null, set: async (key, value, options) => {
    if (options.NX && values.has(key)) return null;
    values.set(key, value); return "OK";
  } };
  return { store, records: () => [...values.values()].filter((v) => v.startsWith("{")).map((v) => JSON.parse(v) as WidgetRecord) };
}
function ports() {
  const messages: string[] = [], posts: Array<{ channelId: string; text: string }> = [];
  const io: WidgetIO = { tell: async (s) => { messages.push(s); }, reply: async (s) => { messages.push(s); },
    privateCard: async (s) => { messages.push(s); }, open: async () => {},
    postElsewhere: async (channelId, text) => { posts.push({ channelId, text }); } };
  return { io, messages, posts };
}
async function answer(store: WidgetStore, extra: Partial<WidgetRecord> = {}) {
  return (await saveWidget({ target, kind: "research", title: "Research", text: "Overview", ...extra }, store))!;
}
const schedule = { id: "job1", ownerUserId: "U123", channel: "C123", task: "Check logs", kind: "daily" as const,
  createdAt: "2026-01-01T00:00:00.000Z", nextRunAt: "2099-01-01T15:00:00.000Z", timezone: "America/Chicago", summary: "Daily check" };

test("Post form only stages approval; approval sends exact payload once", async () => {
  const { store, records } = db(), { io, posts } = ports();
  const record = await answer(store);
  let accessChecks = 0;
  const deps = { store, assertSlackTargetChannelAllowed: async () => { accessChecks++; } };
  const text = "Reviewed <!channel> text";
  await submitWidgetWorkflow(record, { action: "share", text, channelId: "CDEST" }, io, deps);
  assert.equal(posts.length, 0);
  const approval = records().find((r) => r.kind === "approval")!;
  assert.match(approval.text, /&lt;!channel&gt;/);
  await Promise.all([performWidgetAction(approval, "approve", io, deps), performWidgetAction(approval, "approve", io, deps)]);
  assert.deepEqual(posts, [{ channelId: "CDEST", text }]);
  assert.equal(accessChecks, 2);
});
test("Reject shares its single-use decision with approve and fails closed without storage", async () => {
  const { store } = db(), { io, posts } = ports();
  const record = await answer(store, { kind: "approval", approval: { type: "post", channelId: "CDEST", text: "No" } });
  await performWidgetAction(record, "reject", io, { store });
  await performWidgetAction(record, "approve", io, { store });
  assert.equal(posts.length, 0);
  await assert.rejects(queueWidgetApproval(target, record.approval!, "Review", "No", { store: null, publish: async () => assert.fail("must not publish") }), /storage is unavailable/);
});
test("An ambiguous post failure remains claimed and is not resent", async () => {
  const { store } = db(), { io } = ports();
  const record = await answer(store, { kind: "approval", approval: { type: "post", channelId: "CDEST", text: "Exact" } });
  let calls = 0;
  io.postElsewhere = async () => { calls++; throw new Error("network disconnected"); };
  const deps = { store, assertSlackTargetChannelAllowed: async () => {} };
  await assert.rejects(performWidgetAction(record, "approve", io, deps), /disconnected/);
  await performWidgetAction(record, "approve", io, deps);
  assert.equal(calls, 1);
});
test("Issue forms show drafts and never create until approved; changed destinations block", async () => {
  const { store, records } = db(), { io } = ports();
  const record = await answer(store);
  let creates = 0;
  const deps = { store, handleIssueDrafts: async (...args: Parameters<typeof import("../lib/issue-drafts.js").handleIssueDrafts>) => {
    creates++; assert.equal(args[1]?.approved, true); assert.equal(args[0].length, 2); return "Created";
  } };
  await submitWidgetWorkflow(record, { action: "issues", target: "github", text: "Fix tests\nUpdate docs" }, io, deps);
  assert.equal(creates, 0);
  const approval = records().find((r) => r.kind === "approval")!;
  assert.match(approval.text, /Fix tests[\s\S]*Update docs/);
  await performWidgetAction(approval, "approve", io, deps);
  assert.equal(creates, 1);
  const changed = await answer(store, { kind: "approval", approval: { type: "issues", targets: ["github"], tasks: [],
    destinations: { ...getIssueDestinations(["github"]), github: "changed/repo" } } });
  await assert.rejects(performWidgetAction(changed, "approve", io, deps), /destination changed/);
  assert.equal(creates, 1);
});
test("Schedule approval preserves reviewed first run, owner and idempotency source", async () => {
  const { store } = db(), { io, messages } = ports();
  const record = await answer(store, { kind: "approval", approval: { type: "schedule", firstRunAt: schedule.nextRunAt,
    context: { ownerUserId: "U123", channel: "C123", threadTs: "1.1", sourceTs: "old", mentionedChannels: [], timeZone: schedule.timezone },
    schedule: { kind: "once", amount: 5, unit: "minutes", task: "Check logs" } } });
  let creates = 0;
  await performWidgetAction(record, "approve", io, { store,
    createScheduleFromTool: async (context, input, approved) => {
      creates++; assert.equal(context.sourceTs, "approval:" + record.id); assert.equal(context.ownerUserId, "U123");
      assert.equal(approved?.firstRunAt, schedule.nextRunAt); assert.equal(input.task, "Check logs");
      return { id: "job1", nextRunAt: schedule.nextRunAt, summary: schedule.summary };
    }, getOwnedSchedule: async (id, owner) => { assert.equal(id, "job1"); assert.equal(owner, "U123"); return schedule; }
  });
  assert.equal(creates, 1); assert.match(messages.join(" "), /Daily check/);
});
test("Reminder actions recheck ownership and policies, and edits validate before writes", async () => {
  const { store } = db(), { io } = ports();
  const record = await answer(store, { kind: "reminder", schedule: { id: "job1", summary: "Daily", nextRunAt: schedule.nextRunAt,
    timeZone: schedule.timezone, channelId: schedule.channel } });
  let writes = 0;
  await assert.rejects(performWidgetAction(record, "cancel_reminder", io, { store,
    getOwnedSchedule: async () => { throw new Error("not owned"); }, cancelScheduleById: async () => { writes++; }
  }), /not owned/);
  await assert.rejects(performWidgetAction(record, "cancel_reminder", io, { store,
    getOwnedSchedule: async () => schedule, assertSlackTargetChannelAllowed: async () => { throw new Error("denied"); },
    cancelScheduleById: async () => { writes++; }
  }), /denied/);
  await assert.rejects(submitWidgetWorkflow(record, { action: "edit_reminder", text: "New", when: 1 }, io, {
    store, editOwnedSchedule: async () => { writes++; return schedule; }
  }), /Invalid form/);
  assert.equal(writes, 0);
  await submitWidgetWorkflow(record, { action: "edit_reminder", text: "New", when: 4070908800 }, io, {
    store, editOwnedSchedule: async (id, owner, text, at) => {
      writes++; assert.equal(id, "job1"); assert.equal(owner, "U123"); assert.equal(text, "New");
      assert.equal(at, new Date(4070908800000).toISOString()); return { ...schedule, task: text };
    }
  });
  assert.equal(writes, 1);
});
test("Guided revisions reject missing, oversized, empty or concurrently changed artifacts", async () => {
  const { store } = db(), { io } = ports();
  const artifact = { id: "art1", title: "Note", kind: "markdown" as const, filename: "note.md", previewUrl: "https://example.com/note",
    rawUrl: "https://example.com/raw", path: "/test/note.md", createdAt: "2026-01-01T00:00:00.000Z", bytes: 4, shortId: "art1", expired: false };
  for (const mode of ["missing", "large", "empty", "changed", "ok"]) {
    const record = await answer(store, { kind: "artifact", artifact: { id: "art1", title: "Note", url: artifact.previewUrl } });
    let reads = 0, writes = 0, lookups = 0;
    const work = submitWidgetWorkflow(record, { action: "revise", text: "Make it clearer" }, io, { store,
      findArtifact: async (_id, options) => {
        assert.equal(options?.ownerUserId, "U123"); lookups++;
        return mode === "missing" ? { status: "missing" } : { status: "found", artifact: { ...artifact,
          bytes: mode === "large" ? 25000 : 4, updatedAt: mode === "changed" && lookups > 1 ? "new" : undefined } };
      }, readFile: (async () => { reads++; return "Note"; }) as unknown as typeof import("node:fs/promises").readFile,
      createWidgetRevision: async (text, instruction, owner, kind) => {
        assert.equal(text, "Note"); assert.equal(owner, "U123"); assert.equal(kind, "markdown");
        return mode === "empty" ? " " : "```md\nRevised\n```";
      }, updateArtifact: async (input) => {
        writes++; assert.equal(input.expectedRevision, artifact.createdAt); assert.equal(input.content, "Revised");
        return { ok: true, artifact };
      }
    });
    if (mode === "ok") { await work; assert.equal(writes, 1); }
    else { await assert.rejects(work); assert.equal(writes, 0); }
    if (["missing", "large"].includes(mode)) assert.equal(reads, 0);
  }
});
test("Modal validation constrains destinations, task count and future times", () => {
  assert.ok(validateWidgetSubmission({ action: "share", text: "hi", channelId: "https://bad" }).channel);
  assert.ok(validateWidgetSubmission({ action: "issues", text: "a\nb\nc\nd\ne\nf", target: "github" }).text);
  assert.ok(validateWidgetSubmission({ action: "edit_reminder", text: "hi", when: Number.NaN }).when);
  assert.deepEqual(validateWidgetSubmission({ action: "revise", text: "Make shorter" }), {});
});
