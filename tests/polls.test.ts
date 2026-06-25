import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  formatPollCreated,
  formatPollList,
  formatPollSummary,
  parsePollIntent,
  type SlackPoll
} from "../lib/polls.js";

const basePoll: SlackPoll = {
  id: "abcdef12-3456-7890-abcd-ef1234567890",
  channelId: "C123",
  question: "Ship Friday",
  options: [
    { id: "1", text: "Yes" },
    { id: "2", text: "No" }
  ],
  votes: {
    U123: {
      userId: "U123",
      optionId: "1",
      source: "command",
      createdAt: "2026-06-25T15:00:00.000Z"
    },
    U456: {
      userId: "U456",
      optionId: "2",
      source: "reaction",
      createdAt: "2026-06-25T15:01:00.000Z"
    }
  },
  status: "open",
  createdAt: "2026-06-25T15:00:00.000Z",
  createdBy: "U123",
  threadTs: "1000.000"
};

test("poll log uses one Redis key per channel", () => {
  assert.equal(__testing.getPollLogKey("C123"), "slack-channel-polls:C123");
});

test("parses poll commands", () => {
  assert.deepEqual(parsePollIntent("create Ship Friday? | Yes | No"), {
    action: "create",
    question: "Ship Friday",
    options: ["Yes", "No"]
  });
  assert.deepEqual(parsePollIntent("poll vote abc12345 2"), {
    action: "vote",
    pollId: "abc12345",
    choice: "2"
  });
  assert.deepEqual(parsePollIntent("results"), { action: "summary" });
  assert.deepEqual(parsePollIntent("close abc12345 decision"), {
    action: "close",
    pollId: "abc12345",
    recordDecision: true
  });
});

test("poll parser keeps only valid records and votes", () => {
  const polls = __testing.parsePollLogPayload(
    JSON.stringify({
      polls: [
        basePoll,
        {
          id: "bad",
          channelId: "C123",
          question: "",
          createdAt: "2026-06-25T15:00:00.000Z",
          options: []
        }
      ]
    })
  );

  assert.deepEqual(polls, [basePoll]);
});

test("formats poll create list and summary text", () => {
  assert.match(formatPollCreated(basePoll), /\*Poll abcdef12\*: Ship Friday/);
  assert.match(formatPollCreated(basePoll), /1\. Yes/);
  assert.match(formatPollList([basePoll]), /abcdef12 open: Ship Friday \(2 votes\)/);
  assert.match(formatPollSummary(basePoll), /1\. Yes: 1/);
  assert.match(formatPollSummary(basePoll), /Tie: Yes, No \(1\/2\)/);
});

test("reaction names map to poll choices", () => {
  assert.equal(__testing.getReactionPollChoice(":one:"), "1");
  assert.equal(__testing.getReactionPollChoice("two"), "2");
  assert.equal(__testing.getReactionPollChoice("regional_indicator_c"), "c");
  assert.equal(__testing.getReactionPollChoice("summary"), null);
});

test("reaction votes only resolve polls anchored to that message", () => {
  assert.deepEqual(__testing.resolvePollForReaction([basePoll], "1000.000"), {
    ok: true,
    poll: basePoll
  });
  assert.deepEqual(__testing.resolvePollForReaction([basePoll], "9999.000"), {
    ok: false,
    reason: "No poll found for that message."
  });
});

test("poll decision text summarizes consensus", () => {
  assert.equal(__testing.formatPollDecisionText({
    ...basePoll,
    votes: {
      ...basePoll.votes,
      U789: {
        userId: "U789",
        optionId: "1",
        source: "command",
        createdAt: "2026-06-25T15:02:00.000Z"
      }
    }
  }), "Ship Friday: Yes");
});
