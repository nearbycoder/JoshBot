import {
  isDirectMentionToBot,
  isIgnorableSlackEvent,
  isSlackDirectMessage,
  respondToSlackDirectMessage,
  respondToSlackMention,
  respondToSlackThreadReply
} from "./slack.js";

export type SlackUrlVerificationPayload = {
  type: "url_verification";
  challenge: string;
};

export type SlackEventCallbackPayload = {
  type: "event_callback";
  team_id?: string;
  event: object & {
    type: string;
  };
};

export type SlackPayload = SlackUrlVerificationPayload | SlackEventCallbackPayload;

export function parseSlackPayload(rawBody: string) {
  return JSON.parse(rawBody) as SlackPayload;
}

export async function handleSlackEventCallbackPayload(payload: SlackEventCallbackPayload) {
  const event = normalizeSlackMessageEvent(payload.event, payload.team_id);

  if (!event || isIgnorableSlackEvent(event)) {
    return;
  }

  if (event.type === "app_mention") {
    await respondToSlackMention(event);
  }

  if (event.type === "message" && !isDirectMentionToBot(event.text)) {
    if (isSlackDirectMessage(event)) {
      await respondToSlackDirectMessage(event);
    } else {
      await respondToSlackThreadReply(event);
    }
  }
}

function normalizeSlackMessageEvent(event: SlackEventCallbackPayload["event"], teamId?: string) {
  const type = typeof event.type === "string" ? event.type : "";
  const channel = getStringField(event, "channel");
  const ts = getStringField(event, "ts");

  if (
    !channel ||
    !ts ||
    (type !== "app_mention" && type !== "message")
  ) {
    return null;
  }

  return {
    type,
    channel,
    text: getStringField(event, "text") ?? "",
    thread_ts: getStringField(event, "thread_ts"),
    ts,
    team_id: teamId ?? getStringField(event, "team_id") ?? getStringField(event, "team"),
    user: getStringField(event, "user"),
    bot_id: getStringField(event, "bot_id"),
    subtype: getStringField(event, "subtype"),
    channel_type: getStringField(event, "channel_type")
  };
}

function getStringField(record: object, key: string) {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
