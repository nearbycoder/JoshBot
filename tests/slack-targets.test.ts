import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSlackChannelId,
  resolveSlackTargetChannel
} from "../lib/slack-targets.js";

const context = {
  ownerUserId: "U123",
  channel: "CGENERAL",
  mentionedChannels: [{ id: "CAI123", name: "ai" }]
};

test("normalizes Slack target channel IDs", () => {
  assert.equal(normalizeSlackChannelId("<#cai123|ai>"), "CAI123");
  assert.equal(normalizeSlackChannelId("#gteam123"), "GTEAM123");
  assert.equal(normalizeSlackChannelId("not-a-channel"), null);
});

test("resolves only current or mentioned target channels", () => {
  assert.deepEqual(resolveSlackTargetChannel(context, { targetChannelId: "CGENERAL" }), {
    ok: true,
    channel: { id: "CGENERAL", name: undefined }
  });
  assert.deepEqual(resolveSlackTargetChannel(context, { targetChannelId: "CAI123" }), {
    ok: true,
    channel: { id: "CAI123", name: "ai" }
  });
  assert.equal(resolveSlackTargetChannel(context, { targetChannelId: "CSECRET" }).ok, false);
});
