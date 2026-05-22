import crypto from "node:crypto";
import { type ModelMessage } from "ai";
import { createSlackReplyWithMemory } from "./ai.js";
import { requireEnv } from "./env.js";
import {
  addUserMemory,
  clearUserMemories,
  getUserMemories,
  removeUserMemory
} from "./memory.js";
import { getRedisClient } from "./redis.js";

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

type CachedThreadMessage = {
  role: "user" | "assistant";
  content: string;
  ts?: string;
  userId?: string;
};

const DEFAULT_SLACK_CONTEXT_MESSAGES = 12;
const DEFAULT_REDIS_THREAD_TTL_SECONDS = 60 * 60 * 24 * 7;

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

export function isDirectMentionToBot(text: string) {
  const botUserId = process.env.SLACK_BOT_USER_ID;

  if (!botUserId) {
    return false;
  }

  return new RegExp(`<@${botUserId}>`).test(text);
}

export async function respondToSlackMention(event: SlackMessageEvent) {
  const token = requireEnv("SLACK_BOT_TOKEN");
  const threadTs = event.thread_ts ?? event.ts;
  const incomingMessage = createCachedUserMessage(event);
  let threadMessages: CachedThreadMessage[] = [incomingMessage];
  const commandReply = await maybeHandleMemoryCommand(event);

  if (commandReply) {
    const postedReply = await postSlackMessage({
      token,
      channel: event.channel,
      threadTs,
      text: commandReply
    });

    await saveCachedThreadMessages(
      event.channel,
      threadTs,
      appendCachedThreadMessage(threadMessages, {
        role: "assistant",
        content: commandReply,
        ts: postedReply.ts
      })
    );
    return;
  }

  try {
    if (event.thread_ts && event.thread_ts !== event.ts) {
      threadMessages = await loadThreadMessagesForIncomingEvent({
        token,
        channel: event.channel,
        threadTs,
        incomingMessage
      });
    }
  } catch (error) {
    console.warn("Falling back to current Slack event text:", error);
  }

  const memories = event.user ? await getUserMemories(event.user) : [];
  const reply = await createSlackReplyWithMemory(
    toModelMessages(threadMessages, event.user),
    memories,
    event.user
  );

  if (!reply) {
    return;
  }

  const postedReply = await postSlackMessage({
    token,
    channel: event.channel,
    threadTs,
    text: reply
  });

  await saveCachedThreadMessages(
    event.channel,
    threadTs,
    appendCachedThreadMessage(threadMessages, {
      role: "assistant",
      content: reply,
      ts: postedReply.ts
    })
  );
}

export async function respondToSlackThreadReply(event: SlackMessageEvent) {
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  const incomingMessage = createCachedUserMessage(event);
  const commandReply = await maybeHandleMemoryCommand(event);
  const minimalThreadMessages = [incomingMessage];

  if (commandReply) {
    const postedReply = await postSlackMessage({
      token,
      channel: event.channel,
      threadTs: event.thread_ts,
      text: commandReply
    });

    await saveCachedThreadMessages(
      event.channel,
      event.thread_ts,
      appendCachedThreadMessage(minimalThreadMessages, {
        role: "assistant",
        content: commandReply,
        ts: postedReply.ts
      })
    );
    return;
  }

  const { threadMessages, hasAssistantReply } = await loadThreadMessagesForReply({
    token,
    channel: event.channel,
    threadTs: event.thread_ts,
    incomingMessage
  });

  if (!hasAssistantReply) {
    return;
  }

  const memories = event.user ? await getUserMemories(event.user) : [];
  const reply = await createSlackReplyWithMemory(
    toModelMessages(threadMessages, event.user),
    memories,
    event.user
  );

  if (!reply) {
    return;
  }

  const postedReply = await postSlackMessage({
    token,
    channel: event.channel,
    threadTs: event.thread_ts,
    text: reply
  });

  await saveCachedThreadMessages(
    event.channel,
    event.thread_ts,
    appendCachedThreadMessage(threadMessages, {
      role: "assistant",
      content: reply,
      ts: postedReply.ts
    })
  );
}

async function loadThreadMessagesForIncomingEvent({
  token,
  channel,
  threadTs,
  incomingMessage
}: {
  token: string;
  channel: string;
  threadTs: string;
  incomingMessage: CachedThreadMessage;
}) {
  const cachedMessages = await loadCachedThreadMessages(channel, threadTs);

  if (cachedMessages) {
    return appendCachedThreadMessage(cachedMessages, incomingMessage);
  }

  const thread = await loadSlackThread({ token, channel, threadTs });
  await saveCachedThreadMessages(channel, threadTs, thread.threadMessages);
  return thread.threadMessages;
}

async function loadThreadMessagesForReply({
  token,
  channel,
  threadTs,
  incomingMessage
}: {
  token: string;
  channel: string;
  threadTs: string;
  incomingMessage: CachedThreadMessage;
}) {
  const cachedMessages = await loadCachedThreadMessages(channel, threadTs);

  if (cachedMessages) {
    return {
      threadMessages: appendCachedThreadMessage(cachedMessages, incomingMessage),
      hasAssistantReply: cachedMessages.some((message) => message.role === "assistant")
    };
  }

  const thread = await loadSlackThread({ token, channel, threadTs });
  await saveCachedThreadMessages(channel, threadTs, thread.threadMessages);
  return thread;
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
  const threadMessages = trimThreadContext(
    response.messages
      .map<CachedThreadMessage | null>((message) => {
        const cleanedText = stripSlackFormatting(message.text).trim();
        if (!cleanedText) {
          return null;
        }

        const isAssistantMessage =
          Boolean(message.bot_id) || (botUserId ? message.user === botUserId : false);

        return {
          role: isAssistantMessage ? "assistant" : "user",
          content: cleanedText,
          ts: message.ts,
          userId: isAssistantMessage ? undefined : message.user
        };
      })
      .filter((message): message is CachedThreadMessage => message !== null)
  );

  return {
    threadMessages,
    hasAssistantReply: threadMessages.some((message) => message.role === "assistant")
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
  return slackApi<SlackPostMessageResponse>({
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

async function maybeHandleMemoryCommand(event: SlackMessageEvent) {
  if (!event.user) {
    return null;
  }

  const text = stripSlackFormatting(event.text);
  const trimmed = text.trim();

  const rememberMatch = trimmed.match(/^remember(?:\s+that)?\s+(.+)$/i);
  if (rememberMatch) {
    const result = await addUserMemory(event.user, rememberMatch[1] ?? "");

    if (!result.ok) {
      return `Couldn't save that memory: ${result.reason}`;
    }

    if (result.status === "exists") {
      return "I already had that in memory.";
    }

    return "Saved to memory.";
  }

  const forgetMatch = trimmed.match(/^forget(?:\s+that)?\s+(.+)$/i);
  if (forgetMatch) {
    const result = await removeUserMemory(event.user, forgetMatch[1] ?? "");

    if (!result.ok) {
      return `Couldn't update memory: ${result.reason}`;
    }

    if (result.status === "missing") {
      return "I didn't have that in memory.";
    }

    return "Removed from memory.";
  }

  if (/^(show|list)\s+(my\s+)?memory$/i.test(trimmed) || /^what do you remember about me\??$/i.test(trimmed)) {
    const memories = await getUserMemories(event.user);

    if (memories.length === 0) {
      return "I don't have any saved memory for you yet.";
    }

    return `Here's what I remember:\n${memories.map((memory) => `- ${memory}`).join("\n")}`;
  }

  if (/^(clear|reset)\s+(my\s+)?memory$/i.test(trimmed) || /^forget everything$/i.test(trimmed)) {
    const result = await clearUserMemories(event.user);

    if (!result.ok) {
      return `Couldn't clear memory: ${result.reason}`;
    }

    return "Cleared your saved memory.";
  }

  return null;
}

function createCachedUserMessage(event: SlackMessageEvent): CachedThreadMessage {
  return {
    role: "user",
    content: stripSlackFormatting(event.text),
    ts: event.ts,
    userId: event.user
  };
}

function appendCachedThreadMessage(
  messages: CachedThreadMessage[],
  message: CachedThreadMessage
) {
  const lastMessage = messages.at(-1);

  if (message.ts && lastMessage?.ts === message.ts) {
    return messages;
  }

  return trimThreadContext([...messages, message]);
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

function trimThreadContext(messages: CachedThreadMessage[]) {
  const maxMessages = getSlackContextMessageLimit();

  if (messages.length <= maxMessages) {
    return messages;
  }

  const rootMessage = messages[0];
  const recentMessages = messages.slice(-(maxMessages - 1));

  if (recentMessages.some((message) => message.ts === rootMessage.ts)) {
    return recentMessages;
  }

  return [rootMessage, ...recentMessages];
}

function toModelMessages(messages: CachedThreadMessage[], currentUserId: string | undefined): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      message.role === "user"
        ? `${formatSpeakerLabel(message.userId, currentUserId)}: ${message.content}`
        : message.content
  }));
}

async function loadCachedThreadMessages(channel: string, threadTs: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return null;
  }

  const payload = await redis.get(getThreadCacheKey(channel, threadTs));

  if (!payload) {
    return null;
  }

  const parsed = JSON.parse(payload) as { messages?: CachedThreadMessage[] };

  if (!Array.isArray(parsed.messages)) {
    return null;
  }

  return trimThreadContext(
    parsed.messages.filter(
      (message): message is CachedThreadMessage =>
        Boolean(
          message &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string" &&
            (message.userId === undefined || typeof message.userId === "string")
        )
    )
  );
}

async function saveCachedThreadMessages(
  channel: string,
  threadTs: string,
  messages: CachedThreadMessage[]
) {
  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  await redis.set(getThreadCacheKey(channel, threadTs), JSON.stringify({
    messages: trimThreadContext(messages)
  }), {
    expiration: {
      type: "EX",
      value: getRedisThreadTtlSeconds()
    }
  });
}

function getThreadCacheKey(channel: string, threadTs: string) {
  return `slack-thread:${channel}:${threadTs}`;
}

function getRedisThreadTtlSeconds() {
  const rawValue = process.env.REDIS_TTL_SECONDS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 60) {
    return DEFAULT_REDIS_THREAD_TTL_SECONDS;
  }

  return parsedValue;
}

function formatSpeakerLabel(userId: string | undefined, currentUserId: string | undefined) {
  if (!userId) {
    return "Unknown user";
  }

  if (currentUserId && userId === currentUserId) {
    return `Current user (${userId})`;
  }

  return `Other user (${userId})`;
}

function getSlackContextMessageLimit() {
  const rawValue = process.env.SLACK_CONTEXT_MESSAGES;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 2) {
    return DEFAULT_SLACK_CONTEXT_MESSAGES;
  }

  return parsedValue;
}
