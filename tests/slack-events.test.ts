import assert from "node:assert/strict";
import test from "node:test";
import { __testing, type SlackEventCallbackPayload } from "../lib/slack-events.js";

test("normalizes Slack app mention file attachments", () => {
  const rawEvent = {
    type: "app_mention",
    channel: "C123",
    text: "<@U999> what is this image?",
    ts: "1000.000",
    user: "U123",
    files: [
      {
        id: "F123",
        name: "IMG_4153.jpg",
        title: "IMG_4153.jpg",
        mimetype: "image/jpeg",
        filetype: "jpg",
        pretty_type: "JPEG",
        size: 12345,
        created: 1771804800,
        user: "U123",
        url_private: "https://files.slack.com/files-pri/T123-F123/image.jpg",
        url_private_download: "https://files.slack.com/files-pri/T123-F123/download/image.jpg"
      }
    ]
  } as SlackEventCallbackPayload["event"];
  const event = __testing.normalizeSlackMessageEvent(rawEvent, "T123");

  assert.equal(event?.team_id, "T123");
  assert.equal(event?.files?.length, 1);
  assert.equal(event?.files?.[0]?.id, "F123");
  assert.equal(event?.files?.[0]?.mimetype, "image/jpeg");
  assert.equal(event?.files?.[0]?.size, 12345);
  assert.equal(event?.files?.[0]?.created, 1771804800);
  assert.equal(event?.files?.[0]?.user, "U123");
  assert.equal(
    event?.files?.[0]?.url_private_download,
    "https://files.slack.com/files-pri/T123-F123/download/image.jpg"
  );
});

test("normalizes Slack reaction_added message events", () => {
  const rawEvent = {
    type: "reaction_added",
    user: "U123",
    reaction: "summary",
    item_user: "U456",
    item: {
      type: "message",
      channel: "C123",
      ts: "1000.000",
      channel_type: "channel"
    },
    event_ts: "1001.000"
  } as SlackEventCallbackPayload["event"];
  const event = __testing.normalizeSlackReactionAddedEvent(rawEvent, "T123");

  assert.equal(event?.team_id, "T123");
  assert.equal(event?.reaction, "summary");
  assert.equal(event?.item.channel, "C123");
  assert.equal(event?.item.ts, "1000.000");
  assert.equal(event?.event_ts, "1001.000");
});

test("ignores Slack reactions on non-message items", () => {
  const rawEvent = {
    type: "reaction_added",
    user: "U123",
    reaction: "summary",
    item: {
      type: "file",
      file: "F123"
    },
    event_ts: "1001.000"
  } as SlackEventCallbackPayload["event"];

  assert.equal(__testing.normalizeSlackReactionAddedEvent(rawEvent, "T123"), null);
});
