import assert from "node:assert/strict";
import test from "node:test";
import { __testing, type SlackReactionAddedEvent } from "../lib/slack-reactions.js";

const baseReactionEvent: SlackReactionAddedEvent = {
  type: "reaction_added",
  user: "U123",
  reaction: "summary",
  item_user: "U456",
  item: {
    type: "message",
    channel: "C123",
    ts: "1000.000",
    channel_type: "channel"
  },
  event_ts: "1001.000",
  team_id: "T123"
};

test("maps only known reaction shortcuts", () => {
  assert.equal(__testing.getSlackReactionShortcut(":summary:"), "summary");
  assert.equal(__testing.getSlackReactionShortcut("nobo_note"), "note");
  assert.equal(__testing.getSlackReactionShortcut("alarm_clock"), "reminder");
  assert.equal(__testing.getSlackReactionShortcut("thumbsup"), null);
});

test("builds thread-scoped synthetic reaction shortcut events", () => {
  const event = __testing.createReactionShortcutMessageEvent(baseReactionEvent, "summary");

  assert.equal(event.channel, "C123");
  assert.equal(event.thread_ts, "1000.000");
  assert.equal(event.ts, "1001.000");
  assert.equal(event.user, "U123");
  assert.equal(event.text, "summarize-thread");
});

test("ignores bot reaction shortcuts when bot user id is known", () => {
  const originalBotUserId = process.env.SLACK_BOT_USER_ID;
  process.env.SLACK_BOT_USER_ID = "UBOT";

  try {
    assert.equal(
      __testing.shouldIgnoreReactionShortcutEvent({
        ...baseReactionEvent,
        user: "UBOT"
      }),
      true
    );
    assert.equal(
      __testing.shouldIgnoreReactionShortcutEvent({
        ...baseReactionEvent,
        item_user: "UBOT"
      }),
      true
    );
    assert.equal(__testing.shouldIgnoreReactionShortcutEvent(baseReactionEvent), false);
  } finally {
    if (originalBotUserId === undefined) {
      delete process.env.SLACK_BOT_USER_ID;
    } else {
      process.env.SLACK_BOT_USER_ID = originalBotUserId;
    }
  }
});
