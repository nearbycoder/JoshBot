import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { __testing, cancelScheduleById, editOwnedSchedule, previewScheduleFromTool, updateScheduleFromTool } from "../lib/schedules.js";
import type { getRedisClient } from "../lib/redis.js";

const original = { id: "job1", ownerUserId: "U123", channel: "C123", task: "Old", kind: "daily" as const,
  createdAt: "2026-01-01T00:00:00.000Z", nextRunAt: "2099-01-01T15:00:00.000Z", timezone: "America/Chicago", hour: 9, minute: 0 };
const context = { ownerUserId: "U123", channel: "C123", threadTs: "1.1", sourceTs: "1.2", mentionedChannels: [] };
function setup(t: TestContext) {
  const values = new Map([["schedules:job:job1", JSON.stringify(original)]]);
  const due = new Set(["job1"]);
  let beforeEval: (() => void) | undefined;
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    sMembers: async () => ["job1"],
    del: async (key: string) => values.delete(key),
    zRem: async (_key: string, id: string) => due.delete(id),
    sRem: async () => 1,
    eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
      beforeEval?.();
      const [before, after, _at, id] = options.arguments;
      if (values.get(options.keys[0]!) !== before || (script.includes("ZSCORE") && !due.has(id!))) return 0;
      values.set(options.keys[0]!, after!); due.add(id!); return 1;
    }
  };
  __testing.setRedisProvider(async () => redis as unknown as NonNullable<Awaited<ReturnType<typeof getRedisClient>>>);
  t.after(() => __testing.setRedisProvider());
  return { values, due, beforeEval: (hook: () => void) => { beforeEval = hook; } };
}
test("reminder edits preserve ID, recurrence and destination; invalid updates preserve original", async (t) => {
  const { values } = setup(t);
  const edited = await editOwnedSchedule("job1", "U123", "New", "2099-01-02T15:00:00.000Z");
  assert.equal(edited.id, "job1"); assert.equal(edited.kind, "daily"); assert.equal(edited.hour, 9); assert.equal(edited.channel, "C123");
  const before = values.get("schedules:job:job1");
  await assert.rejects(updateScheduleFromTool(context, "job1", { kind: "once", amount: -1, unit: "hours", task: "Bad" }));
  assert.equal(values.get("schedules:job:job1"), before);
});
test("non-owners cannot cancel reminders", async (t) => {
  const { values } = setup(t);
  await assert.rejects(cancelScheduleById("job1", "UOTHER"), /not found/);
  assert.ok(values.has("schedules:job:job1"));
});
test("concurrent cancellation and running reminders cannot be resurrected by edits or scheduler retries", async (t) => {
  const state = setup(t);
  state.beforeEval(() => { state.values.delete("schedules:job:job1"); });
  await assert.rejects(editOwnedSchedule("job1", "U123", "New", "2099-01-02T15:00:00.000Z"), /changed or is already running/);
  assert.equal(await __testing.rescheduleIfUnchanged(original, original, new Date("2099-01-01")), 0);
  assert.equal(state.values.has("schedules:job:job1"), false);
  state.beforeEval(() => {});
  state.values.set("schedules:job:job1", JSON.stringify(original)); state.due.clear();
  await assert.rejects(editOwnedSchedule("job1", "U123", "New", "2099-01-02T15:00:00.000Z"), /already running/);
});
test("schedule previews include recurrence, timezone, mode and destination without writes", async () => {
  const result = await previewScheduleFromTool(context, { kind: "weekly", weekday: "monday", hour: 9, minute: 5, task: "Check logs" });
  assert.match(result.summary, /Every monday at 09:05/);
  assert.equal(result.timeZone, "America/Chicago"); assert.equal(result.channelId, "C123");
  assert.match(result.summary, /reminder/);
});
