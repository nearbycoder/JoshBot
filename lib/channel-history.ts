import { requireEnv } from "./env.js";

type SlackApiSuccess<T> = T & { ok: true };
type SlackApiFailure = { ok: false; error: string };

type SlackHistoryMessage = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
};

export type SlackChannelHistoryEntry = {
  ts: string;
  datetime: string;
  speaker: string;
  text: string;
};

type SlackConversationHistoryResponse =
  | SlackApiSuccess<{
      messages: SlackHistoryMessage[];
      has_more?: boolean;
      response_metadata?: {
        next_cursor?: string;
      };
    }>
  | SlackApiFailure;

export async function fetchSlackChannelHistory({
  channel,
  days,
  limit
}: {
  channel: string;
  days: number;
  limit: number;
}) {
  const token = requireEnv("SLACK_BOT_TOKEN");
  const oldest = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000).toString();
  const cappedLimit = Math.min(Math.max(limit, 1), 250);
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      channel,
      oldest,
      limit: Math.min(200, cappedLimit - messages.length).toString(),
      inclusive: "true"
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await slackApi<SlackConversationHistoryResponse>({
      token,
      path: `conversations.history?${params.toString()}`
    });

    messages.push(...response.messages);
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < cappedLimit);

  return messages
    .filter((message) => isSummarizableMessage(message))
    .slice(0, cappedLimit)
    .map((message) => ({
      ts: message.ts,
      datetime: new Date(Number(message.ts.split(".")[0] ?? "0") * 1000).toISOString(),
      speaker: message.user ? `User ${message.user}` : message.bot_id ? `Bot ${message.bot_id}` : "Unknown",
      text: normalizeSlackText(message.text ?? "")
    }))
    .filter((message) => message.text.length > 0);
}

async function slackApi<T extends { ok: boolean }>({
  token,
  path
}: {
  token: string;
  path: string;
}): Promise<Extract<T, { ok: true }>> {
  const response = await fetch(`https://slack.com/api/${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    }
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

function isSummarizableMessage(message: SlackHistoryMessage) {
  return Boolean(
    message.text &&
      message.type === "message" &&
      !message.subtype?.includes("join") &&
      !message.subtype?.includes("leave")
  );
}

function normalizeSlackText(input: string) {
  return decodeSlackEntities(
    input
      .replace(/<@([A-Z0-9]+)>/g, "@$1")
      .replace(/<#([CGD][A-Z0-9]+)\|([^>]+)>/g, "#$2")
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
