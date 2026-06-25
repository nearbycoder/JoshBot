import { fetchSlackChannelHistory } from "./channel-history.js";
import { listChannelDecisions } from "./decisions.js";
import { listThreadFollowUps, listUserFollowUps } from "./follow-ups.js";
import type { ChannelMemoryEntry } from "./memory.js";
import type { NoboModelMessage } from "./nobo-messages.js";
import {
  getUserScheduleDashboardItems,
  type ScheduleDashboardItem,
  type SlackScheduleContext
} from "./schedules.js";

export type AttentionBucket = "urgent" | "reply" | "follow_up" | "decision" | "schedule";

export type AttentionSourceMessage = {
  ts?: string;
  datetime?: string;
  speaker: string;
  text: string;
};

export type AttentionItem = {
  bucket: AttentionBucket;
  priority: number;
  title: string;
  detail: string;
  source?: string;
};

export type AttentionTriageReport = {
  items: AttentionItem[];
  scanned: {
    messages: number;
    decisions: number;
    followUps: number;
    schedules: number;
  };
};

type BuildAttentionTriageOptions = {
  channelId?: string;
  currentUserId?: string;
  modelMessages: NoboModelMessage[];
  channelMemories?: ChannelMemoryEntry[];
  scheduleContext?: SlackScheduleContext;
  fetchHistory?: typeof fetchSlackChannelHistory;
  getSchedules?: typeof getUserScheduleDashboardItems;
};

const DEFAULT_HISTORY_DAYS = 2;
const DEFAULT_HISTORY_LIMIT = 80;
const MAX_ITEMS = 8;

export async function buildAttentionTriageReport({
  channelId,
  currentUserId,
  modelMessages,
  channelMemories = [],
  scheduleContext,
  fetchHistory = fetchSlackChannelHistory,
  getSchedules = getUserScheduleDashboardItems
}: BuildAttentionTriageOptions): Promise<AttentionTriageReport> {
  const messages = [
    ...messagesFromModelMessages(modelMessages),
    ...messagesFromChannelMemories(channelMemories),
    ...(await safeFetchRecentHistory(channelId, fetchHistory))
  ];
  const decisions = await safeLoadDecisions(channelId);
  const followUps = await safeLoadFollowUps(scheduleContext, currentUserId);
  const schedules = currentUserId ? await safeLoadSchedules(currentUserId, getSchedules) : [];

  return createAttentionTriageReport({
    messages,
    currentUserId,
    decisions,
    followUps,
    schedules
  });
}

export function createAttentionTriageReport({
  messages,
  currentUserId,
  decisions = [],
  followUps = [],
  schedules = [],
  now = new Date()
}: {
  messages: AttentionSourceMessage[];
  currentUserId?: string;
  decisions?: string[];
  followUps?: string[];
  schedules?: ScheduleDashboardItem[];
  now?: Date;
}): AttentionTriageReport {
  const messageItems = messages.flatMap((message) =>
    parseAttentionItemsFromMessage(message, currentUserId)
  );
  const decisionItems = decisions.map((decision) => ({
    bucket: "decision" as const,
    priority: 40,
    title: "Recent decision",
    detail: decision,
    source: "decision log"
  }));
  const followUpItems = followUps.map((followUp) => ({
    bucket: "follow_up" as const,
    priority: 75,
    title: "Open follow-up",
    detail: followUp,
    source: "follow-up tracker"
  }));
  const scheduleItems = schedules.map((schedule) => ({
    bucket: "schedule" as const,
    priority: schedulePriority(schedule, now),
    title: "Upcoming reminder",
    detail: `${schedule.summary} (${schedule.nextRunAt})`,
    source: `schedule ${schedule.id.slice(0, 8)}`
  }));
  const items = rankAttentionItems([
    ...messageItems,
    ...decisionItems,
    ...followUpItems,
    ...scheduleItems
  ]).slice(0, MAX_ITEMS);

  return {
    items,
    scanned: {
      messages: messages.length,
      decisions: decisions.length,
      followUps: followUps.length,
      schedules: schedules.length
    }
  };
}

export function parseAttentionItemsFromMessage(
  message: AttentionSourceMessage,
  currentUserId?: string
): AttentionItem[] {
  const text = normalizeText(message.text);

  if (!text) {
    return [];
  }

  const source = formatMessageSource(message);
  const items: AttentionItem[] = [];
  const mentionsCurrentUser = currentUserId ? mentionsUser(text, currentUserId) : false;
  const urgent = /\b(urgent|asap|blocked|blocker|stuck|broken|failing|outage|incident|deadline|overdue)\b/i.test(text);
  const question = /\?/.test(text) || /\b(can you|could you|will you|do you|are you|please confirm)\b/i.test(text);
  const followUp = /\b(todo|to do|action item|follow up|follow-up|please|need to|needs to|owner|by eod|by tomorrow|due)\b/i.test(text);
  const decision = /\b(we decided|we agreed|decision:|decided to|agreed to)\b/i.test(text);

  if (urgent || (mentionsCurrentUser && /\b(need|blocked|asap|urgent|please)\b/i.test(text))) {
    items.push({
      bucket: "urgent",
      priority: mentionsCurrentUser ? 100 : 90,
      title: mentionsCurrentUser ? "Direct urgent mention" : "Urgent thread signal",
      detail: text,
      source
    });
  }

  if (mentionsCurrentUser || question) {
    items.push({
      bucket: "reply",
      priority: mentionsCurrentUser ? 85 : 65,
      title: mentionsCurrentUser ? "Needs your reply" : "Open question",
      detail: text,
      source
    });
  }

  if (followUp) {
    items.push({
      bucket: "follow_up",
      priority: mentionsCurrentUser ? 80 : 60,
      title: "Possible follow-up",
      detail: text,
      source
    });
  }

  if (decision) {
    items.push({
      bucket: "decision",
      priority: 45,
      title: "Decision to note",
      detail: text,
      source
    });
  }

  return items;
}

export function rankAttentionItems(items: AttentionItem[]) {
  const deduped = new Map<string, AttentionItem>();

  for (const item of items) {
    const key = `${item.bucket}:${item.detail.toLowerCase()}`;
    const existing = deduped.get(key);

    if (!existing || item.priority > existing.priority) {
      deduped.set(key, item);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }

    return bucketRank(left.bucket) - bucketRank(right.bucket);
  });
}

export function formatAttentionTriageReport(report: AttentionTriageReport) {
  if (report.items.length === 0) {
    return [
      "*What needs your attention?*",
      "Nothing obvious right now.",
      `Scanned ${formatScannedCounts(report)}.`
    ].join("\n");
  }

  return [
    "*What needs your attention?*",
    ...report.items.map((item, index) => {
      const source = item.source ? ` _${item.source}_` : "";
      return `${index + 1}. *${formatBucket(item.bucket)}*: ${item.title} - ${item.detail}${source}`;
    }),
    `Scanned ${formatScannedCounts(report)}.`
  ].join("\n");
}

function messagesFromModelMessages(messages: NoboModelMessage[]): AttentionSourceMessage[] {
  return messages.flatMap((message) => {
    const text = modelMessageText(message);

    return text
      ? [{
          speaker: message.role === "assistant" ? "NoBo" : "Slack thread",
          text
        }]
      : [];
  });
}

function messagesFromChannelMemories(memories: ChannelMemoryEntry[]): AttentionSourceMessage[] {
  return memories.flatMap((memory) => {
    const text = normalizeText(memory.content);

    return text
      ? [{
          speaker: memory.role === "assistant" ? "NoBo" : "Recent channel",
          text,
          ts: memory.ts
        }]
      : [];
  });
}

async function safeFetchRecentHistory(
  channelId: string | undefined,
  fetchHistory: typeof fetchSlackChannelHistory
) {
  if (!channelId || !process.env.SLACK_BOT_TOKEN) {
    return [];
  }

  try {
    return await fetchHistory({
      channel: channelId,
      days: DEFAULT_HISTORY_DAYS,
      limit: DEFAULT_HISTORY_LIMIT
    });
  } catch (error) {
    console.warn(`Attention triage could not load Slack history: ${summarizeError(error)}`);
    return [];
  }
}

async function safeLoadDecisions(channelId: string | undefined) {
  if (!channelId) {
    return [];
  }

  try {
    const result = await listChannelDecisions(channelId);

    return result.ok ? result.decisions.map((decision) => decision.text) : [];
  } catch {
    return [];
  }
}

async function safeLoadFollowUps(
  scheduleContext: SlackScheduleContext | undefined,
  currentUserId: string | undefined
) {
  const chunks: string[] = [];

  try {
    if (scheduleContext) {
      chunks.push(...extractListItems(await listThreadFollowUps(scheduleContext)));
    }

    if (currentUserId) {
      chunks.push(...extractListItems(await listUserFollowUps(currentUserId)));
    }
  } catch {
    return [];
  }

  return [...new Set(chunks)];
}

async function safeLoadSchedules(
  userId: string,
  getSchedules: typeof getUserScheduleDashboardItems
) {
  try {
    return await getSchedules(userId, 5);
  } catch {
    return [];
  }
}

function modelMessageText(message: NoboModelMessage) {
  if (typeof message.content === "string") {
    return normalizeText(message.content);
  }

  return normalizeText(
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
  );
}

function extractListItems(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && !/^(no clear|you don't have|follow-up tracking requires)/i.test(line))
    .slice(0, 10);
}

function schedulePriority(schedule: ScheduleDashboardItem, now: Date) {
  const next = new Date(schedule.nextRunAt).getTime();

  if (!Number.isFinite(next)) {
    return 50;
  }

  const hours = (next - now.getTime()) / (60 * 60 * 1000);

  if (hours <= 0) {
    return 95;
  }

  if (hours <= 24) {
    return 70;
  }

  return 50;
}

function mentionsUser(text: string, userId: string) {
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:<@${escaped}>|@${escaped}|\\b${escaped}\\b)`, "i").test(text);
}

function formatMessageSource(message: AttentionSourceMessage) {
  const when = message.datetime ? ` ${message.datetime}` : message.ts ? ` ${message.ts}` : "";
  return `${message.speaker}${when}`.trim();
}

function formatScannedCounts(report: AttentionTriageReport) {
  return `${report.scanned.messages} messages, ${report.scanned.followUps} follow-ups, ${report.scanned.decisions} decisions, ${report.scanned.schedules} schedules`;
}

function normalizeText(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function bucketRank(bucket: AttentionBucket) {
  return ["urgent", "reply", "follow_up", "schedule", "decision"].indexOf(bucket);
}

function formatBucket(bucket: AttentionBucket) {
  if (bucket === "follow_up") {
    return "Follow-up";
  }

  return bucket[0]?.toUpperCase() + bucket.slice(1);
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  createAttentionTriageReport,
  parseAttentionItemsFromMessage,
  rankAttentionItems,
  formatAttentionTriageReport
};
