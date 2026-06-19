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

test("returns ephemeral help for /nobo-help", () => {
  const result = handleSlackSlashCommandPayload({
    command: "/nobo-help",
    text: ""
  });

  const { response } = result;
  assert.equal(response.response_type, "ephemeral");
  assert.equal(response.mrkdwn, true);
  assert.match(response.text, /`\/nobo-help`/);
  assert.match(response.text, /`\/nobo-ai-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-dad-joke`/);
  assert.match(response.text, /@NoBo web-search/);
});

test("points unknown /nobo-help slash command text at help", () => {
  const result = handleSlackSlashCommandPayload({
    command: "/nobo-help",
    text: "dance"
  });

  const { response } = result;
  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text, /don't recognize/);
  assert.match(response.text, /`\/nobo-help`/);
});

test("starts an async AI news task for /nobo-ai-news", () => {
  const result = handleSlackSlashCommandPayload({
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

test("returns usage help for /nobo-ai-news help", () => {
  const result = handleSlackSlashCommandPayload({
    command: "/nobo-ai-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-ai-news`/);
  assert.equal(result.task, undefined);
});

test("returns an in-channel dad joke for /nobo-dad-joke", () => {
  const result = handleSlackSlashCommandPayload({
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
