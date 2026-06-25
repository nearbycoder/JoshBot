import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  handleChannelMemorySlashCommandText
} from "../lib/channel-memory-controls.js";

test("channel memory slash show returns memory and settings", async () => {
  const reply = await handleChannelMemorySlashCommandText({
    text: "",
    channelId: "C123"
  });

  assert.equal(reply, "Shared channel memory is empty. Active listening: off.");
});

test("channel memory slash commands require shared channel context", async () => {
  assert.equal(
    await handleChannelMemorySlashCommandText({
      text: "show",
      channelId: "D123"
    }),
    "Run this in a Slack channel."
  );
});

test("channel memory clear requires confirmation", async () => {
  assert.equal(
    await handleChannelMemorySlashCommandText({
      text: "clear",
      channelId: "C123"
    }),
    "To clear shared channel memory, run `/nobo-memory clear confirm`."
  );
});

test("parses mention channel memory commands", () => {
  assert.deepEqual(__testing.parseChannelMemoryMention("show channel memory"), { name: "show" });
  assert.deepEqual(__testing.parseChannelMemoryMention("forget channel memory 2"), {
    name: "forget",
    query: "2"
  });
  assert.deepEqual(__testing.parseChannelMemoryMention("clear channel memory confirm"), {
    name: "clear",
    confirmed: true
  });
  assert.equal(__testing.parseChannelMemoryMention("show my memory"), null);
});

test("formats channel memory entries concisely", () => {
  assert.equal(
    __testing.formatChannelMemorySnapshot({
      memories: [
        { role: "user", userId: "U123", content: "  first\nmemory  " },
        { role: "assistant", content: "second memory" }
      ],
      settings: { activeListening: true }
    }),
    "Shared channel memory (2). Active listening: on.\n1. User U123: first memory\n2. NoBo: second memory"
  );
});
