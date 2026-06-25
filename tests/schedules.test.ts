import assert from "node:assert/strict";
import test from "node:test";
import { __testing, type ScheduleToolInput, type SlackScheduleContext } from "../lib/schedules.js";

const baseContext: SlackScheduleContext = {
  ownerUserId: "U123",
  channel: "CGENERAL",
  threadTs: "1000.000",
  sourceTs: "1001.000",
  mentionedChannels: []
};

test("schedule input accepts numeric strings for delays", () => {
  const parsed = __testing.scheduleToolInputToParsedSchedule({
    kind: "once",
    task: "check logs",
    amount: "5",
    unit: "minutes"
  });

  assert.equal(parsed.kind, "once");
  assert.equal(parsed.intervalMs, 5 * 60 * 1000);
});

test("schedule input accepts numeric strings for daily time", () => {
  const parsed = __testing.scheduleToolInputToParsedSchedule({
    kind: "daily",
    task: "triage alerts",
    hour: "9",
    minute: "05"
  });

  assert.equal(parsed.kind, "daily");
  assert.equal(parsed.hour, 9);
  assert.equal(parsed.minute, 5);
});

test("schedule input accepts future ISO run times", () => {
  const runAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const parsed = __testing.scheduleToolInputToParsedSchedule({
    kind: "at",
    task: "follow up",
    runAt
  });

  assert.equal(parsed.kind, "once");
  assert.equal(parsed.firstRunAt.toISOString(), runAt);
});

test("schedule destination falls back to the only mentioned channel", () => {
  const destination = __testing.getScheduleDestination(
    {
      ...baseContext,
      mentionedChannels: [{ id: "CAI123", name: "ai" }]
    },
    {
      kind: "once",
      task: "what is trending on Hacker News",
      amount: 5,
      unit: "minutes"
    }
  );

  assert.equal(destination.channel, "CAI123");
  assert.equal(destination.channelName, "ai");
  assert.equal(destination.threadTs, undefined);
});

test("schedule destination stays in the source thread without a channel mention", () => {
  const destination = __testing.getScheduleDestination(baseContext, {
    kind: "once",
    task: "check logs",
    amount: 5,
    unit: "minutes"
  });

  assert.equal(destination.channel, "CGENERAL");
  assert.equal(destination.threadTs, "1000.000");
});

test("prompt mode is inferred for current-information tasks", () => {
  assert.equal(__testing.inferResponseMode("what is currently trending on Hacker News"), "prompt");
  assert.equal(__testing.inferResponseMode("check the logs"), "reminder");
});

test("update keeps existing destination when no new channel is mentioned", () => {
  const destination = __testing.getScheduleDestinationForUpdate(
    baseContext,
    {
      kind: "interval",
      task: "check logs",
      amount: 30,
      unit: "minutes"
    },
    {
      id: "abc123",
      ownerUserId: "U123",
      channel: "CAI123",
      channelName: "ai",
      task: "old task",
      responseMode: "prompt",
      kind: "once",
      createdAt: new Date().toISOString(),
      nextRunAt: new Date().toISOString(),
      intervalMs: 60_000,
      timezone: "America/Chicago"
    }
  );

  assert.equal(destination.channel, "CAI123");
  assert.equal(destination.channelName, "ai");
  assert.equal(destination.responseMode, "prompt");
});

test("invalid zero delay is rejected", () => {
  const input: ScheduleToolInput = {
    kind: "once",
    task: "check logs",
    amount: 0,
    unit: "minutes"
  };

  assert.throws(() => __testing.scheduleToolInputToParsedSchedule(input), /positive whole number/);
});

test("schedule summaries use stored user timezone", () => {
  const summary = __testing.formatScheduleSummary({
    id: "abc123",
    ownerUserId: "U123",
    channel: "C123",
    task: "standup",
    kind: "daily",
    createdAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T14:00:00.000Z",
    hour: 9,
    minute: 0,
    timezone: "America/New_York"
  });

  assert.match(summary, /America\/New_York/);
  assert.match(summary, /daily at/);
});

test("reminder style formats delivered reminder text", () => {
  assert.equal(__testing.formatReminderText("check logs", "direct"), "check logs");
  assert.equal(__testing.formatReminderText("check logs", "gentle"), "Gentle reminder: check logs");
  assert.match(__testing.formatReminderText("check logs", "detailed"), /Scheduled by NoBo/);
});
