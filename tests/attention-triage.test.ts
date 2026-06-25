import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../lib/attention-triage.js";
import { maybeHandleSlackSkillCommand } from "../lib/skills.js";

test("parses direct mentions, questions, follow-ups, and decisions", () => {
  const items = __testing.parseAttentionItemsFromMessage(
    {
      speaker: "User U2",
      text: "<@U123> can you follow up by EOD? We decided to keep launch scoped."
    },
    "U123"
  );

  assert.deepEqual(
    items.map((item) => item.bucket),
    ["reply", "follow_up", "decision"]
  );
  assert.equal(items[0]?.title, "Needs your reply");
});

test("ranks urgent items before reply, follow-up, schedule, and decision buckets", () => {
  const report = __testing.createAttentionTriageReport({
    currentUserId: "U123",
    now: new Date("2026-06-25T12:00:00.000Z"),
    messages: [
      {
        speaker: "User U2",
        text: "FYI we decided to delay the migration."
      },
      {
        speaker: "User U3",
        text: "<@U123> urgent blocker: deploy is failing."
      },
      {
        speaker: "User U4",
        text: "Can someone confirm the copy?"
      }
    ],
    schedules: [
      {
        id: "schedule-123",
        summary: "one-time reminder for today: send release notes",
        nextRunAt: "2026-06-25T18:00:00.000Z"
      }
    ]
  });

  assert.equal(report.items[0]?.bucket, "urgent");
  assert.deepEqual(
    report.items.map((item) => item.bucket),
    ["urgent", "reply", "schedule", "reply", "decision"]
  );
});

test("formats empty triage state", () => {
  const text = __testing.formatAttentionTriageReport(
    __testing.createAttentionTriageReport({ messages: [] })
  );

  assert.match(text, /Nothing obvious right now/);
  assert.match(text, /Scanned 0 messages/);
});

test("handles natural attention skill command without model call", async () => {
  const reply = await maybeHandleSlackSkillCommand({
    commandText: "what needs my attention?",
    modelMessages: [
      {
        role: "user",
        content: "Other user (U2): <@U123> please review the launch checklist."
      }
    ],
    memories: [],
    currentUserId: "U123"
  });

  assert.match(reply ?? "", /What needs your attention/);
  assert.match(reply ?? "", /Needs your reply/);
});
