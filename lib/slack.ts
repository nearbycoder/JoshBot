import crypto from "node:crypto";
import { type ModelMessage } from "ai";
import { createSlackReply } from "./ai.js";
import { requireEnv } from "./env.js";

type SlackHeaders = Headers | Record<string, string | string[] | undefined>;

type SlackReply = {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
};

type SlackApiSuccess<T> = T & { ok: true };
type SlackApiFailure = { ok: false; error: string };

type SlackConversationRepliesResponse =
  | SlackApiSuccess<{ messages: SlackReply[] }>
  | SlackApiFailure;

type SlackPostMessageResponse =
  | SlackApiSuccess<{ channel: string; ts: string }>
  | SlackApiFailure;

type SlackMessageEvent = {
  channel: string;
  text: string;
  thread_ts?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
};

export function verifySlackRequest(body: string, headers: SlackHeaders) {
  const signature = getHeader(headers, "x-slack-signature");
  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signature || !timestamp || !signingSecret) {
    return false;
  }

  const ageInSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageInSeconds) || ageInSeconds > 60 * 5) {
    return false;
  }

  const payload = `v0:${timestamp}:${body}`;
  const digest = crypto.createHmac("sha256", signingSecret).update(payload).digest("hex");
  const expected = `v0=${digest}`;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function isIgnorableSlackEvent(event: SlackMessageEvent) {
  return Boolean(event.bot_id || event.subtype);
}

export async function respondToSlackMention(event: SlackMessageEvent) {
  const token = requireEnv("SLACK_BOT_TOKEN");
  const threadTs = event.thread_ts ?? event.ts;
  const fallbackPrompt = stripSlackFormatting(event.text);

  let messages: ModelMessage[] = [{ role: "user", content: fallbackPrompt }];

  try {
    messages = await loadSlackThreadAsModelMessages({
      token,
      channel: event.channel,
      threadTs
    });
  } catch (error) {
    console.warn("Falling back to current Slack event text:", error);
  }

  const reply = await createSlackReply(messages);

  if (!reply) {
    return;
  }

  await postSlackMessage({
    token,
    channel: event.channel,
    threadTs,
    text: reply
  });
}

export async function respondToSlackThreadReply(event: SlackMessageEvent) {
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  const thread = await loadSlackThread({
    token,
    channel: event.channel,
    threadTs: event.thread_ts
  });

  const botUserId = process.env.SLACK_BOT_USER_ID;
  const hasAssistantReply = thread.messages.some(
    (message) =>
      Boolean(message.bot_id) || (botUserId ? message.user === botUserId : false)
  );

  if (!hasAssistantReply) {
    return;
  }

  const reply = await createSlackReply(thread.modelMessages);

  if (!reply) {
    return;
  }

  await postSlackMessage({
    token,
    channel: event.channel,
    threadTs: event.thread_ts,
    text: reply
  });
}

async function loadSlackThreadAsModelMessages({
  token,
  channel,
  threadTs
}: {
  token: string;
  channel: string;
  threadTs: string;
}) {
  const thread = await loadSlackThread({ token, channel, threadTs });
  return thread.modelMessages;
}

async function loadSlackThread({
  token,
  channel,
  threadTs
}: {
  token: string;
  channel: string;
  threadTs: string;
}) {
  const response = await slackApi<SlackConversationRepliesResponse>({
    token,
    method: "GET",
    path: `conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}`
  });

  const botUserId = process.env.SLACK_BOT_USER_ID;

  const modelMessages = response.messages
    .map<ModelMessage | null>((message) => {
      const cleanedText = stripSlackFormatting(message.text).trim();
      if (!cleanedText) {
        return null;
      }

      const isAssistantMessage =
        Boolean(message.bot_id) || (botUserId ? message.user === botUserId : false);

      return {
        role: isAssistantMessage ? "assistant" : "user",
        content: cleanedText
      };
    })
    .filter((message): message is ModelMessage => message !== null);

  return {
    messages: response.messages,
    modelMessages
  };
}

async function postSlackMessage({
  token,
  channel,
  threadTs,
  text
}: {
  token: string;
  channel: string;
  threadTs: string;
  text: string;
}) {
  await slackApi<SlackPostMessageResponse>({
    token,
    method: "POST",
    path: "chat.postMessage",
    body: {
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true
    }
  });
}

async function slackApi<T extends { ok: boolean }>({
  token,
  method,
  path,
  body
}: {
  token: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}): Promise<Extract<T, { ok: true }>> {
  const response = await fetch(`https://slack.com/api/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
  });

  if (!response.ok) {
    throw new Error(`Slack API request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as T;

  if (!payload.ok) {
    throw new Error(`Slack API error: ${JSON.stringify(payload)}`);
  }

  return payload as Extract<T, { ok: true }>;
}

function stripSlackFormatting(input: string) {
  const botUserId = process.env.SLACK_BOT_USER_ID;

  return decodeSlackEntities(
    input
      .replace(botUserId ? new RegExp(`<@${botUserId}>`, "g") : /<@[A-Z0-9]+>/g, "")
      .replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeSlackEntities(input: string) {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function getHeader(headers: SlackHeaders, name: string) {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}
