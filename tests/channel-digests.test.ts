import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../lib/channel-digests.js";

test("parses daily channel digest subscriptions with focus", () => {
  const parsed = __testing.parseChannelDigestCommand("daily at 09:30 focus launch blockers");

  assert.deepEqual(parsed, {
    kind: "create",
    frequency: "daily",
    hour: 9,
    minute: 30,
    focus: "launch blockers"
  });
});

test("parses weekly channel digest subscriptions with meridiem time", () => {
  const parsed = __testing.parseChannelDigestCommand("subscribe weekly friday 4:05pm on customer feedback");

  assert.deepEqual(parsed, {
    kind: "create",
    frequency: "weekly",
    weekday: 5,
    hour: 16,
    minute: 5,
    focus: "customer feedback"
  });
});

test("parses list and cancel channel digest commands", () => {
  assert.deepEqual(__testing.parseChannelDigestCommand("list"), { kind: "list" });
  assert.deepEqual(__testing.parseChannelDigestCommand("cancel abc123"), {
    kind: "cancel",
    idPrefix: "abc123"
  });
});

test("formats channel digest prompt with ordered history and focus", () => {
  const prompt = __testing.formatChannelDigestPrompt({
    channel: "C123",
    frequency: "weekly",
    focus: "release risk",
    days: 7,
    messages: [
      {
        ts: "2000.000",
        datetime: "2026-06-25T15:00:00.000Z",
        speaker: "User U2",
        text: "Latest message"
      },
      {
        ts: "1000.000",
        datetime: "2026-06-24T15:00:00.000Z",
        speaker: "User U1",
        text: "Earlier message"
      }
    ]
  });

  assert.match(prompt, /weekly Slack channel digest/);
  assert.match(prompt, /Focus: release risk/);
  assert.ok(prompt.indexOf("Earlier message") < prompt.indexOf("Latest message"));
});

test("channel digest runner interval follows scheduler fallback", () => {
  const originalChannelInterval = process.env.CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS;
  const originalSchedulerInterval = process.env.SCHEDULER_INTERVAL_MS;
  delete process.env.CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS;
  process.env.SCHEDULER_INTERVAL_MS = "12000";

  try {
    assert.equal(__testing.getChannelDigestRunnerIntervalMs(), 12000);
  } finally {
    if (originalChannelInterval === undefined) {
      delete process.env.CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS;
    } else {
      process.env.CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS = originalChannelInterval;
    }

    if (originalSchedulerInterval === undefined) {
      delete process.env.SCHEDULER_INTERVAL_MS;
    } else {
      process.env.SCHEDULER_INTERVAL_MS = originalSchedulerInterval;
    }
  }
});
