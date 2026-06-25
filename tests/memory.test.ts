import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../lib/memory.js";

test("channel memory uses one Redis key per channel", () => {
  assert.equal(__testing.getChannelMemoryKey("C123"), "slack-channel-memory:C123");
});

test("channel memory parser keeps only valid shared entries", () => {
  const entries = __testing.parseChannelMemoryPayload(
    JSON.stringify({
      memories: [
        { role: "user", content: "  hello channel  ", userId: "U123" },
        { role: "assistant", content: "got it", ts: "1000.000" },
        { role: "user", content: "" },
        { role: "system", content: "skip me" }
      ]
    })
  );

  assert.deepEqual(entries, [
    { role: "user", content: "hello channel", userId: "U123" },
    { role: "assistant", content: "got it", ts: "1000.000" }
  ]);
});

test("channel memory parser keeps settings beside memory", () => {
  const state = __testing.parseChannelMemoryState(
    JSON.stringify({
      memories: [{ role: "user", content: "hello" }],
      settings: { activeListening: true }
    })
  );

  assert.deepEqual(state, {
    memories: [{ role: "user", content: "hello" }],
    settings: { activeListening: true }
  });
});

test("channel memory settings default off", () => {
  const state = __testing.parseChannelMemoryState(
    JSON.stringify({
      memories: [],
      settings: { activeListening: "yes" }
    })
  );

  assert.deepEqual(state.settings, { activeListening: false });
});

test("channel memory matcher supports numbered removal", () => {
  const match = __testing.findChannelMemoryMatch(
    [
      { role: "user", content: "first item" },
      { role: "assistant", content: "second item" }
    ],
    "2"
  );

  assert.deepEqual(match, {
    status: "removed",
    index: 1,
    memory: { role: "assistant", content: "second item" }
  });
});
