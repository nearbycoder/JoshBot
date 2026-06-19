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
  assert.equal(
    event?.files?.[0]?.url_private_download,
    "https://files.slack.com/files-pri/T123-F123/download/image.jpg"
  );
});
