import assert from "node:assert/strict";
import test from "node:test";
import {
  handleSlackSlashCommandPayload,
  parseSlackSlashCommandPayload
} from "../lib/slack-commands.js";

test("parses Slack slash command payloads", () => {
  const payload = parseSlackSlashCommandPayload(
    "command=%2Fnobo&text=help&user_id=U123&channel_id=C123&team_id=T123"
  );

  assert.equal(payload.command, "/nobo");
  assert.equal(payload.text, "help");
  assert.equal(payload.user_id, "U123");
  assert.equal(payload.channel_id, "C123");
  assert.equal(payload.team_id, "T123");
});

test("returns ephemeral help for /nobo help", () => {
  const response = handleSlackSlashCommandPayload({
    command: "/nobo",
    text: "help"
  });

  assert.equal(response.response_type, "ephemeral");
  assert.equal(response.mrkdwn, true);
  assert.match(response.text, /`\/nobo help`/);
  assert.match(response.text, /@NoBo web-search/);
});

test("points unknown /nobo slash command text at help", () => {
  const response = handleSlackSlashCommandPayload({
    command: "/nobo",
    text: "dance"
  });

  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text, /don't recognize/);
  assert.match(response.text, /`\/nobo help`/);
});
