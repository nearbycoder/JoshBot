import { randomUUID } from "node:crypto";
import { getRedisClient } from "./redis.js";
import {
  cancelScheduleById,
  createScheduleFromTool,
  type SlackScheduleContext
} from "./schedules.js";

export type ThreadFollowUpDraft = {
  task: string;
  assigneeUserId?: string;
  assigneeName?: string;
  dueAt?: string;
  source?: string;
};

export type ThreadFollowUpRecord = ThreadFollowUpDraft & {
  id: string;
  channel: string;
  threadTs: string;
  sourceTs: string;
  createdAt: string;
  createdByUserId: string;
  status: "open" | "done";
  completedAt?: string;
  completedByUserId?: string;
  scheduleId?: string;
  scheduleOwnerUserId?: string;
  scheduleError?: string;
};

export type TrackThreadFollowUpsResult =
  | {
      ok: true;
      created: ThreadFollowUpRecord[];
      skipped: number;
    }
  | {
      ok: false;
      reason: string;
    };

type FollowUpSkillCommand =
  | { action: "track" }
  | { action: "list"; scope: "thread" | "mine" }
  | { action: "done"; idPrefix: string }
  | { action: "help" }
  | { action: "usage" };

const FOLLOW_UP_RECORD_PREFIX = "follow-ups:record:";
const FOLLOW_UP_THREAD_PREFIX = "follow-ups:thread:";
const FOLLOW_UP_USER_PREFIX = "follow-ups:user:";
const MAX_FOLLOW_UPS_PER_RUN = 10;
const MAX_TASK_LENGTH = 500;

export async function trackThreadFollowUps(
  context: SlackScheduleContext,
  drafts: ThreadFollowUpDraft[]
): Promise<TrackThreadFollowUpsResult> {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false,
      reason: "Follow-up tracking requires REDIS_URL."
    };
  }

  const normalizedDrafts = normalizeFollowUpDrafts(drafts);
  const created: ThreadFollowUpRecord[] = [];

  for (const draft of normalizedDrafts) {
    const id = randomUUID();
    const scheduleOwnerUserId = draft.assigneeUserId ?? context.ownerUserId;
    const record: ThreadFollowUpRecord = {
      ...draft,
      id,
      channel: context.channel,
      threadTs: context.threadTs,
      sourceTs: context.sourceTs,
      createdAt: new Date().toISOString(),
      createdByUserId: context.ownerUserId,
      status: "open"
    };

    if (draft.dueAt && isFutureDate(draft.dueAt)) {
      try {
        const schedule = await createScheduleFromTool(
          {
            ...context,
            ownerUserId: scheduleOwnerUserId,
            sourceTs: `${context.sourceTs}:${id}`
          },
          {
            kind: "at",
            task: buildFollowUpReminderTask(record),
            runAt: draft.dueAt,
            responseMode: "reminder"
          }
        );
        record.scheduleId = schedule.id;
        record.scheduleOwnerUserId = scheduleOwnerUserId;
      } catch (error) {
        record.scheduleError = summarizeError(error);
      }
    }

    await saveFollowUpRecord(record);
    created.push(record);
  }

  return {
    ok: true,
    created,
    skipped: Math.max(0, drafts.length - normalizedDrafts.length)
  };
}

export async function listThreadFollowUps(context: SlackScheduleContext) {
  const redis = await getRedisClient();

  if (!redis) {
    return "Follow-up tracking requires REDIS_URL.";
  }

  const ids = await redis.sMembers(getFollowUpThreadKey(context.channel, context.threadTs));
  return formatFollowUpList(await loadOpenFollowUps(ids), "this thread");
}

export async function listUserFollowUps(userId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return "Follow-up tracking requires REDIS_URL.";
  }

  const ids = await redis.sMembers(getFollowUpUserKey(userId));
  return formatFollowUpList(await loadOpenFollowUps(ids), "you");
}

export async function completeFollowUp(context: SlackScheduleContext, idPrefix: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return "Follow-up tracking requires REDIS_URL.";
  }

  const match = await findFollowUpByPrefix(context, idPrefix);

  if (!match.ok) {
    return match.message;
  }

  const record = {
    ...match.record,
    status: "done" as const,
    completedAt: new Date().toISOString(),
    completedByUserId: context.ownerUserId
  };

  await redis.set(getFollowUpRecordKey(record.id), JSON.stringify(record));

  if (record.scheduleId && record.scheduleOwnerUserId) {
    try {
      await cancelScheduleById(record.scheduleId, record.scheduleOwnerUserId);
    } catch (error) {
      return `Marked follow-up \`${record.id.slice(0, 8)}\` done, but couldn't cancel its reminder: ${summarizeError(error)}`;
    }
  }

  return `Marked follow-up \`${record.id.slice(0, 8)}\` done.`;
}

export function parseFollowUpSkillCommand(args: string): FollowUpSkillCommand {
  const trimmed = args.trim();

  if (!trimmed || /^(track|extract|scan|create)$/i.test(trimmed)) {
    return { action: "track" };
  }

  if (/^help$/i.test(trimmed)) {
    return { action: "help" };
  }

  if (/^(list|show)$/i.test(trimmed)) {
    return { action: "list", scope: "thread" };
  }

  if (/^(my|mine|list mine|list my|show mine|show my)$/i.test(trimmed)) {
    return { action: "list", scope: "mine" };
  }

  const doneMatch = trimmed.match(/^(done|complete|close|resolve)\s+([a-z0-9-]+)$/i);
  if (doneMatch) {
    return { action: "done", idPrefix: doneMatch[2] ?? "" };
  }

  return { action: "usage" };
}

export function parseFollowUpExtraction(input: string) {
  const jsonText = extractJsonText(input);

  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const candidates = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.followUps)
        ? parsed.followUps
        : [];

    return normalizeFollowUpDrafts(candidates);
  } catch {
    return [];
  }
}

export function normalizeFollowUpDrafts(input: unknown[]): ThreadFollowUpDraft[] {
  return input
    .map(normalizeFollowUpDraft)
    .filter((draft): draft is ThreadFollowUpDraft => draft !== null)
    .slice(0, MAX_FOLLOW_UPS_PER_RUN);
}

export function formatTrackThreadFollowUpsResult(result: TrackThreadFollowUpsResult) {
  if (!result.ok) {
    return result.reason;
  }

  if (result.created.length === 0) {
    return "No clear trackable follow-ups found in this thread.";
  }

  const noun = result.created.length === 1 ? "follow-up" : "follow-ups";
  return [
    `Tracked ${result.created.length} ${noun}:`,
    ...result.created.map((record) => `- ${formatFollowUpRecord(record)}`)
  ].join("\n");
}

export function formatFollowUpHelp() {
  return [
    "*NoBo follow-ups*",
    "`@NoBo follow-ups`: extract and track action items from this thread",
    "`@NoBo follow-ups list`: list open follow-ups for this thread",
    "`@NoBo follow-ups mine`: list follow-ups assigned to or created by you",
    "`@NoBo follow-ups done <id>`: mark a follow-up done"
  ].join("\n");
}

async function saveFollowUpRecord(record: ThreadFollowUpRecord) {
  const redis = await requireRedis();

  await redis.set(getFollowUpRecordKey(record.id), JSON.stringify(record));
  await redis.sAdd(getFollowUpThreadKey(record.channel, record.threadTs), record.id);
  await redis.sAdd(getFollowUpUserKey(record.createdByUserId), record.id);

  if (record.assigneeUserId) {
    await redis.sAdd(getFollowUpUserKey(record.assigneeUserId), record.id);
  }
}

async function findFollowUpByPrefix(
  context: SlackScheduleContext,
  idPrefix: string
): Promise<
  | { ok: true; record: ThreadFollowUpRecord }
  | { ok: false; message: string }
> {
  const redis = await requireRedis();
  const normalizedPrefix = idPrefix.trim();

  if (!normalizedPrefix) {
    return { ok: false, message: "Tell me the follow-up ID to use." };
  }

  const ids = Array.from(
    new Set([
      ...(await redis.sMembers(getFollowUpThreadKey(context.channel, context.threadTs))),
      ...(await redis.sMembers(getFollowUpUserKey(context.ownerUserId)))
    ])
  );
  const matches = ids.filter((id) => id.startsWith(normalizedPrefix));

  if (matches.length === 0) {
    return { ok: false, message: "I couldn't find a follow-up with that ID." };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      message: `That ID matches more than one follow-up. Use a longer ID:\n${matches
        .map((id) => `- \`${id.slice(0, 12)}\``)
        .join("\n")}`
    };
  }

  const record = await loadFollowUp(matches[0] ?? "");

  if (!record) {
    return { ok: false, message: "That follow-up no longer exists." };
  }

  return { ok: true, record };
}

async function loadOpenFollowUps(ids: string[]) {
  const records = (await Promise.all(ids.map((id) => loadFollowUp(id)))).filter(
    (record): record is ThreadFollowUpRecord => record !== null && record.status === "open"
  );

  return records.sort((left, right) => {
    const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;

    if (leftDue !== rightDue) {
      return leftDue - rightDue;
    }

    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

async function loadFollowUp(id: string) {
  const redis = await requireRedis();
  const payload = await redis.get(getFollowUpRecordKey(id));

  if (!payload) {
    return null;
  }

  return parseFollowUpRecord(payload);
}

function parseFollowUpRecord(payload: string) {
  try {
    const parsed = JSON.parse(payload) as unknown;

    if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.task !== "string") {
      return null;
    }

    return parsed as ThreadFollowUpRecord;
  } catch {
    return null;
  }
}

function formatFollowUpList(records: ThreadFollowUpRecord[], scope: string) {
  if (records.length === 0) {
    return `No open follow-ups for ${scope}.`;
  }

  return `Open follow-ups for ${scope}:\n${records
    .map((record) => `- ${formatFollowUpRecord(record)}`)
    .join("\n")}`;
}

function formatFollowUpRecord(record: ThreadFollowUpRecord) {
  const owner = record.assigneeUserId
    ? `<@${record.assigneeUserId}>`
    : record.assigneeName
      ? record.assigneeName
      : "unassigned";
  const due = record.dueAt ? `, due ${formatDateTime(new Date(record.dueAt))}` : "";
  const reminder = record.scheduleId
    ? `, reminder \`${record.scheduleId.slice(0, 8)}\``
    : record.dueAt && isFutureDate(record.dueAt)
      ? `, reminder not scheduled${record.scheduleError ? `: ${record.scheduleError}` : ""}`
      : "";

  return `\`${record.id.slice(0, 8)}\` ${owner}${due}${reminder}: ${record.task}`;
}

function buildFollowUpReminderTask(record: ThreadFollowUpRecord) {
  const owner = record.assigneeName ? ` (${record.assigneeName})` : "";
  return `Follow-up due${owner}: ${record.task}`;
}

function normalizeFollowUpDraft(input: unknown): ThreadFollowUpDraft | null {
  if (!isRecord(input)) {
    return null;
  }

  const task = normalizeTask(firstString(input.task, input.todo, input.action, input.text));

  if (!task) {
    return null;
  }

  const assigneeUserId = normalizeSlackUserId(
    firstString(input.assigneeUserId, input.ownerUserId, input.ownerId, input.userId)
  );
  const assigneeName = firstString(input.assigneeName, input.ownerName, input.owner, input.assignee);
  const dueAt = normalizeDueAt(firstString(input.dueAt, input.dueDate, input.due));
  const source = firstString(input.source, input.evidence);

  return {
    task,
    ...(assigneeUserId ? { assigneeUserId } : {}),
    ...(assigneeName && !assigneeUserId ? { assigneeName: assigneeName.slice(0, 80) } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(source ? { source: source.slice(0, 240) } : {})
  };
}

function firstString(...values: unknown[]) {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeTask(input: string | undefined) {
  return (input ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .trim()
    .slice(0, MAX_TASK_LENGTH);
}

function normalizeSlackUserId(input: string | undefined) {
  const match = input?.match(/@?([UW][A-Z0-9]{2,})/i);
  return match?.[1]?.toUpperCase();
}

function normalizeDueAt(input: string | undefined) {
  if (!input) {
    return undefined;
  }

  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function extractJsonText(input: string) {
  const fenceMatch = input.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return input.slice(start, end + 1);
  }

  if (input.trim().startsWith("[") && input.trim().endsWith("]")) {
    return input.trim();
  }

  return null;
}

function isFutureDate(input: string) {
  return new Date(input).getTime() > Date.now();
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago"
  }).format(date);
}

async function requireRedis() {
  const redis = await getRedisClient();

  if (!redis) {
    throw new Error("Follow-up tracking requires REDIS_URL.");
  }

  return redis;
}

function getFollowUpRecordKey(id: string) {
  return `${FOLLOW_UP_RECORD_PREFIX}${id}`;
}

function getFollowUpThreadKey(channel: string, threadTs: string) {
  return `${FOLLOW_UP_THREAD_PREFIX}${channel}:${threadTs}`;
}

function getFollowUpUserKey(userId: string) {
  return `${FOLLOW_UP_USER_PREFIX}${userId}`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  buildFollowUpReminderTask,
  getFollowUpRecordKey,
  getFollowUpThreadKey,
  getFollowUpUserKey,
  normalizeFollowUpDrafts,
  parseFollowUpExtraction,
  parseFollowUpSkillCommand
};
