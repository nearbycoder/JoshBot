import {
  isDirectMentionToBot,
  isIgnorableSlackEvent,
  isSlackDirectMessage,
  respondToSlackActiveListeningMessage,
  respondToSlackDirectMessage,
  respondToSlackMention,
  respondToSlackThreadReply
} from "./slack.js";
import { getChannelMemorySettings } from "./memory.js";

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
    } else if (await isChannelActiveListeningEnabled(event.channel)) {
      await respondToSlackActiveListeningMessage(event);
    } else {
      await respondToSlackThreadReply(event);
    }
  }
}

async function isChannelActiveListeningEnabled(channel: string) {
  try {
    return (await getChannelMemorySettings(channel)).activeListening;
  } catch (error) {
    console.warn(`Unable to load Slack channel settings: ${summarizeError(error)}`);
    return false;
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
    channel_type: getStringField(event, "channel_type"),
    files: getSlackFilesField(event)
  };
}

function getStringField(record: object, key: string) {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getSlackFilesField(record: object) {
  const value = (record as Record<string, unknown>).files;

  if (!Array.isArray(value)) {
    return undefined;
  }

  const files = value.map(normalizeSlackFile).filter((file) => file !== null);
  return files.length > 0 ? files : undefined;
}

function normalizeSlackFile(input: unknown) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const id = getStringField(record, "id");

  if (!id) {
    return null;
  }

  return {
    id,
    mode: getStringField(record, "mode"),
    file_access: getStringField(record, "file_access"),
    title: getStringField(record, "title"),
    name: getStringField(record, "name"),
    mimetype: getStringField(record, "mimetype"),
    filetype: getStringField(record, "filetype"),
    pretty_type: getStringField(record, "pretty_type"),
    preview: getStringField(record, "preview"),
    preview_plain_text: getStringField(record, "preview_plain_text"),
    plain_text: getStringField(record, "plain_text"),
    contents: getStringField(record, "contents"),
    alt_txt: getStringField(record, "alt_txt"),
    permalink: getStringField(record, "permalink"),
    external_url: getNullableStringField(record, "external_url"),
    url_private: getStringField(record, "url_private"),
    url_private_download: getStringField(record, "url_private_download"),
    initial_comment: getInitialCommentField(record)
  };
}

function getNullableStringField(record: object, key: string) {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" || value === null ? value : undefined;
}

function getInitialCommentField(record: object) {
  const value = (record as Record<string, unknown>).initial_comment;

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const comment = getStringField(value, "comment");
  return comment ? { comment } : undefined;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  normalizeSlackMessageEvent
};
