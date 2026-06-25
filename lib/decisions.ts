import { randomUUID } from "node:crypto";
import { getRedisClient } from "./redis.js";

const DEFAULT_DECISION_LOG_MAX_ITEMS = 50;

export type ChannelDecision = {
  id: string;
  channelId: string;
  text: string;
  createdAt: string;
  userId?: string;
  threadTs?: string;
  messageTs?: string;
  threadUrl?: string;
  source: "slack-message" | "slash-command";
};

export type DecisionIntent =
  | { action: "add"; text: string }
  | { action: "list" }
  | { action: "help" };

export function parseDecisionIntent(input: string): DecisionIntent | null {
  const trimmed = collapseWhitespace(input);

  if (!trimmed) {
    return null;
  }

  if (/^(?:decision(?:s)?|decision\s+log|decision-log)\s+help$/i.test(trimmed)) {
    return { action: "help" };
  }

  const prefixedAddMatch = trimmed.match(
    /^(?:decision(?:s)?|decision\s+log|decision-log)\s+(?:add|record|log|capture)\s+(.+)$/i
  );
  if (prefixedAddMatch) {
    return addIntent(prefixedAddMatch[1] ?? "");
  }

  const naturalAddMatch = trimmed.match(
    /^(?:log|record|capture|add)\s+(?:a\s+)?decision(?:\s+that)?\s*:?\s+(.+)$/i
  );
  if (naturalAddMatch) {
    return addIntent(naturalAddMatch[1] ?? "");
  }

  const decidedMatch = trimmed.match(
    /^(?:we|we've|we have|team|the team)\s+(?:decided|agreed)\s*(?::|\b(?:that|to|on)\b)?\s+(.+)$/i
  );
  if (decidedMatch) {
    return addIntent(decidedMatch[1] ?? "");
  }

  if (
    /^(?:decision(?:s)?|decision\s+log|decision-log)$/i.test(trimmed) ||
    /^(?:decision(?:s)?|decision\s+log|decision-log)\s+(?:list|show)$/i.test(trimmed) ||
    /^(?:list|show)\s+(?:the\s+)?(?:channel\s+)?decisions?$/i.test(trimmed)
  ) {
    return { action: "list" };
  }

  return null;
}

export async function addChannelDecision({
  channelId,
  text,
  userId,
  threadTs,
  messageTs,
  threadUrl,
  createdAt = new Date().toISOString(),
  source
}: {
  channelId: string;
  text: string;
  userId?: string;
  threadTs?: string;
  messageTs?: string;
  threadUrl?: string;
  createdAt?: string;
  source: ChannelDecision["source"];
}) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const decisionText = normalizeDecisionText(text);

  if (!decisionText) {
    return {
      ok: false as const,
      reason: "Decision cannot be empty."
    };
  }

  const decision: ChannelDecision = {
    id: randomUUID(),
    channelId,
    text: decisionText,
    createdAt,
    source,
    ...(userId ? { userId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(messageTs ? { messageTs } : {}),
    ...(threadUrl ? { threadUrl } : {})
  };
  const decisions = await getChannelDecisionRecords(channelId);
  const nextDecisions = [...decisions, decision].slice(-DEFAULT_DECISION_LOG_MAX_ITEMS);

  await redis.set(getDecisionLogKey(channelId), JSON.stringify({ decisions: nextDecisions }));

  return {
    ok: true as const,
    decision,
    decisions: nextDecisions
  };
}

export async function listChannelDecisions(channelId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  return {
    ok: true as const,
    decisions: await getChannelDecisionRecords(channelId)
  };
}

export function formatDecisionHelp() {
  return [
    "*NoBo decision log*",
    "`/nobo-decisions add <decision>`: save a channel decision",
    "`/nobo-decisions list`: list recent channel decisions",
    "`@NoBo decision add <decision>` and `@NoBo decisions` work too",
    "NoBo also catches explicit `we decided ...` messages it receives."
  ].join("\n");
}

export function formatDecisionAdded(decision: ChannelDecision) {
  const link = decision.threadUrl
    ? `\nThread: <${decision.threadUrl}|${formatDecisionDate(decision.createdAt)}>`
    : "";

  return `Logged decision: ${decision.text}${link}`;
}

export function formatChannelDecisionList(decisions: ChannelDecision[]) {
  if (decisions.length === 0) {
    return "No channel decisions logged yet.";
  }

  return [
    "*Channel decisions*",
    ...[...decisions].reverse().map((decision, index) => {
      const date = formatDecisionLink(decision);
      const author = decision.userId ? ` by <@${decision.userId}>` : "";
      return `${index + 1}. ${date}${author}: ${decision.text}`;
    })
  ].join("\n");
}

function addIntent(text: string): DecisionIntent {
  return {
    action: "add",
    text: normalizeDecisionText(text)
  };
}

function getDecisionLogKey(channelId: string) {
  return `slack-channel-decisions:${channelId}`;
}

async function getChannelDecisionRecords(channelId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return [];
  }

  const payload = await redis.get(getDecisionLogKey(channelId));

  if (!payload) {
    return [];
  }

  return parseDecisionLogPayload(payload).filter((decision) => decision.channelId === channelId);
}

function parseDecisionLogPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { decisions?: unknown } | unknown[];
    const decisions = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.decisions)
        ? parsed.decisions
        : [];

    return decisions
      .map(normalizeChannelDecision)
      .filter((decision): decision is ChannelDecision => decision !== null);
  } catch {
    return [];
  }
}

function normalizeChannelDecision(input: unknown): ChannelDecision | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Partial<Record<keyof ChannelDecision, unknown>>;
  const id = typeof record.id === "string" ? record.id : "";
  const channelId = typeof record.channelId === "string" ? record.channelId : "";
  const text = typeof record.text === "string" ? normalizeDecisionText(record.text) : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  const source = record.source === "slash-command" ? "slash-command" : "slack-message";

  if (!id || !channelId || !text || !createdAt) {
    return null;
  }

  return {
    id,
    channelId,
    text,
    createdAt,
    source,
    ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
    ...(typeof record.threadTs === "string" ? { threadTs: record.threadTs } : {}),
    ...(typeof record.messageTs === "string" ? { messageTs: record.messageTs } : {}),
    ...(typeof record.threadUrl === "string" ? { threadUrl: record.threadUrl } : {})
  };
}

function normalizeDecisionText(input: string) {
  return collapseWhitespace(input).replace(/[.!?]+$/g, "").trim();
}

function formatDecisionLink(decision: ChannelDecision) {
  const date = formatDecisionDate(decision.createdAt);
  return decision.threadUrl ? `<${decision.threadUrl}|${date}>` : date;
}

function formatDecisionDate(input: string) {
  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    return input.slice(0, 10) || "unknown date";
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

export const __testing = {
  getDecisionLogKey,
  normalizeDecisionText,
  parseDecisionLogPayload
};
