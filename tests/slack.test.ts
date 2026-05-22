import assert from "node:assert/strict";
import test from "node:test";
import { isSlackDirectMessage } from "../lib/slack.js";

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
