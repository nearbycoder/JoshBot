import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { WebClient } from "@slack/web-api";
import { listRecentArtifacts, type RecentArtifact } from "./artifacts.js";
import {
  chooseSlackActiveListeningResponse,
  createSlackReplyWithMemory,
  shouldReplyToSlackThread
} from "./ai.js";
import { maybeHandleChannelMemoryMentionCommand } from "./channel-memory-controls.js";
import {
  addChannelDecision,
  formatChannelDecisionList,
  formatDecisionAdded,
  formatDecisionHelp,
  listChannelDecisions,
  parseDecisionIntent
} from "./decisions.js";
import { requireEnv } from "./env.js";
import {
  addUserMemory,
  appendChannelMemory,
  clearUserMemories,
  getChannelMemories,
  listChannelMemoryStatuses,
  getUserMemories,
  removeUserMemory,
  type ChannelMemoryEntry,
  type ChannelMemoryStatus
} from "./memory.js";
import { getRedisClient } from "./redis.js";
import {
  DEFAULT_USER_PREFERENCES,
  listChannelPreferenceStatuses,
  getUserPreferences,
  maybeHandleUserPreferencesCommand,
  type ChannelPreferenceStatus,
  type UserPreferences
} from "./preferences.js";
import {
  formatOpenCodeGoModelName,
  getDefaultSlackTextModel
} from "./nobo-models.js";
import {
  getUserScheduleDashboardItems,
  maybeHandleScheduleCommand,
  type ScheduleDashboardItem
} from "./schedules.js";
import {
  getUserMonitorDashboardItems,
  maybeHandleMonitorCommand,
  type MonitorDashboardItem
} from "./monitors.js";
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

type SlackPermalinkResponse =
  | SlackApiSuccess<{ permalink: string }>
  | SlackApiFailure;

type SlackViewsPublishResponse =
  | SlackApiSuccess<{ view?: unknown }>
  | SlackApiFailure;

type SlackViewsOpenResponse =
  | SlackApiSuccess<{ view?: unknown }>
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

type SlackNativeAiTarget = {
  threadTs: string;
  teamId: string;
  userId: string;
  title: string;
};

type SlackNativeChatStream = {
  readonly ts: string | undefined;
  append: (input: { markdown_text: string }) => Promise<unknown>;
  stop: (input?: { session_status?: string }) => Promise<{ ts?: string }>;
};

type SlackNativeAiClient = {
  agents: {
    sessions: {
      setStatus: (input: {
        channel_id: string;
        thread_ts: string;
        status: "active" | "processing";
        title?: string;
        initiator_user_id?: string;
      }) => Promise<unknown>;
    };
  };
  chatStream: (input: {
    channel: string;
    thread_ts: string;
    recipient_team_id: string;
    recipient_user_id: string;
    buffer_size: number;
  }) => SlackNativeChatStream;
};

type SlackNativeAiClientFactory = (token: string) => SlackNativeAiClient;

type SlackBlock = Record<string, unknown>;
type SlackAcknowledgement = {
  token: string;
  channel: string;
  ts: string;
  name: string;
};

type SlackHomeDashboardData = {
  userId: string;
  memories: string[];
  schedules: ScheduleDashboardItem[];
  monitors: MonitorDashboardItem[];
  artifacts: RecentArtifact[];
  channelStatuses: SlackHomeChannelStatus[];
  preferences: UserPreferences;
  updatedAt: Date;
};

type SlackHomeChannelStatus = ChannelMemoryStatus & {
  modelId?: string;
  modelName?: string;
  modelSource?: "default" | "channel";
};

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
  size?: number;
  created?: number;
  timestamp?: number;
  duration_ms?: number;
  huddle_room?: Record<string, unknown>;
  user?: string;
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
const DEFAULT_SLACK_TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;
const DEFAULT_SLACK_ATTACHMENT_TEXT_MAX_CHARS = 6000;
const TEXT_ATTACHMENT_MIMETYPES = new Set([
  "application/csv",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/rtf",
  "application/sql",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-yaml",
  "application/xml",
  "application/yaml"
]);
const TEXT_ATTACHMENT_FILETYPES = new Set([
  "bash",
  "csv",
  "css",
  "html",
  "javascript",
  "js",
  "json",
  "jsonl",
  "log",
  "markdown",
  "md",
  "ndjson",
  "plain_text",
  "post",
  "rtf",
  "srt",
  "sql",
  "tab",
  "transcript",
  "tsv",
  "text",
  "ts",
  "typescript",
  "vtt",
  "xml",
  "yaml",
  "yml"
]);
const TEXT_ATTACHMENT_EXTENSIONS = [
  ".bash",
  ".c",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".html",
  ".htm",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".log",
  ".md",
  ".ndjson",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".rtf",
  ".sh",
  ".sql",
  ".srt",
  ".tab",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".vtt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
];
const WORD_ATTACHMENT_MIMETYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const WORD_ATTACHMENT_FILETYPES = new Set(["doc", "docx"]);
const SPREADSHEET_ATTACHMENT_MIMETYPES = new Set([
  "application/vnd.apple.numbers",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);
const SPREADSHEET_ATTACHMENT_FILETYPES = new Set(["numbers", "xls", "xlsx"]);
const PDF_ATTACHMENT_EXTENSIONS = [".pdf"];
const WORD_ATTACHMENT_EXTENSIONS = [".doc", ".docx"];
const SPREADSHEET_ATTACHMENT_EXTENSIONS = [".xls", ".xlsx", ".numbers"];
const localEventLocks = new Map<string, number>();
const activeListeningReplyCounts = new Map<string, number>();
let slackNativeAiUnavailableReason: string | null = null;
let slackNativeAiClientFactory: SlackNativeAiClientFactory = (token) =>
  new WebClient(token) as unknown as SlackNativeAiClient;

class SlackDownloadTooLargeError extends Error {
  constructor(
    public readonly readBytes: number,
    public readonly maxBytes: number
  ) {
    super(`Slack file download is too large (${readBytes} bytes; limit ${maxBytes} bytes).`);
    this.name = "SlackDownloadTooLargeError";
  }
}

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

export function isSlackRetryRequest(headers: SlackHeaders) {
  return Boolean(getHeader(headers, "x-slack-retry-num"));
}

export async function respondToSlackMention(event: SlackMessageEvent) {
  const lock = await acquireSlackEventLock(event, "mention");
  if (!lock.acquired) {
    return;
  }

  const token = requireEnv("SLACK_BOT_TOKEN");
  const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
  try {
    const threadTs = event.thread_ts ?? event.ts;
    const incomingMessage = await createCachedUserMessage(token, event);
    let threadMessages: CachedThreadMessage[] = [incomingMessage];
    const channelMemories = await loadChannelMemories(event.channel);
    await recordUserChannelMemory(event, incomingMessage, threadTs);
    const commandReply =
      (await maybeHandlePreferenceCommand(event)) ?? (await maybeHandleMemoryCommand(event));
    const decisionReply = commandReply ? null : await maybeHandleDecisionCommand(event, token);
    const monitorReply = commandReply || decisionReply ? null : await maybeHandleMonitorCommand(event);
    const scheduleReply = commandReply || decisionReply || monitorReply ? null : await maybeHandleScheduleCommand(event);

    if (commandReply || decisionReply || monitorReply || scheduleReply) {
      const replyText = commandReply ?? decisionReply ?? monitorReply ?? scheduleReply ?? "";
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
      threadTs,
      nativeAi: createSlackNativeAiTarget(event, threadTs)
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
        threadTs,
        messageTs: event.ts,
        scheduleContext: getScheduleContext(event),
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
      threadTs,
      nativeAi: createSlackNativeAiTarget(event, threadTs)
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
  } finally {
    await removeSlackAcknowledgement(acknowledgement);
  }
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
  const commandReply =
    (await maybeHandlePreferenceCommand(event)) ?? (await maybeHandleMemoryCommand(event));
  const decisionReply = commandReply ? null : await maybeHandleDecisionCommand(event, token);
  const monitorReply = commandReply || decisionReply ? null : await maybeHandleMonitorCommand(event);
  const minimalThreadMessages = [incomingMessage];

  if (commandReply || decisionReply || monitorReply) {
    const replyText = commandReply ?? decisionReply ?? monitorReply ?? "";
    const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
    try {
      await recordUserChannelMemory(event, incomingMessage, event.thread_ts);
      const postedReply = await postSlackMessage({
        token,
        channel: event.channel,
        threadTs: event.thread_ts,
        text: replyText
      });
      await recordAssistantChannelMemory({
        channel: event.channel,
        threadTs: event.thread_ts,
        text: replyText,
        ts: postedReply.ts
      });

      await saveCachedThreadMessages(
        event.channel,
        event.thread_ts,
        appendCachedThreadMessage(minimalThreadMessages, {
          role: "assistant",
          content: replyText,
          ts: postedReply.ts
        })
      );
    } finally {
      await removeSlackAcknowledgement(acknowledgement);
    }
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
    const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
    try {
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
    } finally {
      await removeSlackAcknowledgement(acknowledgement);
    }
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

  const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
  try {
    const replyStream = createSlackReplyStreamer({
      token,
      channel: event.channel,
      threadTs: event.thread_ts,
      nativeAi: createSlackNativeAiTarget(event, event.thread_ts)
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
  } finally {
    await removeSlackAcknowledgement(acknowledgement);
  }
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
  const decisionReply = await maybeHandleDecisionCommand(event, token);

  if (decisionReply) {
    const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
    try {
      const postedReply = await postSlackMessage({
        token,
        channel: event.channel,
        threadTs,
        text: decisionReply
      });
      await recordAssistantChannelMemory({
        channel: event.channel,
        threadTs,
        text: decisionReply,
        ts: postedReply.ts
      });
      await saveCachedThreadMessages(
        event.channel,
        threadTs,
        appendCachedThreadMessage(threadMessages, {
          role: "assistant",
          content: decisionReply,
          ts: postedReply.ts
        })
      );
    } finally {
      await removeSlackAcknowledgement(acknowledgement);
    }
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

    const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
    try {
      const replyThreadTs = responseMode === "thread" ? threadTs : undefined;
      const replyStream = createSlackReplyStreamer({
        token,
        channel: event.channel,
        threadTs: replyThreadTs,
        nativeAi: createSlackNativeAiTarget(event, replyThreadTs)
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
      await removeSlackAcknowledgement(acknowledgement);
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
  const acknowledgement = acknowledgeTargetedSlackEvent(token, event);
  try {
    const incomingMessage = await createCachedUserMessage(token, event);
    const conversationThreadTs = event.thread_ts ?? event.ts;
    let threadMessages: CachedThreadMessage[] = [incomingMessage];

    if (event.thread_ts) {
      try {
        threadMessages = await loadThreadMessagesForIncomingEvent({
          token,
          channel: event.channel,
          threadTs: conversationThreadTs,
          incomingMessage
        });
      } catch (error) {
        console.warn(
          `Falling back to current Slack direct message text: ${summarizeError(error)}`
        );
      }
    }

    const channelMemories = await loadChannelMemories(event.channel);
    await recordUserChannelMemory(event, incomingMessage, conversationThreadTs);
    const commandReply =
      (await maybeHandlePreferenceCommand(event)) ?? (await maybeHandleMemoryCommand(event));
    const decisionReply = commandReply ? null : await maybeHandleDecisionCommand(event, token);
    const monitorReply = commandReply || decisionReply ? null : await maybeHandleMonitorCommand(event);
    const scheduleReply = commandReply || decisionReply || monitorReply ? null : await maybeHandleScheduleCommand(event);

    if (commandReply || decisionReply || monitorReply || scheduleReply) {
      const replyText = commandReply ?? decisionReply ?? monitorReply ?? scheduleReply ?? "";
      const postedReply = await postSlackMessage({
        token,
        channel: event.channel,
        threadTs: event.thread_ts,
        text: replyText
      });
      await recordAssistantChannelMemory({
        channel: event.channel,
        threadTs: conversationThreadTs,
        text: replyText,
        ts: postedReply.ts
      });

      await saveCachedThreadMessages(
        event.channel,
        conversationThreadTs,
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
      channel: event.channel,
      threadTs: event.thread_ts,
      nativeAi: createSlackNativeAiTarget(event, conversationThreadTs)
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
      threadTs: event.thread_ts,
      text: replyText,
      stream: replyStream
    });
    await recordAssistantChannelMemory({
      channel: event.channel,
      threadTs: conversationThreadTs,
      text: replyText,
      ts: postedReply.ts
    });

    await saveCachedThreadMessages(
      event.channel,
      conversationThreadTs,
      appendCachedThreadMessage(threadMessages, {
        role: "assistant",
        content: replyText,
        ts: postedReply.ts
      })
    );
  } finally {
    await removeSlackAcknowledgement(acknowledgement);
  }
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

export async function publishSlackAppHome(userId: string) {
  const token = requireEnv("SLACK_BOT_TOKEN");
  const view = await createSlackAppHomeView(userId);

  return slackApi<SlackViewsPublishResponse>({
    token,
    method: "POST",
    path: "views.publish",
    body: {
      user_id: userId,
      view
    }
  });
}

export async function openSlackModal({
  token,
  triggerId,
  view
}: {
  token: string;
  triggerId: string;
  view: SlackBlock;
}) {
  return slackApi<SlackViewsOpenResponse>({
    token,
    method: "POST",
    path: "views.open",
    body: {
      trigger_id: triggerId,
      view
    }
  });
}

async function createSlackAppHomeView(userId: string) {
  const data = await loadSlackHomeDashboardData(userId);
  return buildSlackAppHomeView(data);
}

async function loadSlackHomeDashboardData(userId: string): Promise<SlackHomeDashboardData> {
  const [
    memories,
    schedules,
    monitors,
    artifacts,
    channelMemoryStatuses,
    channelPreferenceStatuses,
    preferences
  ] = await Promise.all([
    loadSlackHomeSection("memories", () => getUserMemories(userId), []),
    loadSlackHomeSection("schedules", () => getUserScheduleDashboardItems(userId, 5), []),
    loadSlackHomeSection("monitors", () => getUserMonitorDashboardItems(userId, 5), []),
    loadSlackHomeSection("artifacts", () => listRecentArtifacts(5, { ownerUserId: userId }), []),
    loadSlackHomeSection("channel status", () => listChannelMemoryStatuses(12), []),
    loadSlackHomeSection("channel models", () => listChannelPreferenceStatuses(12), []),
    loadSlackHomeSection("preferences", () => getUserPreferences(userId), {
      ...DEFAULT_USER_PREFERENCES
    })
  ]);

  return {
    userId,
    memories,
    schedules,
    monitors,
    artifacts,
    channelStatuses: mergeSlackHomeChannelStatuses(
      channelMemoryStatuses,
      channelPreferenceStatuses
    ),
    preferences,
    updatedAt: new Date()
  };
}

async function loadSlackHomeSection<T>(
  label: string,
  load: () => Promise<T>,
  fallback: T
) {
  try {
    return await load();
  } catch (error) {
    console.warn(`Unable to load Slack Home ${label}: ${summarizeError(error)}`);
    return fallback;
  }
}

function buildSlackAppHomeView(data: SlackHomeDashboardData) {
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "NoBo Home",
          emoji: true
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Updated ${formatHomeTimestamp(data.updatedAt)}`
          }
        ]
      },
      { type: "divider" },
      createSlackHomeOverviewBlock(data),
      { type: "divider" },
      createSlackHomeSection("Next Up", formatHomeSchedules(data.schedules)),
      createSlackHomeSection("Monitors", formatHomeMonitors(data.monitors)),
      createSlackHomeSection("Memory", formatHomeMemories(data.memories)),
      createSlackHomeSection("Channels", formatHomeChannelStatuses(data.channelStatuses)),
      createSlackHomeSection("Recent Artifacts", formatHomeArtifacts(data.artifacts)),
      { type: "divider" },
      createSlackHomePreferencesBlock(data.preferences),
      createSlackHomeShortcutsBlock(),
      createSlackHomeModalActionsBlock()
    ]
  };
}

function mergeSlackHomeChannelStatuses(
  memoryStatuses: ChannelMemoryStatus[],
  preferenceStatuses: ChannelPreferenceStatus[]
): SlackHomeChannelStatus[] {
  const statuses = new Map<string, SlackHomeChannelStatus>();

  for (const status of memoryStatuses) {
    statuses.set(status.channelId, withHomeChannelModel(status));
  }

  for (const status of preferenceStatuses) {
    const existing = statuses.get(status.channelId) ?? {
      channelId: status.channelId,
      activeListening: false,
      memoryCount: 0
    };
    statuses.set(status.channelId, withHomeChannelModel(existing, status.modelId));
  }

  return [...statuses.values()]
    .sort(
      (left, right) =>
        Number(right.activeListening) - Number(left.activeListening) ||
        Number(right.modelSource === "channel") - Number(left.modelSource === "channel") ||
        right.memoryCount - left.memoryCount ||
        left.channelId.localeCompare(right.channelId)
    )
    .slice(0, 12);
}

function withHomeChannelModel(
  status: ChannelMemoryStatus,
  modelIdOverride?: string | null
): SlackHomeChannelStatus {
  const modelId = modelIdOverride ?? getDefaultSlackTextModel();

  return {
    ...status,
    modelId,
    modelName: formatOpenCodeGoModelName(modelId),
    modelSource: modelIdOverride ? "channel" : "default"
  };
}

function createSlackHomeOverviewBlock(data: SlackHomeDashboardData): SlackBlock {
  const activeListeningCount = data.channelStatuses.filter(
    (status) => status.activeListening
  ).length;

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Dashboard*"
    },
    fields: [
      createSlackHomeField("Reminders", `${data.schedules.length} upcoming`),
      createSlackHomeField("Monitors", `${data.monitors.length} active`),
      createSlackHomeField("Memory", `${data.memories.length} saved`),
      createSlackHomeField("Listening", `${activeListeningCount} channels on`),
      createSlackHomeField("Artifacts", `${data.artifacts.length} recent`),
      createSlackHomeField("Timezone", data.preferences.timeZone),
      createSlackHomeField("Verbosity", data.preferences.verbosity)
    ]
  };
}

function createSlackHomeSection(title: string, body: string): SlackBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateSlackHomeText(`*${title}*\n${body}`)
    }
  };
}

function createSlackHomePreferencesBlock(preferences: UserPreferences): SlackBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Preferences*"
    },
    fields: [
      createSlackHomeField("Timezone", preferences.timeZone),
      createSlackHomeField("Verbosity", preferences.verbosity),
      createSlackHomeField("Reminder style", preferences.reminderStyle),
      createSlackHomeField(
        "News",
        preferences.newsInterests.length
          ? preferences.newsInterests.slice(0, 5).join(", ")
          : "none"
      )
    ]
  };
}

function createSlackHomeShortcutsBlock(): SlackBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Quick Actions*"
    },
    fields: [
      createSlackHomeField("Threads", "`@NoBo summarize-thread`\n`@NoBo meeting-notes artifact`\n`@NoBo follow-ups`"),
      createSlackHomeField("Triage", "`@NoBo what needs my attention?`\n`@NoBo issues`"),
      createSlackHomeField("Channel", "`/nobo-listen on`\n`/nobo-memory`"),
      createSlackHomeField("Search", "`/nobo-search <query>`\n`@NoBo web-search ...`"),
      createSlackHomeField("Polls", "`/nobo-polls create Q? | A | B`\n`/nobo-polls results`"),
      createSlackHomeField("Monitors", "`@NoBo monitor every 10 minutes alert if ... appears`\n`@NoBo monitors`"),
      createSlackHomeField("Digests", "`/nobo-channel-digest daily 09:00`\n`/nobo-news [focus]`"),
      createSlackHomeField("Settings", "`/nobo-prefs`\n`/nobo-channel-model`")
    ]
  };
}

function createSlackHomeModalActionsBlock(): SlackBlock {
  return {
    type: "actions",
    elements: [
      createHomeButton("Reminder", "nobo_open_modal:reminder"),
      createHomeButton("Prefs", "nobo_open_modal:prefs"),
      createHomeButton("Digest", "nobo_open_modal:digest"),
      createHomeButton("Artifacts", "nobo_open_modal:artifacts")
    ]
  };
}

function createHomeButton(text: string, actionId: string) {
  return {
    type: "button",
    text: {
      type: "plain_text",
      text,
      emoji: true
    },
    action_id: actionId
  };
}

function createSlackHomeField(label: string, value: string) {
  return {
    type: "mrkdwn",
    text: truncateSlackHomeText(`*${label}*\n${escapeSlackMrkdwn(value)}`)
  };
}

function formatHomeSchedules(schedules: ScheduleDashboardItem[]) {
  if (schedules.length === 0) {
    return "No active reminders or crons.\n`@NoBo remind me in 10 minutes to check the logs`";
  }

  return schedules
    .map((schedule) => {
      const nextRun = formatHomeTimestamp(new Date(schedule.nextRunAt));
      return `- \`${schedule.id.slice(0, 8)}\` ${escapeSlackMrkdwn(schedule.summary)}\n  Next: ${nextRun}`;
    })
    .join("\n");
}

function formatHomeMonitors(monitors: MonitorDashboardItem[]) {
  if (monitors.length === 0) {
    return "No active monitors.\n`@NoBo monitor every 10 minutes alert if deploy failed appears`";
  }

  return monitors
    .map((monitor) => {
      const nextRun = formatHomeTimestamp(new Date(monitor.nextRunAt));
      return `- \`${monitor.id.slice(0, 8)}\` ${escapeSlackMrkdwn(monitor.summary)}\n  Next: ${nextRun}`;
    })
    .join("\n");
}

function formatHomeMemories(memories: string[]) {
  if (memories.length === 0) {
    return "No saved memories yet.\n`@NoBo remember I prefer concise updates`";
  }

  return memories
    .slice(0, 8)
    .map((memory) => `- ${escapeSlackMrkdwn(memory)}`)
    .join("\n");
}

function formatHomeChannelStatuses(statuses: SlackHomeChannelStatus[]) {
  const active = statuses.filter((status) => status.activeListening);
  const known = statuses.filter((status) => !status.activeListening);
  const lines = [
    active.length > 0
      ? `Listening on:\n${active.map(formatHomeChannelStatus).join("\n")}`
      : "On: none. Use `/nobo-listen on` in a channel."
  ];

  if (known.length > 0) {
    lines.push(`Known:\n${known.slice(0, 6).map(formatHomeChannelStatus).join("\n")}`);
  }

  return lines.join("\n");
}

function formatHomeArtifacts(artifacts: RecentArtifact[]) {
  if (artifacts.length === 0) {
    return "No recent artifacts.\nReact with `:memo:` on a thread or use `@NoBo artifacts list`.";
  }

  return artifacts
    .map(
      (artifact) =>
        `- ${formatSlackHomeLink(artifact.previewUrl, artifact.title)} (${artifact.kind}, ${formatHomeTimestamp(new Date(artifact.updatedAt))})`
    )
    .join("\n");
}

function formatHomeChannelStatus(status: SlackHomeChannelStatus) {
  const label = /^[CDG][A-Z0-9]+$/.test(status.channelId)
    ? `<#${status.channelId}>`
    : escapeSlackMrkdwn(status.channelId);
  const model = getHomeChannelModelLabel(status);

  return `- ${label} (${status.memoryCount}) - ${model}`;
}

function getHomeChannelModelLabel(status: SlackHomeChannelStatus) {
  const modelId = status.modelId ?? getDefaultSlackTextModel();
  const modelName = status.modelName ?? formatOpenCodeGoModelName(modelId);
  const source = status.modelSource === "channel" ? "override" : "default";

  return `${escapeSlackMrkdwn(modelName)} \`${escapeSlackMrkdwn(modelId)}\` (${source})`;
}

function formatSlackHomeLink(url: string, label: string) {
  return `<${url.replace(/[<>\s|]/g, "")}|${escapeSlackMrkdwn(label)}>`;
}

function formatHomeTimestamp(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago"
  }).format(date);
}

function escapeSlackMrkdwn(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncateSlackHomeText(input: string) {
  if (input.length <= SLACK_SECTION_BLOCK_TEXT_LIMIT) {
    return input;
  }

  return `${input.slice(0, SLACK_SECTION_BLOCK_TEXT_LIMIT - 4)}...`;
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

async function getSlackMessagePermalink({
  token,
  channel,
  messageTs
}: {
  token: string;
  channel: string;
  messageTs: string;
}) {
  const params = new URLSearchParams({
    channel,
    message_ts: messageTs
  });
  const response = await slackApi<SlackPermalinkResponse>({
    token,
    method: "GET",
    path: `chat.getPermalink?${params.toString()}`
  });

  return response.permalink;
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

async function acknowledgeTargetedSlackEvent(
  token: string,
  event: SlackMessageEvent
): Promise<SlackAcknowledgement | null> {
  const reaction = getSlackAckReactionName();

  if (!reaction) {
    return null;
  }

  const acknowledgement = {
    token,
    channel: event.channel,
    ts: event.ts,
    name: reaction
  };

  try {
    await addSlackReaction(acknowledgement);
    return acknowledgement;
  } catch (error) {
    const summary = summarizeError(error);

    if (summary.includes("already_reacted")) {
      return acknowledgement;
    }

    console.warn(`Unable to add Slack acknowledgement reaction: ${summary}`);
    return null;
  }
}

async function removeSlackAcknowledgement(
  acknowledgementPromise: Promise<SlackAcknowledgement | null>
) {
  const acknowledgement = await acknowledgementPromise;

  if (!acknowledgement) {
    return;
  }

  try {
    await removeSlackReaction(acknowledgement);
  } catch (error) {
    const summary = summarizeError(error);

    if (summary.includes("no_reaction")) {
      return;
    }

    console.warn(`Unable to remove Slack acknowledgement reaction: ${summary}`);
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

async function removeSlackReaction({
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
    path: "reactions.remove",
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
  threadTs,
  nativeAi
}: {
  token: string;
  channel: string;
  threadTs?: string;
  nativeAi?: SlackNativeAiTarget;
}): SlackReplyStreamer {
  const legacy = createLegacySlackReplyStreamer({ token, channel, threadTs });
  let implementationPromise: Promise<SlackReplyStreamer> | null = null;
  const getImplementation = () => {
    implementationPromise ??= createNativeSlackReplyStreamer({
      token,
      channel,
      nativeAi,
      legacy
    }).then((stream) => stream ?? legacy);
    return implementationPromise;
  };

  return {
    async start() {
      await (await getImplementation()).start();
    },
    async append(delta: string) {
      await (await getImplementation()).append(delta);
    },
    async finish(finalText: string) {
      return (await getImplementation()).finish(finalText);
    },
    async fail(notice?: string) {
      await (await getImplementation()).fail(notice);
    }
  };
}

async function createNativeSlackReplyStreamer({
  token,
  channel,
  nativeAi,
  legacy
}: {
  token: string;
  channel: string;
  nativeAi?: SlackNativeAiTarget;
  legacy: SlackReplyStreamer;
}): Promise<SlackReplyStreamer | null> {
  if (!nativeAi || !isSlackNativeAiEnabled() || slackNativeAiUnavailableReason) {
    return null;
  }

  const client = slackNativeAiClientFactory(token);
  const setSessionStatus = async (status: "active" | "processing") => {
    await client.agents.sessions.setStatus({
      channel_id: channel,
      thread_ts: nativeAi.threadTs,
      status,
      ...(status === "processing"
        ? {
            title: nativeAi.title,
            initiator_user_id: nativeAi.userId
          }
        : {})
    });
  };

  try {
    await setSessionStatus("processing");
  } catch (error) {
    markSlackNativeAiUnavailable(error);
    console.warn(
      `Slack native AI status unavailable; using legacy reply streaming: ${summarizeError(error)}`
    );
    return null;
  }

  let stream: SlackNativeChatStream;

  try {
    stream = client.chatStream({
      channel,
      thread_ts: nativeAi.threadTs,
      recipient_team_id: nativeAi.teamId,
      recipient_user_id: nativeAi.userId,
      buffer_size: getSlackStreamBufferSize()
    });
  } catch (error) {
    await safelySetSlackAgentSessionActive(setSessionStatus);
    console.warn(
      `Unable to initialize Slack native reply stream; using legacy streaming: ${summarizeError(error)}`
    );
    return null;
  }

  let streamedText = "";
  let usingLegacy = false;
  let nativeStreamBroken = false;

  const fallBackBeforeNativeStart = async (error: unknown) => {
    console.warn(
      `Slack native reply stream failed before posting; using legacy streaming: ${summarizeError(error)}`
    );
    await safelySetSlackAgentSessionActive(setSessionStatus);
    usingLegacy = true;
    await legacy.start();

    if (streamedText) {
      await legacy.append(streamedText);
    }
  };

  const finishBrokenNativeStream = async (finalText: string, ts: string) => {
    try {
      await updateSlackMessage({
        token,
        channel,
        ts,
        text: finalText,
        blocks: createSlackTextBlocks(finalText)
      });
    } catch (error) {
      console.warn(
        `Unable to finalize Slack native reply with chat.update: ${summarizeError(error)}`
      );
    } finally {
      await safelySetSlackAgentSessionActive(setSessionStatus);
    }

    return { ts };
  };

  return {
    async start() {
      // agents.sessions.setStatus provides Slack's native working indicator.
    },
    async append(delta: string) {
      if (!delta) {
        return;
      }

      if (usingLegacy) {
        await legacy.append(delta);
        return;
      }

      streamedText += delta;

      if (nativeStreamBroken) {
        return;
      }

      try {
        await stream.append({ markdown_text: delta });
      } catch (error) {
        if (!stream.ts) {
          await fallBackBeforeNativeStart(error);
          return;
        }

        nativeStreamBroken = true;
        console.warn(
          `Slack native reply stream interrupted; final response will use chat.update: ${summarizeError(error)}`
        );
      }
    },
    async finish(finalText: string) {
      if (usingLegacy) {
        return legacy.finish(finalText);
      }

      if (nativeStreamBroken && stream.ts) {
        return finishBrokenNativeStream(finalText, stream.ts);
      }

      try {
        if (!streamedText) {
          await stream.append({ markdown_text: finalText });
        }

        const response = await stream.stop({ session_status: "active" });
        const ts = response.ts ?? stream.ts;

        if (!ts) {
          throw new Error("Slack native reply stream finished without a message timestamp.");
        }

        return { ts };
      } catch (error) {
        if (stream.ts) {
          console.warn(
            `Unable to stop Slack native reply stream; finalizing with chat.update: ${summarizeError(error)}`
          );
          return finishBrokenNativeStream(finalText, stream.ts);
        }

        console.warn(
          `Slack native reply stream failed before posting; sending a legacy reply: ${summarizeError(error)}`
        );
        await safelySetSlackAgentSessionActive(setSessionStatus);
        return legacy.finish(finalText);
      }
    },
    async fail(notice = STREAM_FAILURE_NOTICE) {
      if (usingLegacy) {
        await legacy.fail(notice);
        return;
      }

      const ts = stream.ts;

      if (!ts) {
        await safelySetSlackAgentSessionActive(setSessionStatus);
        await legacy.start();
        await legacy.fail(notice);
        return;
      }

      try {
        await stream.stop({ session_status: "active" });
      } catch (error) {
        console.warn(`Unable to stop failed Slack native reply stream: ${summarizeError(error)}`);
      }

      await finishBrokenNativeStream(notice, ts);
    }
  };
}

function createSlackNativeAiTarget(
  event: SlackMessageEvent,
  threadTs: string | undefined
): SlackNativeAiTarget | undefined {
  if (!threadTs || !event.team_id || !event.user) {
    return undefined;
  }

  return {
    threadTs,
    teamId: event.team_id,
    userId: event.user,
    title: getSlackAgentSessionTitle(event.text)
  };
}

function getSlackAgentSessionTitle(text: string) {
  return (
    stripSlackFormatting(text)
      .replace(/[*_~`]+/gu, "")
      .trim()
      .slice(0, 200) || "NoBo conversation"
  );
}

function isSlackNativeAiEnabled() {
  const configured = process.env.SLACK_NATIVE_AI?.trim().toLowerCase();
  return !configured || !["0", "false", "off", "legacy"].includes(configured);
}

function markSlackNativeAiUnavailable(error: unknown) {
  const errorCode = getSlackPlatformErrorCode(error);

  if (
    errorCode &&
    [
      "feature_disabled",
      "feature_not_enabled",
      "messages_tab_disabled",
      "method_deprecated",
      "missing_scope",
      "not_allowed_token_type",
      "unknown_method"
    ].includes(errorCode)
  ) {
    slackNativeAiUnavailableReason = errorCode;
  }
}

function getSlackPlatformErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const data = (error as { data?: unknown }).data;

  if (!data || typeof data !== "object") {
    return null;
  }

  const code = (data as { error?: unknown }).error;
  return typeof code === "string" ? code : null;
}

async function safelySetSlackAgentSessionActive(
  setSessionStatus: (status: "active" | "processing") => Promise<void>
) {
  try {
    await setSessionStatus("active");
  } catch (error) {
    console.warn(`Unable to clear Slack agent session status: ${summarizeError(error)}`);
  }
}

function createLegacySlackReplyStreamer({
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
  const text = stripSlackFormatting(event.text);
  const trimmed = text.trim();
  const channelMemoryReply = await maybeHandleChannelMemoryMentionCommand({
    text: trimmed,
    channelId: event.channel
  });

  if (channelMemoryReply) {
    return channelMemoryReply;
  }

  if (!event.user) {
    return null;
  }

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

async function maybeHandleDecisionCommand(event: SlackMessageEvent, token: string) {
  const intent = parseDecisionIntent(stripSlackFormatting(event.text));

  if (!intent) {
    return null;
  }

  if (intent.action === "help") {
    return formatDecisionHelp();
  }

  if (intent.action === "list") {
    const result = await listChannelDecisions(event.channel);

    if (!result.ok) {
      return `Couldn't load decision log: ${result.reason}`;
    }

    return formatChannelDecisionList(result.decisions);
  }

  const threadTs = event.thread_ts ?? event.ts;
  const threadUrl = await safeGetSlackMessagePermalink({
    token,
    channel: event.channel,
    messageTs: threadTs
  });
  const result = await addChannelDecision({
    channelId: event.channel,
    text: intent.text,
    userId: event.user,
    threadTs,
    messageTs: event.ts,
    threadUrl,
    source: "slack-message"
  });

  if (!result.ok) {
    return `Couldn't save decision: ${result.reason}`;
  }

  return formatDecisionAdded(result.decision);
}

async function safeGetSlackMessagePermalink({
  token,
  channel,
  messageTs
}: {
  token: string;
  channel: string;
  messageTs: string;
}) {
  try {
    return await getSlackMessagePermalink({ token, channel, messageTs });
  } catch (error) {
    console.warn(`Unable to load Slack decision permalink: ${summarizeError(error)}`);
    return undefined;
  }
}

async function maybeHandlePreferenceCommand(event: SlackMessageEvent) {
  return maybeHandleUserPreferencesCommand({
    userId: event.user,
    commandText: stripSlackFormatting(event.text)
  });
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
  const fileContext = (await Promise.all(
    files.map((file) => formatSlackFileForModel(token, file))
  )).filter(Boolean).join("\n\n");

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

async function formatSlackFileForModel(token: string, file: SlackFile) {
  const title = file.title || file.name || file.id;
  const typeLabel = file.pretty_type || file.filetype || file.mimetype || "file";
  const parts = [`Attached ${typeLabel}: ${title}`];
  const metadata = formatSlackFileMetadata(file);
  const huddleMetadata = formatSlackHuddleTranscriptMetadata(file);

  if (metadata) {
    parts.push(`Attachment metadata: ${metadata}`);
  }

  if (huddleMetadata) {
    parts.push(`Huddle/transcript metadata: ${huddleMetadata}`);
  }

  const extractedText = await extractSlackFileText(token, file);
  const preview = getSlackFileProvidedText(file);
  const attachmentText = extractedText.text || preview;

  if (attachmentText) {
    parts.push(`Attachment extracted text:\n${limitAttachmentText(attachmentText)}`);
    if (!extractedText.text && extractedText.reason) {
      parts.push(`Attachment extraction fallback: used Slack-provided preview because ${extractedText.reason}`);
    }
  } else if (extractedText.reason) {
    parts.push(`Attachment extraction: ${extractedText.reason}`);
  }

  const link = file.external_url || file.permalink;
  if (link) {
    parts.push(`Attachment link: ${link}`);
  }

  return parts.join("\n");
}

function formatSlackFileMetadata(file: SlackFile) {
  const parts: string[] = [];

  if (file.mimetype) {
    parts.push(`MIME ${file.mimetype}`);
  }

  if (file.filetype) {
    parts.push(`Slack type ${file.filetype}`);
  }

  if (typeof file.size === "number" && Number.isFinite(file.size)) {
    parts.push(`size ${formatByteCount(file.size)}`);
  }

  const createdAt = file.created ?? file.timestamp;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    parts.push(`uploaded ${new Date(createdAt * 1000).toISOString()}`);
  }

  if (file.user) {
    parts.push(`uploaded by ${file.user}`);
  }

  return parts.join("; ");
}

function getSlackFileProvidedText(file: SlackFile) {
  return (
    file.plain_text ||
    file.preview_plain_text ||
    file.preview ||
    file.contents ||
    file.alt_txt ||
    file.initial_comment?.comment ||
    ""
  );
}

function formatSlackHuddleTranscriptMetadata(file: SlackFile) {
  if (!isSlackHuddleOrTranscriptFile(file)) {
    return "";
  }

  const record = file as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ["subtype", "mode", "media_display_type", "duration", "duration_ms", "start_time", "end_time"]) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      parts.push(`${key} ${value.trim()}`);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key} ${value}`);
    }
  }

  for (const key of ["participants", "huddle_thread", "huddle_room", "room", "transcript"]) {
    const value = record[key];
    const formatted = formatCompactSlackMetadataValue(value);

    if (formatted) {
      parts.push(`${key} ${formatted}`);
    }
  }

  return parts.join("; ");
}

function isSlackHuddleOrTranscriptFile(file: SlackFile) {
  const haystack = [
    file.title,
    file.name,
    file.pretty_type,
    file.filetype,
    file.mimetype,
    (file as Record<string, unknown>).subtype
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (/\b(huddle|transcript|transcription|caption|captions|subtitle|subtitles|vtt|srt)\b/.test(haystack)) {
    return true;
  }

  return ["participants", "huddle_thread", "huddle_room", "room", "transcript"].some((key) =>
    Object.hasOwn(file as Record<string, unknown>, key)
  );
}

function formatCompactSlackMetadataValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    const json = JSON.stringify(value);
    return json.length > 500 ? `${json.slice(0, 497)}...` : json;
  } catch {
    return "";
  }
}

async function extractSlackFileText(token: string, file: SlackFile) {
  if (file.mimetype?.startsWith("image/")) {
    return { text: null as string | null };
  }

  const supportedDocumentType = getSupportedDocumentAttachmentType(file);

  if (!isTextLikeSlackFile(file) && !supportedDocumentType) {
    return {
      text: null as string | null,
      reason: getUnsupportedSlackAttachmentReason(file)
    };
  }

  const url = file.url_private_download || file.url_private;

  if (!url) {
    return {
      text: null as string | null,
      reason: "no private download URL was available"
    };
  }

  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return {
        text: null as string | null,
        reason: `download failed with HTTP ${response.status}`
      };
    }

    const maxBytes = getSlackTextAttachmentMaxBytes();
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = await readSlackResponseBuffer(response, maxBytes);

    if ((contentType.includes("text/html") || looksLikeHtml(bytes)) && !isHtmlLikeSlackFile(file)) {
      return {
        text: null as string | null,
        reason: "Slack returned HTML instead of file bytes; confirm `files:read` is granted and the app was reinstalled"
      };
    }

    if (supportedDocumentType) {
      const text = await extractDocumentText(bytes, supportedDocumentType);

      if (!text.trim()) {
        return {
          text: null as string | null,
          reason: `${supportedDocumentType.toUpperCase()} download contained no extractable text`
        };
      }

      return { text };
    }

    if (!isTextualHttpContent(contentType) && !isTextLikeSlackFile(file)) {
      return {
        text: null as string | null,
        reason: `download returned non-text content (${contentType || "unknown content type"})`
      };
    }

    if (looksBinary(bytes)) {
      return {
        text: null as string | null,
        reason: "downloaded file appears to be binary"
      };
    }

    return {
      text: decodeSlackTextBytes(bytes, contentType)
    };
  } catch (error) {
    if (error instanceof SlackDownloadTooLargeError) {
      return {
        text: null as string | null,
        reason: `file is too large to extract (${formatByteCount(error.readBytes)}; limit ${formatByteCount(error.maxBytes)})`
      };
    }

    console.warn(`Unable to extract Slack file ${file.id}: ${summarizeError(error)}`);
    return {
      text: null as string | null,
      reason: "download failed before text extraction"
    };
  }
}

function getSupportedDocumentAttachmentType(file: SlackFile) {
  const mimetype = file.mimetype?.toLowerCase() ?? "";
  const filetype = file.filetype?.toLowerCase() ?? "";

  if (mimetype === "application/pdf" || filetype === "pdf" || hasSlackFileExtension(file, PDF_ATTACHMENT_EXTENSIONS)) {
    return "pdf" as const;
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filetype === "docx" ||
    hasSlackFileExtension(file, [".docx"])
  ) {
    return "docx" as const;
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    filetype === "xlsx" ||
    hasSlackFileExtension(file, [".xlsx"])
  ) {
    return "xlsx" as const;
  }

  return null;
}

async function extractDocumentText(bytes: Buffer, type: "pdf" | "docx" | "xlsx") {
  if (type === "pdf") {
    return extractPdfText(bytes);
  }

  if (type === "docx") {
    return extractDocxText(bytes);
  }

  return extractXlsxText(bytes);
}

async function extractPdfText(bytes: Buffer) {
  const document = await getDocument({
    data: new Uint8Array(bytes)
  }).promise;
  const pages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" ");

      if (text.trim()) {
        pages.push(text);
      }
    }
  } finally {
    await document.cleanup();
  }

  return pages.join("\n\n");
}

function extractDocxText(bytes: Buffer) {
  const zip = new AdmZip(bytes);
  const entries = zip
    .getEntries()
    .filter((entry) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName));

  return entries.map((entry) => extractOpenXmlText(entry.getData().toString("utf8"))).filter(Boolean).join("\n\n");
}

function extractXlsxText(bytes: Buffer) {
  const zip = new AdmZip(bytes);
  const sharedStrings = parseXlsxSharedStrings(zip);
  const workbookSheetNames = parseXlsxSheetNames(zip);
  const sheets = zip
    .getEntries()
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName));

  return sheets
    .map((entry, index) => {
      const sheetName = workbookSheetNames[index] ?? entry.entryName.replace(/^xl\/worksheets\//u, "");
      const rows = parseXlsxRows(entry.getData().toString("utf8"), sharedStrings);

      if (rows.length === 0) {
        return "";
      }

      return [`Sheet ${sheetName}:`, ...rows].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function parseXlsxSharedStrings(zip: AdmZip) {
  const entry = zip.getEntry("xl/sharedStrings.xml");

  if (!entry) {
    return [];
  }

  return Array.from(entry.getData().toString("utf8").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)).map((match) =>
    extractOpenXmlText(match[1] ?? "")
  );
}

function parseXlsxSheetNames(zip: AdmZip) {
  const entry = zip.getEntry("xl/workbook.xml");

  if (!entry) {
    return [];
  }

  return Array.from(entry.getData().toString("utf8").matchAll(/<sheet\b([^>]*)\/?>/gu)).map((match) =>
    decodeXmlEntities(getXmlAttribute(match[1] ?? "", "name") || "Sheet")
  );
}

function parseXlsxRows(xml: string, sharedStrings: string[]) {
  return Array.from(xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu))
    .map((rowMatch) =>
      Array.from((rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu))
        .map((cellMatch) => parseXlsxCell(cellMatch[1] ?? "", cellMatch[2] ?? "", sharedStrings))
        .join("\t")
        .trim()
    )
    .filter(Boolean);
}

function parseXlsxCell(attributes: string, xml: string, sharedStrings: string[]) {
  const type = getXmlAttribute(attributes, "t");

  if (type === "inlineStr") {
    return extractOpenXmlText(xml);
  }

  const value = decodeXmlEntities(xml.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? "").trim();

  if (type === "s") {
    return sharedStrings[Number(value)] ?? value;
  }

  return value;
}

function extractOpenXmlText(xml: string) {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\s*\/>/gu, "\t")
      .replace(/<a:br\s*\/>|<w:br\s*\/>/gu, "\n")
      .replace(/<\/(?:w:p|a:p|si)>/gu, "\n")
      .replace(/<[^>]+>/gu, "")
  )
    .replace(/[^\S\n\t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getXmlAttribute(input: string, name: string) {
  const match = input.match(new RegExp(`\\b${name}="([^"]*)"`, "u"));
  return match?.[1];
}

function decodeXmlEntities(input: string) {
  return input
    .replace(/&#x([0-9a-f]+);/giu, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/gu, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function isTextLikeSlackFile(file: SlackFile) {
  const mimetype = file.mimetype?.toLowerCase() ?? "";
  const filetype = file.filetype?.toLowerCase() ?? "";

  if (mimetype.startsWith("text/") || TEXT_ATTACHMENT_MIMETYPES.has(mimetype)) {
    return true;
  }

  if (TEXT_ATTACHMENT_FILETYPES.has(filetype)) {
    return true;
  }

  return hasSlackFileExtension(file, TEXT_ATTACHMENT_EXTENSIONS);
}

function isTextualHttpContent(contentType: string) {
  const mimetype = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mimetype.startsWith("text/") || TEXT_ATTACHMENT_MIMETYPES.has(mimetype);
}

function isHtmlLikeSlackFile(file: SlackFile) {
  const mimetype = file.mimetype?.toLowerCase() ?? "";
  const filetype = file.filetype?.toLowerCase() ?? "";

  return mimetype === "text/html" || filetype === "html" || hasSlackFileExtension(file, [".html", ".htm"]);
}

function getUnsupportedSlackAttachmentReason(file: SlackFile) {
  const mimetype = file.mimetype?.toLowerCase() ?? "";
  const filetype = file.filetype?.toLowerCase() ?? "";

  if (mimetype === "application/pdf" || filetype === "pdf" || hasSlackFileExtension(file, PDF_ATTACHMENT_EXTENSIONS)) {
    return undefined;
  }

  if (
    WORD_ATTACHMENT_MIMETYPES.has(mimetype) ||
    WORD_ATTACHMENT_FILETYPES.has(filetype) ||
    hasSlackFileExtension(file, WORD_ATTACHMENT_EXTENSIONS)
  ) {
    return "legacy .doc extraction is not supported; upload .docx for full text extraction";
  }

  if (
    SPREADSHEET_ATTACHMENT_MIMETYPES.has(mimetype) ||
    SPREADSHEET_ATTACHMENT_FILETYPES.has(filetype) ||
    hasSlackFileExtension(file, SPREADSHEET_ATTACHMENT_EXTENSIONS)
  ) {
    return "legacy .xls and Numbers extraction are not supported; upload .xlsx or CSV/TSV for full text extraction";
  }

  return undefined;
}

function hasSlackFileExtension(file: SlackFile, extensions: string[]) {
  const names = [file.name, file.title].filter((value): value is string => Boolean(value));
  return names.some((name) => {
    const normalizedName = name.toLowerCase();
    return extensions.some((extension) => normalizedName.endsWith(extension));
  });
}

function decodeSlackTextBytes(bytes: Buffer, contentType: string) {
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim().toLowerCase();

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }

  if (charset === "utf-16le" || charset === "utf16le") {
    return bytes.toString("utf16le");
  }

  return bytes.toString("utf8");
}

function limitAttachmentText(input: string) {
  const normalized = decodeSlackEntities(input)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  const maxChars = getSlackAttachmentTextMaxChars();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}

function looksBinary(bytes: Buffer) {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8000));

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
}

function formatByteCount(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

    const fileSummary = await formatSlackFileForModel(token, file);
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

  const bytes = await readSlackResponseBuffer(response, MAX_SLACK_IMAGE_BYTES);
  const contentType = response.headers.get("content-type") ?? "";

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

  if (error instanceof SlackDownloadTooLargeError || message.includes("Slack file download is too large")) {
    return `I can see the image attachment, but it is too large to inspect. The image limit is ${formatByteCount(MAX_SLACK_IMAGE_BYTES)}.`;
  }

  if (message.includes("files:read") || message.includes("returned HTML instead of image bytes")) {
    return "I can see the image attachment, but this Slack app still can't download files. Add the `files:read` scope to the app, reinstall it to the workspace, and then try again.";
  }

  if (message.includes("Failed to decode image")) {
    return "I can see the image attachment, but the file download Slack returned was not a valid image payload. The most likely fix is adding `files:read` to the Slack app and reinstalling it.";
  }

  return null;
}

async function readSlackResponseBuffer(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SlackDownloadTooLargeError(contentLength, maxBytes);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new SlackDownloadTooLargeError(totalBytes, maxBytes);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks, totalBytes);
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  acquireActiveListeningReplySlot,
  acknowledgeTargetedSlackEvent,
  buildLiveUserContent,
  buildSlackAppHomeView,
  buildSlackMessageContent,
  createSlackNativeAiTarget,
  createSlackReplyStreamer,
  getActiveListeningMaxConcurrentReplies,
  getSlackAgentSessionTitle,
  getSlackAttachmentTextMaxChars,
  getSlackTextAttachmentMaxBytes,
  getSlackEventLockKey,
  removeSlackAcknowledgement,
  resetSlackNativeAiState() {
    slackNativeAiUnavailableReason = null;
    slackNativeAiClientFactory = (token) =>
      new WebClient(token) as unknown as SlackNativeAiClient;
  },
  setSlackNativeAiClientFactory(factory: SlackNativeAiClientFactory) {
    slackNativeAiUnavailableReason = null;
    slackNativeAiClientFactory = factory;
  }
};

function getSlackContextMessageLimit() {
  const rawValue = process.env.SLACK_CONTEXT_MESSAGES;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 2) {
    return DEFAULT_SLACK_CONTEXT_MESSAGES;
  }

  return parsedValue;
}

function getSlackTextAttachmentMaxBytes() {
  const rawValue = process.env.SLACK_TEXT_ATTACHMENT_MAX_BYTES;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 1024) {
    return DEFAULT_SLACK_TEXT_ATTACHMENT_MAX_BYTES;
  }

  return Math.min(parsedValue, 2 * 1024 * 1024);
}

function getSlackAttachmentTextMaxChars() {
  const rawValue = process.env.SLACK_ATTACHMENT_TEXT_MAX_CHARS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 500) {
    return DEFAULT_SLACK_ATTACHMENT_TEXT_MAX_CHARS;
  }

  return Math.min(parsedValue, 20000);
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
