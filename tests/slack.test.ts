import assert from "node:assert/strict";
import test from "node:test";
import { __testing, isSlackDirectMessage } from "../lib/slack.js";

test("detects Slack IM events by channel_type", () => {
  assert.equal(
    isSlackDirectMessage({
      channel: "C123",
      channel_type: "im",
      text: "hello",
      ts: "1000.000"
    }),
    true
  );
});

test("detects Slack D-prefixed direct message channels", () => {
  assert.equal(
    isSlackDirectMessage({
      channel: "D123",
      text: "hello",
      ts: "1000.000"
    }),
    true
  );
});

test("does not classify normal channel messages as direct messages", () => {
  assert.equal(
    isSlackDirectMessage({
      channel: "C123",
      channel_type: "channel",
      text: "hello",
      ts: "1000.000"
    }),
    false
  );
});

test("uses one idempotency lock key for the same Slack message across handlers", () => {
  const event = {
    channel: "C123",
    text: "<@U999> hello",
    thread_ts: "1000.000",
    ts: "1001.000"
  };

  assert.equal(
    __testing.getSlackEventLockKey(event, "mention"),
    __testing.getSlackEventLockKey(event, "thread-reply")
  );
  assert.equal(
    __testing.getSlackEventLockKey(event, "mention"),
    "slack-event-lock:C123:1000.000:1001.000"
  );
});

test("active listening reply slots cap concurrent channel replies", () => {
  const originalLimit = process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES;
  process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES = "2";

  const first = __testing.acquireActiveListeningReplySlot("C-SLOTS");
  const second = __testing.acquireActiveListeningReplySlot("C-SLOTS");
  const third = __testing.acquireActiveListeningReplySlot("C-SLOTS");

  try {
    assert.equal(__testing.getActiveListeningMaxConcurrentReplies(), 2);
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, true);
    assert.equal(third.acquired, false);

    first.release();
    const afterRelease = __testing.acquireActiveListeningReplySlot("C-SLOTS");

    try {
      assert.equal(afterRelease.acquired, true);
    } finally {
      afterRelease.release();
    }
  } finally {
    first.release();
    second.release();

    if (originalLimit === undefined) {
      delete process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES;
    } else {
      process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES = originalLimit;
    }
  }
});
