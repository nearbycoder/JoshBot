import assert from "node:assert/strict";
import test from "node:test";
import {
  handleSlackSlashCommandPayload,
  parseSlackSlashCommandPayload
} from "../lib/slack-commands.js";

test("parses Slack slash command payloads", () => {
  const payload = parseSlackSlashCommandPayload(
    "command=%2Fnobo-help&text=help&user_id=U123&channel_id=C123&team_id=T123"
  );

  assert.equal(payload.command, "/nobo-help");
  assert.equal(payload.text, "help");
  assert.equal(payload.user_id, "U123");
  assert.equal(payload.channel_id, "C123");
  assert.equal(payload.team_id, "T123");
});

test("returns ephemeral help for /nobo-help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-help",
    text: ""
  });

  const { response } = result;
  assert.equal(response.response_type, "ephemeral");
  assert.equal(response.mrkdwn, true);
  assert.match(response.text, /`\/nobo-help`/);
  assert.match(response.text, /`\/nobo-status`/);
  assert.match(response.text, /`\/nobo-listen \[on\|off\|status\]`/);
  assert.match(response.text, /`\/nobo-memory \[show\|forget <number\|text>\|clear confirm\]`/);
  assert.match(response.text, /`\/nobo-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-hacker-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-ai-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-dad-joke`/);
  assert.match(response.text, /@NoBo web-search/);
});

test("returns ephemeral ops status for /nobo-status", async () => {
  const result = await handleSlackSlashCommandPayload(
    {
      command: "/nobo-status",
      text: ""
    },
    {
      formatOpsStatus: async () => "*NoBo status*\nRedis: ok"
    }
  );

  assert.equal(result.response.response_type, "ephemeral");
  assert.equal(result.response.mrkdwn, true);
  assert.match(result.response.text, /NoBo status/);
  assert.match(result.response.text, /Redis: ok/);
  assert.equal(result.task, undefined);
});

test("points unknown /nobo-help slash command text at help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-help",
    text: "dance"
  });

  const { response } = result;
  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text, /don't recognize/);
  assert.match(response.text, /`\/nobo-help`/);
});

test("returns channel memory status for /nobo-memory", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-memory",
    text: "",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.equal(result.response.text, "Shared channel memory is empty. Active listening: off.");
});

test("requires confirmation for /nobo-memory clear", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-memory",
    text: "clear",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /clear confirm/);
});

test("returns active listening status for /nobo-listen status", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-listen",
    text: "status",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Active listening is off/);
});

test("reports Redis requirement for /nobo-listen toggle without Redis", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-listen",
    text: "",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Redis is not configured/);
});

test("starts an async AI news task for /nobo-ai-news", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-ai-news",
    text: "open source models",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Pulling this week's AI news/);
  assert.deepEqual(result.task, {
    type: "ai-news",
    channelId: "C123",
    userId: "U123",
    focus: "open source models"
  });
});

test("returns usage help for /nobo-ai-news help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-ai-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-ai-news`/);
  assert.equal(result.task, undefined);
});

test("starts an async news task for /nobo-news", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-news",
    text: "markets",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Pulling this week's news/);
  assert.deepEqual(result.task, {
    type: "news",
    channelId: "C123",
    userId: "U123",
    focus: "markets"
  });
});

test("returns usage help for /nobo-news help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-news`/);
  assert.equal(result.task, undefined);
});

test("starts an async Hacker News task for /nobo-hacker-news", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-hacker-news",
    text: "rust",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Pulling top trending Hacker News stories matching "rust"/);
  assert.deepEqual(result.task, {
    type: "hacker-news",
    channelId: "C123",
    userId: "U123",
    focus: "rust"
  });
});

test("returns usage help for /nobo-hacker-news help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-hacker-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-hacker-news`/);
  assert.equal(result.task, undefined);
});

test("returns an in-channel dad joke for /nobo-dad-joke", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-dad-joke",
    text: "",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "in_channel");
  assert.equal(result.response.mrkdwn, true);
  assert.match(result.response.text, /^\*Dad joke:\* .+/);
  assert.equal(result.task, undefined);
});
