import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../lib/follow-ups.js";

test("parses follow-up skill commands", () => {
  assert.deepEqual(__testing.parseFollowUpSkillCommand(""), { action: "track" });
  assert.deepEqual(__testing.parseFollowUpSkillCommand("list"), {
    action: "list",
    scope: "thread"
  });
  assert.deepEqual(__testing.parseFollowUpSkillCommand("mine"), {
    action: "list",
    scope: "mine"
  });
  assert.deepEqual(__testing.parseFollowUpSkillCommand("done abc12345"), {
    action: "done",
    idPrefix: "abc12345"
  });
});

test("parses model follow-up JSON", () => {
  const drafts = __testing.parseFollowUpExtraction(`
    \`\`\`json
    {
      "followUps": [
        {
          "task": "Ship the launch checklist",
          "ownerUserId": "U123",
          "dueAt": "2026-07-01T15:00:00-05:00",
          "source": "Current user: I'll ship it Wednesday"
        },
        { "task": "   " }
      ]
    }
    \`\`\`
  `);

  assert.deepEqual(drafts, [
    {
      task: "Ship the launch checklist",
      assigneeUserId: "U123",
      dueAt: "2026-07-01T20:00:00.000Z",
      source: "Current user: I'll ship it Wednesday"
    }
  ]);
});

test("normalizes follow-up owner names when no Slack ID is known", () => {
  const drafts = __testing.normalizeFollowUpDrafts([
    {
      action: "- Draft rollout notes",
      owner: "Alex",
      due: "not a date"
    }
  ]);

  assert.deepEqual(drafts, [
    {
      task: "Draft rollout notes",
      assigneeName: "Alex"
    }
  ]);
});

test("follow-up Redis keys are scoped by record, thread, and user", () => {
  assert.equal(__testing.getFollowUpRecordKey("abc"), "follow-ups:record:abc");
  assert.equal(__testing.getFollowUpThreadKey("C123", "1000.000"), "follow-ups:thread:C123:1000.000");
  assert.equal(__testing.getFollowUpUserKey("U123"), "follow-ups:user:U123");
});
