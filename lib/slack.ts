import crypto from "node:crypto";
import {
  chooseSlackActiveListeningResponse,
  createSlackReplyWithMemory,
  shouldReplyToSlackThread
} from "./ai.js";
import { requireEnv } from "./env.js";
import {
  addUserMemory,
  appendChannelMemory,
  clearUserMemories,
  getChannelMemories,
  getUserMemories,
  removeUserMemory,
  type ChannelMemoryEntry
} from "./memory.js";
import { getRedisClient } from "./redis.js";
import { maybeHandleScheduleCommand } from "./schedules.js";
import { maybeHandleSlackSkillCommand } from "./skills.js";
import type { NoboModelMessage } from "./nobo-messages.js";

type SlackHeaders = Headers | Record<string, string | string[] | undefined>;

type SlackReply = {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
};

type SlackApiSuccess<T> = T & { ok: true };
type SlackApiFailure = { ok: false; error: string };

type SlackConversationRepliesResponse =
  | SlackApiSuccess<{ messages: SlackReply[] }>
  | SlackApiFailure;

type SlackPostMessageResponse =
  | SlackApiSuccess<{ channel: string; ts: string }>
  | SlackApiFailure;

type SlackUpdateMessageResponse =
  | SlackApiSuccess<{ channel: string; ts: string }>
  | SlackApiFailure;

type SlackReactionResponse =
  | SlackApiSuccess<Record<string, never>>
  | SlackApiFailure;

type SlackConversation = {
  id: string;
  name?: string;
};

type SlackConversationsListResponse =
  | SlackApiSuccess<{
      channels: SlackConversation[];
      response_metadata?: {
        next_cursor?: string;
      };
    }>
  | SlackApiFailure;

type SlackReplyPost = {
  ts?: string;
};

type SlackReplyStreamer = {
  start: () => Promise<void>;
  append: (delta: string) => Promise<void>;
  finish: (finalText: string) => Promise<SlackReplyPost>;
  fail: (notice?: string) => Promise<void>;
};

type SlackBlock = Record<string, unknown>;

type SlackMessageEvent = {
  channel: string;
  channel_type?: string;
  text: string;
  thread_ts?: string;
  ts: string;
  team_id?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
};

type CachedThreadMessage = {
  role: "user" | "assistant";
  content: string;
  ts?: string;
  userId?: string;
};

type SlackFile = {
  id: string;
  mode?: string;
  file_access?: string;
  title?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  preview?: string;
  preview_plain_text?: string;
  plain_text?: string;
  contents?: string;
  alt_txt?: string;
  permalink?: string;
  external_url?: string | null;
  url_private?: string;
  url_private_download?: string;
  initial_comment?: {
    comment?: string;
  };
};

type SlackFileInfoResponse =
  | SlackApiSuccess<{ file: SlackFile }>
  | SlackApiFailure;

const DEFAULT_SLACK_CONTEXT_MESSAGES = 12;
const DEFAULT_REDIS_THREAD_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_SLACK_EVENT_LOCK_TTL_SECONDS = 60 * 10;
const DEFAULT_SLACK_STREAM_BUFFER_SIZE = 128;
const DEFAULT_SLACK_STREAM_UPDATE_INTERVAL_MS = 750;
const DEFAULT_SLACK_LISTENING_ANIMATION_INTERVAL_MS = 1000;
const DEFAULT_SLACK_LISTENING_MESSAGE = "Thinking...";
const DEFAULT_SLACK_ACK_REACTION = "eyes";
const DEFAULT_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES = 3;
const SLACK_SECTION_BLOCK_TEXT_LIMIT = 2900;
const SLACK_MAX_BLOCKS = 50;
const STREAM_FAILURE_NOTICE = "I hit an error before I could finish this reply.";
const MAX_SLACK_IMAGE_BYTES = 5 * 1024 * 1024;
const localEventLocks = new Map<string, number>();
const activeListeningReplyCounts = new Map<string, number>();

export function verifySlackRequest(body: string, headers: SlackHeaders) {
  const signature = getHeader(headers, "x-slack-signature");
  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signature || !timestamp || !signingSecret) {
    return false;
  }

  if (!signature.startsWith("v0=")) {
    return false;
  }

  const ageInSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageInSeconds) || ageInSeconds > 60 * 5) {
    return false;
  }

  const payload = `v0:${timestamp}:${body}`;
  const digest = crypto.createHmac("sha256", signingSecret).update(payload).digest("hex");
  const expected = `v0=${digest}`;

  if (expected.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function isIgnorableSlackEvent(event: SlackMessageEvent) {
  return Boolean(event.bot_id || (event.subtype && event.subtype !== "file_share"));
}

export function isDirectMentionToBot(text: string) {
  const botUserId = process.env.SLACK_BOT_USER_ID;

  if (!botUserId) {
    return false;
  }

  return new RegExp(`<@${botUserId}>`).test(text);
}

export function isSlackDirectMessage(event: SlackMessageEvent) {
  return event.channel_type === "im" || event.channel.startsWith("D");
}

export async function respondToSlackMention(event: SlackMessageEvent) {
  const lock = await acquireSlackEventLock(event, "mention");
  if (!lock.acquired) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  void acknowledgeTargetedSlackEvent(token, event);
  const threadTs = event.thread_ts ?? event.ts;
  const incomingMessage = await createCachedUserMessage(token, event);
  let threadMessages: CachedThreadMessage[] = [incomingMessage];
  const channelMemories = await loadChannelMemories(event.channel);
  await recordUserChannelMemory(event, incomingMessage, threadTs);
  const commandReply = await maybeHandleMemoryCommand(event);
  const scheduleReply = commandReply ? null : await maybeHandleScheduleCommand(event);

  if (commandReply || scheduleReply) {
    const replyText = commandReply ?? scheduleReply ?? "";
    const postedReply = await postSlackMessage({
      token,
      channel: event.channel,
      threadTs,
      text: replyText
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs,
      text: replyText,
      ts: postedReply.ts
    });

    await saveCachedThreadMessages(
      event.channel,
      threadTs,
      appendCachedThreadMessage(threadMessages, {
        role: "assistant",
        content: replyText,
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
    console.warn(`Falling back to current Slack event text: ${summarizeError(error)}`);
  }

  const memories = event.user ? await getUserMemories(event.user) : [];
  const modelMessages = await toModelMessages(threadMessages, event.user, {
    token,
    liveEvent: event
  });
  const skillStream = createSlackReplyStreamer({
    token,
    channel: event.channel,
    threadTs
  });
  let skillReply: string | null;

  try {
    skillReply = await maybeHandleSlackSkillCommand({
      commandText: stripSlackFormatting(event.text),
      modelMessages,
      memories,
      currentUserId: event.user,
      channelMemories,
      channelId: event.channel,
      onTextDelta: skillStream?.append,
      beforeModelReply: skillStream.start
    });
  } catch (error) {
    await skillStream?.fail();
    throw error;
  }

  if (skillReply) {
    const postedReply = await finishSlackReply({
      token,
      channel: event.channel,
      threadTs,
      text: skillReply,
      stream: skillStream
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs,
      text: skillReply,
      ts: postedReply.ts
    });

    await saveCachedThreadMessages(
      event.channel,
      threadTs,
      appendCachedThreadMessage(threadMessages, {
        role: "assistant",
        content: skillReply,
        ts: postedReply.ts
      })
    );
    return;
  }

  const replyStream = createSlackReplyStreamer({
    token,
    channel: event.channel,
    threadTs
  });
  let reply: string | null;

  try {
    await replyStream.start();
    reply = await createReplyForSlackEvent({
      token,
      threadMessages,
      event,
      memories,
      modelMessages,
      channelMemories,
      channelId: event.channel,
      onTextDelta: replyStream?.append
    });
  } catch (error) {
    await replyStream?.fail();
    throw error;
  }

  if (!reply) {
    return;
  }

  const postedReply = await finishSlackReply({
    token,
    channel: event.channel,
    threadTs,
    text: reply,
    stream: replyStream
  });
  await recordAssistantChannelMemory({
    channel: event.channel,
    threadTs,
    text: reply,
    ts: postedReply.ts
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

  const lock = await acquireSlackEventLock(event, "thread-reply");
  if (!lock.acquired) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  const incomingMessage = await createCachedUserMessage(token, event);
  const commandReply = await maybeHandleMemoryCommand(event);
  const minimalThreadMessages = [incomingMessage];

  if (commandReply) {
    void acknowledgeTargetedSlackEvent(token, event);
    await recordUserChannelMemory(event, incomingMessage, event.thread_ts);
    const postedReply = await postSlackMessage({
      token,
      channel: event.channel,
      threadTs: event.thread_ts,
      text: commandReply
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs: event.thread_ts,
      text: commandReply,
      ts: postedReply.ts
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

  const channelMemories = await loadChannelMemories(event.channel);
  await recordUserChannelMemory(event, incomingMessage, event.thread_ts);
  const scheduleReply = await maybeHandleScheduleCommand(event);

  if (scheduleReply) {
    void acknowledgeTargetedSlackEvent(token, event);
    const postedReply = await postSlackMessage({
      token,
      channel: event.channel,
      threadTs: event.thread_ts,
      text: scheduleReply
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs: event.thread_ts,
      text: scheduleReply,
      ts: postedReply.ts
    });

    await saveCachedThreadMessages(
      event.channel,
      event.thread_ts,
      appendCachedThreadMessage(threadMessages, {
        role: "assistant",
        content: scheduleReply,
        ts: postedReply.ts
      })
    );
    return;
  }

  const memories = event.user ? await getUserMemories(event.user) : [];
  const modelMessages = await toModelMessages(threadMessages, event.user, {
    token,
    liveEvent: event
  });
  const shouldReply = await shouldReplyToSlackThread({
    messages: modelMessages,
    currentUserId: event.user,
    channelMemories,
    channelId: event.channel
  });

  if (!shouldReply) {
    await saveCachedThreadMessages(event.channel, event.thread_ts, threadMessages);
    return;
  }

  void acknowledgeTargetedSlackEvent(token, event);
  const replyStream = createSlackReplyStreamer({
    token,
    channel: event.channel,
    threadTs: event.thread_ts
  });
  let reply: string | null;

  try {
    await replyStream.start();
    reply = await createReplyForSlackEvent({
      token,
      threadMessages,
      event,
      memories,
      modelMessages,
      channelMemories,
      channelId: event.channel,
      onTextDelta: replyStream?.append
    });
  } catch (error) {
    await replyStream?.fail();
    throw error;
  }

  if (!reply) {
    return;
  }

  const postedReply = await finishSlackReply({
    token,
    channel: event.channel,
    threadTs: event.thread_ts,
    text: reply,
    stream: replyStream
  });
  await recordAssistantChannelMemory({
    channel: event.channel,
    threadTs: event.thread_ts,
    text: reply,
    ts: postedReply.ts
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

export async function respondToSlackActiveListeningMessage(event: SlackMessageEvent) {
  const lock = await acquireSlackEventLock(event, "active-listening");
  if (!lock.acquired) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  const threadTs = event.thread_ts ?? event.ts;
  const allowInline = !event.thread_ts || event.thread_ts === event.ts;
  const incomingMessage = await createCachedUserMessage(token, event);
  let threadMessages: CachedThreadMessage[] = [incomingMessage];
  const channelMemories = await loadChannelMemories(event.channel);
  await recordUserChannelMemory(event, incomingMessage, threadTs);

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
    console.warn(`Falling back to current Slack event text: ${summarizeError(error)}`);
  }

  const memories = event.user ? await getUserMemories(event.user) : [];
  const modelMessages = await toModelMessages(threadMessages, event.user, {
    token,
    liveEvent: event
  });
  const replySlot = acquireActiveListeningReplySlot(event.channel);

  if (!replySlot.acquired) {
    if (event.thread_ts) {
      await saveCachedThreadMessages(event.channel, event.thread_ts, threadMessages);
    }
    return;
  }

  try {
    const responseMode = await chooseSlackActiveListeningResponse({
      messages: modelMessages,
      currentUserId: event.user,
      channelMemories,
      channelId: event.channel,
      allowInline
    });

    if (responseMode === "silent") {
      if (event.thread_ts) {
        await saveCachedThreadMessages(event.channel, event.thread_ts, threadMessages);
      }
      return;
    }

    void acknowledgeTargetedSlackEvent(token, event);
    const replyThreadTs = responseMode === "thread" ? threadTs : undefined;
    const replyStream = createSlackReplyStreamer({
      token,
      channel: event.channel,
      threadTs: replyThreadTs
    });
    let reply: string | null;

    try {
      await replyStream.start();
      reply = await createReplyForSlackEvent({
        token,
        threadMessages,
        event,
        memories,
        modelMessages,
        channelMemories,
        channelId: event.channel,
        onTextDelta: replyStream?.append
      });
    } catch (error) {
      await replyStream?.fail();
      throw error;
    }

    if (!reply) {
      return;
    }

    const postedReply = await finishSlackReply({
      token,
      channel: event.channel,
      threadTs: replyThreadTs,
      text: reply,
      stream: replyStream
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs: replyThreadTs ?? postedReply.ts,
      text: reply,
      ts: postedReply.ts
    });

    if (replyThreadTs) {
      await saveCachedThreadMessages(
        event.channel,
        replyThreadTs,
        appendCachedThreadMessage(threadMessages, {
          role: "assistant",
          content: reply,
          ts: postedReply.ts
        })
      );
    }
  } finally {
    replySlot.release();
  }
}

export async function respondToSlackDirectMessage(event: SlackMessageEvent) {
  const lock = await acquireSlackEventLock(event, "direct-message");
  if (!lock.acquired) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  void acknowledgeTargetedSlackEvent(token, event);
  const incomingMessage = await createCachedUserMessage(token, event);
  const threadMessages: CachedThreadMessage[] = [incomingMessage];
  const channelMemories = await loadChannelMemories(event.channel);
  await recordUserChannelMemory(event, incomingMessage, event.ts);
  const commandReply = await maybeHandleMemoryCommand(event);
  const scheduleReply = commandReply ? null : await maybeHandleScheduleCommand(event);

  if (commandReply || scheduleReply) {
    const replyText = commandReply ?? scheduleReply ?? "";
    const postedReply = await postSlackMessage({
      token,
      channel: event.channel,
      text: replyText
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs: event.ts,
      text: replyText,
      ts: postedReply.ts
    });

    await saveCachedThreadMessages(
      event.channel,
      event.ts,
      appendCachedThreadMessage(threadMessages, {
        role: "assistant",
        content: replyText,
        ts: postedReply.ts
      })
    );
    return;
  }

  const replyStream = createSlackReplyStreamer({
    token,
    channel: event.channel
  });
  let replyText: string | null;

  try {
    await replyStream.start();
    replyText = await createReplyForSlackEvent({
      token,
      threadMessages,
      event,
      memories: event.user ? await getUserMemories(event.user) : [],
      channelMemories,
      channelId: event.channel,
      onTextDelta: replyStream?.append
    });
  } catch (error) {
    await replyStream?.fail();
    throw error;
  }

  if (!replyText) {
    return;
  }

  const postedReply = await finishSlackReply({
    token,
    channel: event.channel,
    text: replyText,
    stream: replyStream
  });
  await recordAssistantChannelMemory({
    channel: event.channel,
    threadTs: event.ts,
    text: replyText,
    ts: postedReply.ts
  });

  await saveCachedThreadMessages(
    event.channel,
    event.ts,
    appendCachedThreadMessage(threadMessages, {
      role: "assistant",
      content: replyText,
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
  const rawThreadMessages: Array<CachedThreadMessage | null> = await Promise.all(
    response.messages.map(async (message) => {
      const normalizedContent = await buildSlackMessageContent(token, {
        text: message.text,
        files: message.files
      });

      if (!normalizedContent) {
        return null;
      }

      const isAssistantMessage =
        Boolean(message.bot_id) || (botUserId ? message.user === botUserId : false);

      const cachedMessage: CachedThreadMessage = {
        role: isAssistantMessage ? "assistant" : "user",
        content: normalizedContent,
        ts: message.ts,
        userId: isAssistantMessage ? undefined : message.user
      };

      return cachedMessage;
    })
  );
  const threadMessages = trimThreadContext(
    rawThreadMessages.filter((message): message is CachedThreadMessage => message !== null)
  );

  return {
    threadMessages,
    hasAssistantReply: threadMessages.some((message) => message.role === "assistant")
  };
}

export async function postSlackMessage({
  token,
  channel,
  threadTs,
  text,
  blocks
}: {
  token: string;
  channel: string;
  threadTs?: string;
  text: string;
  blocks?: SlackBlock[];
}) {
  return slackApi<SlackPostMessageResponse>({
    token,
    method: "POST",
    path: "chat.postMessage",
    body: {
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text,
      ...(blocks ? { blocks } : {}),
      mrkdwn: true
    }
  });
}

export async function postGeneratedSlackMessage({
  channel,
  threadTs,
  createReply
}: {
  channel: string;
  threadTs?: string;
  createReply: (onTextDelta: (delta: string) => Promise<void>) => Promise<string | null>;
}) {
  const token = requireEnv("SLACK_BOT_TOKEN");
  const stream = createSlackReplyStreamer({
    token,
    channel,
    threadTs
  });
  let replyText: string | null;

  try {
    await stream.start();
    replyText = await createReply(stream.append);
  } catch (error) {
    await stream.fail();
    throw error;
  }

  if (!replyText) {
    await stream.fail("I couldn't generate a reply for that command.");
    return null;
  }

  const postedReply = await finishSlackReply({
    token,
    channel,
    threadTs,
    text: replyText,
    stream
  });
  await recordAssistantChannelMemory({
    channel,
    threadTs,
    text: replyText,
    ts: postedReply.ts
  });

  return {
    ...postedReply,
    text: replyText
  };
}

export async function resolveSlackChannelIdByName({
  token,
  name
}: {
  token: string;
  name: string;
}) {
  const normalizedName = name.trim().replace(/^#/, "").toLowerCase();
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      exclude_archived: "true",
      limit: "200",
      types: "public_channel,private_channel",
      ...(cursor ? { cursor } : {})
    });
    const response = await slackApi<SlackConversationsListResponse>({
      token,
      method: "GET",
      path: `conversations.list?${params.toString()}`
    });
    const channel = response.channels.find(
      (candidate) => candidate.name?.toLowerCase() === normalizedName
    );

    if (channel) {
      return channel.id;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return null;
}

async function finishSlackReply({
  token,
  channel,
  threadTs,
  text,
  stream
}: {
  token: string;
  channel: string;
  threadTs?: string;
  text: string;
  stream?: SlackReplyStreamer | null;
}) {
  if (stream) {
    return stream.finish(text);
  }

  return postSlackMessage({
    token,
    channel,
    threadTs,
    text
  });
}

async function updateSlackMessage({
  token,
  channel,
  ts,
  text,
  blocks
}: {
  token: string;
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
}) {
  return slackApi<SlackUpdateMessageResponse>({
    token,
    method: "POST",
    path: "chat.update",
    body: {
      channel,
      ts,
      text,
      ...(blocks ? { blocks } : {}),
      mrkdwn: true
    }
  });
}

async function acknowledgeTargetedSlackEvent(token: string, event: SlackMessageEvent) {
  const reaction = getSlackAckReactionName();

  if (!reaction) {
    return;
  }

  try {
    await addSlackReaction({
      token,
      channel: event.channel,
      ts: event.ts,
      name: reaction
    });
  } catch (error) {
    const summary = summarizeError(error);

    if (summary.includes("already_reacted")) {
      return;
    }

    console.warn(`Unable to add Slack acknowledgement reaction: ${summary}`);
  }
}

async function addSlackReaction({
  token,
  channel,
  ts,
  name
}: {
  token: string;
  channel: string;
  ts: string;
  name: string;
}) {
  return slackApi<SlackReactionResponse>({
    token,
    method: "POST",
    path: "reactions.add",
    body: {
      channel,
      timestamp: ts,
      name
    }
  });
}

function createSlackReplyStreamer({
  token,
  channel,
  threadTs
}: {
  token: string;
  channel: string;
  threadTs?: string;
}): SlackReplyStreamer {
  let streamedText = "";
  let postedText = "";
  let messageTs: string | undefined;
  let startPromise: Promise<void> | null = null;
  let updatePromise = Promise.resolve();
  let listeningAnimationTimer: ReturnType<typeof setInterval> | null = null;
  let listeningAnimationFrame = 0;
  let lastUpdateAt = 0;
  let hasPostedModelText = false;
  let failed = false;

  const postFinalMessage = (finalText: string) =>
    postSlackMessage({
      token,
      channel,
      threadTs,
      text: finalText
    });

  const updateStartedReply = async (text: string, force = false) => {
    await startReply();

    if (!messageTs || failed || (!force && !shouldUpdatePostedText(text))) {
      return;
    }

    const ts = messageTs;
    postedText = text;
    lastUpdateAt = Date.now();
    updatePromise = updatePromise
      .then(() =>
        updateSlackMessage({
          token,
          channel,
          ts,
          text,
          blocks: createSlackTextBlocks(text)
        })
      )
      .then(() => undefined)
      .catch((error) => {
        failed = true;
        console.warn(`Unable to update streamed Slack reply: ${summarizeError(error)}`);
      });
    await updatePromise;
  };

  const updateListeningMessage = (text: string) => {
    if (!messageTs || failed || hasPostedModelText) {
      return;
    }

    const ts = messageTs;
    postedText = text;
    lastUpdateAt = Date.now();
    updatePromise = updatePromise
      .then(() =>
        updateSlackMessage({
          token,
          channel,
          ts,
          text,
          blocks: createSlackTextBlocks(text)
        })
      )
      .then(() => undefined)
      .catch((error) => {
        stopListeningAnimation();
        console.warn(`Unable to animate Slack listening message: ${summarizeError(error)}`);
      });
  };

  const shouldUpdatePostedText = (text: string) => {
    if (!postedText || postedText === getSlackListeningMessage()) {
      return true;
    }

    if (text.length - postedText.length >= getSlackStreamBufferSize()) {
      return true;
    }

    return Date.now() - lastUpdateAt >= getSlackStreamUpdateIntervalMs();
  };

  const startListeningAnimation = () => {
    if (listeningAnimationTimer || failed) {
      return;
    }

    const frames = getSlackListeningAnimationFrames();
    listeningAnimationTimer = setInterval(() => {
      listeningAnimationFrame = (listeningAnimationFrame + 1) % frames.length;
      updateListeningMessage(frames[listeningAnimationFrame] ?? getSlackListeningMessage());
    }, getSlackListeningAnimationIntervalMs());
  };

  const stopListeningAnimation = () => {
    if (listeningAnimationTimer) {
      clearInterval(listeningAnimationTimer);
      listeningAnimationTimer = null;
    }
  };

  const startReply = async () => {
    if (startPromise) {
      return startPromise;
    }

    startPromise = postSlackMessage({
      token,
      channel,
      threadTs,
      text: getSlackInitialListeningFrame(),
      blocks: createSlackTextBlocks(getSlackInitialListeningFrame())
    })
      .then((response) => {
        messageTs = response.ts;
        postedText = getSlackInitialListeningFrame();
        lastUpdateAt = Date.now();
        startListeningAnimation();
      })
      .catch((error) => {
        failed = true;
        console.warn(`Unable to post Slack listening message: ${summarizeError(error)}`);
      });

    return startPromise;
  };

  const finalizeStartedReply = async (finalText: string, ts: string) => {
    try {
      stopListeningAnimation();
      await updatePromise;
      await updateSlackMessage({
        token,
        channel,
        ts,
        text: finalText,
        blocks: createSlackTextBlocks(finalText)
      });
      postedText = finalText;
    } catch (error) {
      console.warn(`Unable to finalize streamed Slack reply: ${summarizeError(error)}`);
    }

    return { ts };
  };

  return {
    start: startReply,
    async append(delta: string) {
      if (!delta || failed) {
        return;
      }

      streamedText += delta;

      if (!hasPostedModelText) {
        hasPostedModelText = true;
        stopListeningAnimation();
        await updateStartedReply(streamedText, true);
        return;
      }

      await updateStartedReply(streamedText);
    },
    async finish(finalText: string) {
      if (!messageTs && !startPromise) {
        return postFinalMessage(finalText);
      }

      await startReply();
      await updatePromise;

      if (messageTs) {
        return finalizeStartedReply(finalText, messageTs);
      }

      return postFinalMessage(finalText);
    },
    async fail(notice = STREAM_FAILURE_NOTICE) {
      stopListeningAnimation();

      if (!messageTs && !startPromise) {
        return;
      }

      await startReply();
      await updatePromise;

      if (messageTs) {
        await finalizeStartedReply(notice, messageTs);
      }
    }
  };
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

    if (result.status === "ambiguous") {
      return `That matched more than one memory. Try again with the exact text or a number from \`show my memory\`:\n${result.matches.map((match) => `${match.index + 1}. ${match.memory}`).join("\n")}`;
    }

    return `Removed from memory: ${result.removed}`;
  }

  if (/^(show|list)\s+(my\s+)?memory$/i.test(trimmed) || /^what do you remember about me\??$/i.test(trimmed)) {
    const memories = await getUserMemories(event.user);

    if (memories.length === 0) {
      return "I don't have any saved memory for you yet.";
    }

    return `Here's what I remember:\n${memories.map((memory, index) => `${index + 1}. ${memory}`).join("\n")}`;
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

async function createCachedUserMessage(token: string, event: SlackMessageEvent): Promise<CachedThreadMessage> {
  return {
    role: "user",
    content: await buildSlackMessageContent(token, event),
    ts: event.ts,
    userId: event.user
  };
}

async function loadChannelMemories(channel: string) {
  try {
    return await getChannelMemories(channel);
  } catch (error) {
    console.warn(`Unable to load Slack channel memory: ${summarizeError(error)}`);
    return [];
  }
}

async function recordUserChannelMemory(
  event: SlackMessageEvent,
  message: CachedThreadMessage,
  threadTs: string
) {
  await safeAppendChannelMemory(event.channel, {
    role: "user",
    content: message.content,
    ts: message.ts,
    threadTs,
    userId: message.userId
  });
}

async function recordAssistantChannelMemory({
  channel,
  threadTs,
  text,
  ts
}: {
  channel: string;
  threadTs?: string;
  text: string;
  ts?: string;
}) {
  await safeAppendChannelMemory(channel, {
    role: "assistant",
    content: text,
    ts,
    threadTs
  });
}

async function safeAppendChannelMemory(channel: string, entry: ChannelMemoryEntry) {
  try {
    await appendChannelMemory(channel, entry);
  } catch (error) {
    console.warn(`Unable to append Slack channel memory: ${summarizeError(error)}`);
  }
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

async function createReplyForSlackEvent({
  token,
  threadMessages,
  event,
  memories,
  modelMessages,
  channelMemories,
  channelId,
  onTextDelta
}: {
  token: string;
  threadMessages: CachedThreadMessage[];
  event: SlackMessageEvent;
  memories: string[];
  modelMessages?: NoboModelMessage[];
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  try {
    const multimodalMessages =
      modelMessages ??
      (await toModelMessages(threadMessages, event.user, {
        token,
        liveEvent: event
      }));

    return await createSlackReplyWithMemory(
      multimodalMessages,
      memories,
      event.user,
      getScheduleContext(event),
      { onTextDelta, channelMemories, channelId }
    );
  } catch (error) {
    if (!hasImageAttachments(event)) {
      throw error;
    }

    console.warn(`Falling back to text-only Slack attachment context: ${summarizeError(error)}`);

    const attachmentErrorMessage = explainImageAttachmentError(error);
    if (attachmentErrorMessage) {
      return attachmentErrorMessage;
    }

    const fallbackReply = await createSlackReplyWithMemory(
      await toModelMessages(threadMessages, event.user),
      memories,
      event.user,
      getScheduleContext(event),
      { onTextDelta, channelMemories, channelId }
    );

    if (!fallbackReply) {
      return "I saw the image attachment, but I couldn't inspect the image directly with the current model configuration.";
    }

    return `I saw the image attachment, but I couldn't inspect the image directly with the current model configuration.\n\n${fallbackReply}`;
  }
}

async function buildSlackMessageContent(
  token: string,
  message: {
    text?: string;
    files?: SlackFile[];
  }
) {
  const text = stripSlackFormatting(message.text ?? "");
  const files = await enrichSlackFiles(token, message.files ?? []);
  const fileContext = files.map(formatSlackFileForModel).filter(Boolean).join("\n");

  return [text, fileContext].filter(Boolean).join("\n\n").trim();
}

async function enrichSlackFiles(token: string, files: SlackFile[]) {
  return Promise.all(
    files.map(async (file) => {
      if (file.file_access !== "check_file_info") {
        return file;
      }

      try {
        const response = await slackApi<SlackFileInfoResponse>({
          token,
          method: "GET",
          path: `files.info?file=${encodeURIComponent(file.id)}`
        });

        return response.file;
      } catch (error) {
        console.warn(`Unable to hydrate Slack file ${file.id}: ${summarizeError(error)}`);
        return file;
      }
    })
  );
}

function formatSlackFileForModel(file: SlackFile) {
  const title = file.title || file.name || file.id;
  const typeLabel = file.pretty_type || file.filetype || file.mimetype || "file";
  const parts = [`Attached ${typeLabel}: ${title}`];

  const preview =
    file.plain_text ||
    file.preview_plain_text ||
    file.preview ||
    file.contents ||
    file.alt_txt ||
    file.initial_comment?.comment ||
    "";

  if (preview) {
    parts.push(`Attachment details: ${collapseWhitespace(preview).slice(0, 1200)}`);
  }

  const link = file.external_url || file.permalink;
  if (link) {
    parts.push(`Attachment link: ${link}`);
  }

  return parts.join("\n");
}

function decodeSlackEntities(input: string) {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function createSlackTextBlocks(text: string): SlackBlock[] {
  return splitSlackSectionBlockText(text).map((chunk) => ({
    type: "section",
    expand: true,
    text: {
      type: "mrkdwn",
      text: chunk
    }
  }));
}

function splitSlackSectionBlockText(input: string) {
  const chunks: string[] = [];
  let current = "";
  const lines = (input || " ").split("\n");

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    chunks.push(current);
    current = "";
  };

  for (const line of lines) {
    let remaining = line;

    while (remaining.length > SLACK_SECTION_BLOCK_TEXT_LIMIT) {
      const slice = remaining.slice(0, SLACK_SECTION_BLOCK_TEXT_LIMIT);
      const candidate = current ? `${current}\n${slice}` : slice;

      if (candidate.length > SLACK_SECTION_BLOCK_TEXT_LIMIT) {
        pushCurrent();
        chunks.push(slice);
      } else {
        chunks.push(candidate);
        current = "";
      }

      remaining = remaining.slice(SLACK_SECTION_BLOCK_TEXT_LIMIT);
    }

    const candidate = current ? `${current}\n${remaining}` : remaining;

    if (candidate.length > SLACK_SECTION_BLOCK_TEXT_LIMIT) {
      pushCurrent();
      current = remaining;
    } else {
      current = candidate;
    }
  }

  pushCurrent();

  if (chunks.length === 0) {
    chunks.push(" ");
  }

  if (chunks.length <= SLACK_MAX_BLOCKS) {
    return chunks;
  }

  const visibleChunks = chunks.slice(0, SLACK_MAX_BLOCKS);
  const lastChunk = visibleChunks[visibleChunks.length - 1] ?? "";
  visibleChunks[visibleChunks.length - 1] = `${lastChunk.slice(0, SLACK_SECTION_BLOCK_TEXT_LIMIT - 20)}\n...`;
  return visibleChunks;
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

async function toModelMessages(
  messages: CachedThreadMessage[],
  currentUserId: string | undefined,
  options?: {
    token?: string;
    liveEvent?: SlackMessageEvent;
  }
): Promise<NoboModelMessage[]> {
  const liveEvent = options?.liveEvent;
  const liveEventTs = liveEvent?.ts;
  const liveUserContent =
    liveEvent && options?.token
      ? await buildLiveUserContent(options.token, liveEvent, currentUserId)
      : null;

  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content
      };
    }

    if (liveEventTs && liveUserContent && message.ts === liveEventTs) {
      return {
        role: "user",
        content: liveUserContent
      };
    }

    return {
      role: "user",
      content: `${formatSpeakerLabel(message.userId, currentUserId)}: ${message.content}`
    };
  });
}

async function buildLiveUserContent(
  token: string,
  event: SlackMessageEvent,
  currentUserId: string | undefined
) {
  const files = await enrichSlackFiles(token, event.files ?? []);
  const speakerLabel = formatSpeakerLabel(event.user, currentUserId);
  const text = stripSlackFormatting(event.text ?? "");
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: Buffer; mediaType?: string }
  > = [];

  if (text) {
    parts.push({
      type: "text",
      text: `${speakerLabel}: ${text}`
    });
  } else if (files.length > 0) {
    parts.push({
      type: "text",
      text: `${speakerLabel}: shared attachment${files.length === 1 ? "" : "s"}.`
    });
  }

  for (const file of files) {
    const imagePart = await buildSlackImagePart(token, file);

    if (imagePart) {
      parts.push(imagePart);
    }

    const fileSummary = formatSlackFileForModel(file);
    if (fileSummary) {
      parts.push({
        type: "text",
        text: fileSummary
      });
    }
  }

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }

  return parts;
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

async function acquireSlackEventLock(event: SlackMessageEvent, eventType: string) {
  const key = getSlackEventLockKey(event, eventType);
  const ttlSeconds = getSlackEventLockTtlSeconds();
  const redis = await getRedisClient();

  if (redis) {
    const result = await redis.set(key, "1", {
      condition: "NX",
      expiration: {
        type: "EX",
        value: ttlSeconds
      }
    });

    return { acquired: result === "OK" };
  }

  pruneLocalEventLocks();

  if (localEventLocks.has(key)) {
    return { acquired: false };
  }

  localEventLocks.set(key, Date.now() + ttlSeconds * 1000);
  return { acquired: true };
}

function getSlackEventLockKey(event: SlackMessageEvent, eventType: string) {
  const threadTs = event.thread_ts ?? event.ts;
  return `slack-event-lock:${event.channel}:${threadTs}:${event.ts}`;
}

function getSlackEventLockTtlSeconds() {
  const rawValue = process.env.SLACK_EVENT_LOCK_TTL_SECONDS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 60) {
    return DEFAULT_SLACK_EVENT_LOCK_TTL_SECONDS;
  }

  return parsedValue;
}

function acquireActiveListeningReplySlot(channel: string) {
  const currentCount = activeListeningReplyCounts.get(channel) ?? 0;
  const maxCount = getActiveListeningMaxConcurrentReplies();

  if (currentCount >= maxCount) {
    return {
      acquired: false as const,
      release() {}
    };
  }

  activeListeningReplyCounts.set(channel, currentCount + 1);
  let released = false;

  return {
    acquired: true as const,
    release() {
      if (released) {
        return;
      }

      released = true;
      const nextCount = (activeListeningReplyCounts.get(channel) ?? 1) - 1;

      if (nextCount <= 0) {
        activeListeningReplyCounts.delete(channel);
        return;
      }

      activeListeningReplyCounts.set(channel, nextCount);
    }
  };
}

function getActiveListeningMaxConcurrentReplies() {
  const rawValue = process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES;
  }

  return Math.min(parsedValue, 10);
}

function pruneLocalEventLocks() {
  const now = Date.now();

  for (const [key, expiresAt] of localEventLocks) {
    if (expiresAt <= now) {
      localEventLocks.delete(key);
    }
  }
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

function getScheduleContext(event: SlackMessageEvent) {
  if (!event.user) {
    return undefined;
  }

  return {
    ownerUserId: event.user,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    sourceTs: event.ts,
    mentionedChannels: extractMentionedChannels(event.text)
  };
}

function extractMentionedChannels(input: string) {
  return Array.from(input.matchAll(/<#([CGD][A-Z0-9]+)(?:\|([^>]+))?>/gi)).map((match) => ({
    id: (match[1] ?? "").toUpperCase(),
    name: match[2]
  }));
}

function hasImageAttachments(event: SlackMessageEvent) {
  return (event.files ?? []).some((file) => file.mimetype?.startsWith("image/"));
}

async function buildSlackImagePart(token: string, file: SlackFile) {
  if (!file.mimetype?.startsWith("image/")) {
    return null;
  }

  const url = file.url_private_download || file.url_private;

  if (!url) {
    return null;
  }

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Slack file download failed with HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_SLACK_IMAGE_BYTES) {
    console.warn(`Skipping Slack image ${file.id}: file too large (${contentLength} bytes)`);
    return null;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";

  if (bytes.byteLength > MAX_SLACK_IMAGE_BYTES) {
    console.warn(`Skipping Slack image ${file.id}: file too large after download`);
    return null;
  }

  if (contentType.includes("text/html") || looksLikeHtml(bytes)) {
    throw new Error(
      "Slack image download returned HTML instead of image bytes. The bot token likely needs files:read and the Slack app may need to be reinstalled."
    );
  }

  return {
    type: "image" as const,
    image: bytes,
    mediaType: file.mimetype
  };
}

function looksLikeHtml(bytes: Buffer) {
  const prefix = bytes.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype") || prefix.startsWith("<html");
}

function explainImageAttachmentError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("files:read") || message.includes("returned HTML instead of image bytes")) {
    return "I can see the image attachment, but this Slack app still can't download files. Add the `files:read` scope to the app, reinstall it to the workspace, and then try again.";
  }

  if (message.includes("Failed to decode image")) {
    return "I can see the image attachment, but the file download Slack returned was not a valid image payload. The most likely fix is adding `files:read` to the Slack app and reinstalling it.";
  }

  return null;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  acquireActiveListeningReplySlot,
  getActiveListeningMaxConcurrentReplies,
  getSlackEventLockKey
};

function getSlackContextMessageLimit() {
  const rawValue = process.env.SLACK_CONTEXT_MESSAGES;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 2) {
    return DEFAULT_SLACK_CONTEXT_MESSAGES;
  }

  return parsedValue;
}

function getSlackStreamBufferSize() {
  const rawValue = process.env.SLACK_STREAM_BUFFER_SIZE;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_SLACK_STREAM_BUFFER_SIZE;
  }

  return Math.min(parsedValue, 2000);
}

function getSlackStreamUpdateIntervalMs() {
  const rawValue = process.env.SLACK_STREAM_UPDATE_INTERVAL_MS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 100) {
    return DEFAULT_SLACK_STREAM_UPDATE_INTERVAL_MS;
  }

  return Math.min(parsedValue, 5000);
}

function getSlackListeningAnimationIntervalMs() {
  const rawValue = process.env.SLACK_LISTENING_ANIMATION_INTERVAL_MS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 250) {
    return DEFAULT_SLACK_LISTENING_ANIMATION_INTERVAL_MS;
  }

  return Math.min(parsedValue, 5000);
}

function getSlackListeningMessage() {
  return process.env.SLACK_LISTENING_MESSAGE?.trim() || DEFAULT_SLACK_LISTENING_MESSAGE;
}

function getSlackAckReactionName() {
  const rawValue = process.env.SLACK_ACK_REACTION?.trim() || DEFAULT_SLACK_ACK_REACTION;
  const normalized = rawValue.replace(/^:+|:+$/g, "").trim();

  if (!normalized || normalized.toLowerCase() === "none" || normalized.toLowerCase() === "off") {
    return null;
  }

  return normalized;
}

function getSlackInitialListeningFrame() {
  return getSlackListeningAnimationFrames()[0] ?? getSlackListeningMessage();
}

function getSlackListeningAnimationFrames() {
  const baseMessage = getSlackListeningMessage().replace(/\.+$/u, "").trim() || "Thinking";

  return [1, 2, 3].map((dotCount) => `${baseMessage}${".".repeat(dotCount)}`);
}
