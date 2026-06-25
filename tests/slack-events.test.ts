import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  handleSlackEventCallbackPayload,
  type SlackEventCallbackPayload
} from "../lib/slack-events.js";

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

test("normalizes Slack App Home opened events for the Home tab", () => {
  const event = __testing.normalizeSlackAppHomeOpenedEvent({
    type: "app_home_opened",
    user: "U123",
    tab: "home"
  });

  assert.deepEqual(event, {
    type: "app_home_opened",
    user: "U123",
    tab: "home"
  });
  assert.equal(
    __testing.normalizeSlackAppHomeOpenedEvent({
      type: "app_home_opened",
      user: "U123",
      tab: "messages"
    }),
    null
  );
});

test("handles Slack App Home opened by publishing a Home view", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SLACK_BOT_TOKEN;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalArtifactDir = process.env.ARTIFACT_DIR;
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  delete process.env.REDIS_URL;
  process.env.ARTIFACT_DIR = "/tmp/nobo-missing-artifacts-for-test";
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true, view: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await handleSlackEventCallbackPayload({
      type: "event_callback",
      event: {
        type: "app_home_opened",
        user: "U123",
        tab: "home"
      }
    });

    assert.equal(String(calls[0]?.input), "https://slack.com/api/views.publish");
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.user_id, "U123");
    assert.equal(body.view.type, "home");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("SLACK_BOT_TOKEN", originalToken);
    restoreEnv("REDIS_URL", originalRedisUrl);
    restoreEnv("ARTIFACT_DIR", originalArtifactDir);
  }
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
