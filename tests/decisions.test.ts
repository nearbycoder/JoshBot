import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  formatChannelDecisionList,
  formatDecisionAdded,
  parseDecisionIntent
} from "../lib/decisions.js";

test("decision log uses one Redis key per channel", () => {
  assert.equal(__testing.getDecisionLogKey("C123"), "slack-channel-decisions:C123");
});

test("parses explicit decision commands", () => {
  assert.deepEqual(parseDecisionIntent("decision add Use Redis for cache state."), {
    action: "add",
    text: "Use Redis for cache state"
  });
  assert.deepEqual(parseDecisionIntent("we decided to ship the small controls first"), {
    action: "add",
    text: "ship the small controls first"
  });
  assert.deepEqual(parseDecisionIntent("list channel decisions"), { action: "list" });
  assert.deepEqual(parseDecisionIntent("decision help"), { action: "help" });
});

test("does not treat vague decision talk as a command", () => {
  assert.equal(parseDecisionIntent("did we decide on Redis?"), null);
});

test("decision parser keeps only valid records", () => {
  const decisions = __testing.parseDecisionLogPayload(
    JSON.stringify({
      decisions: [
        {
          id: "d1",
          channelId: "C123",
          text: "  Use Redis  ",
          createdAt: "2026-06-25T15:00:00.000Z",
          userId: "U123",
          threadUrl: "https://example.slack.com/archives/C123/p1",
          source: "slack-message"
        },
        { id: "missing-text", channelId: "C123", createdAt: "2026-06-25T15:00:00.000Z" }
      ]
    })
  );

  assert.deepEqual(decisions, [
    {
      id: "d1",
      channelId: "C123",
      text: "Use Redis",
      createdAt: "2026-06-25T15:00:00.000Z",
      userId: "U123",
      threadUrl: "https://example.slack.com/archives/C123/p1",
      source: "slack-message"
    }
  ]);
});

test("formats added and listed decisions with thread links", () => {
  const decision = {
    id: "d1",
    channelId: "C123",
    text: "Use Redis for the decision log",
    createdAt: "2026-06-25T15:00:00.000Z",
    userId: "U123",
    threadUrl: "https://example.slack.com/archives/C123/p1",
    source: "slack-message" as const
  };

  assert.match(formatDecisionAdded(decision), /Logged decision: Use Redis/);
  assert.match(formatDecisionAdded(decision), /<https:\/\/example\.slack\.com\/archives\/C123\/p1\|2026-06-25>/);

  const list = formatChannelDecisionList([decision]);
  assert.match(list, /\*Channel decisions\*/);
  assert.match(list, /1\. <https:\/\/example\.slack\.com\/archives\/C123\/p1\|2026-06-25> by <@U123>: Use Redis/);
});
