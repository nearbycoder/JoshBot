import { randomUUID } from "node:crypto";
import { requireEnv } from "./env.js";
import { getRedisClient } from "./redis.js";

type SlackMessageEvent = {
  channel: string;
  text: string;
  thread_ts?: string;
  ts: string;
  user?: string;
};

type SlackPostMessage = (options: {
  token: string;
  channel: string;
  threadTs?: string;
  text: string;
}) => Promise<unknown>;

type ScheduledTaskRunner = (options: {
  task: string;
  ownerUserId: string;
}) => Promise<string>;

export type SlackScheduleContext = {
  ownerUserId: string;
  channel: string;
  threadTs: string;
  mentionedChannels: Array<{
    id: string;
    name?: string;
  }>;
};

type ScheduleDestination = {
  channel: string;
  threadTs?: string;
  channelName?: string;
  responseMode: "reminder" | "prompt";
};

type OptionalScheduleDestination = {
  targetChannelId?: string;
  targetChannelName?: string;
  responseMode?: "reminder" | "prompt";
};

export type ScheduleToolInput =
  | {
      kind: "once";
      task: string;
      amount: number | string;
      unit: "minutes" | "hours" | "days";
    } & OptionalScheduleDestination
  | {
      kind: "interval";
      task: string;
      amount: number | string;
      unit: "minutes" | "hours" | "days";
    } & OptionalScheduleDestination
  | {
      kind: "daily";
      task: string;
      hour: number | string;
      minute: number | string;
    } & OptionalScheduleDestination
  | {
      kind: "weekly";
      task: string;
      weekday: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
      hour: number | string;
      minute: number | string;
    } & OptionalScheduleDestination;

type ScheduleKind = "once" | "interval" | "daily" | "weekly";

type ScheduleRecord = {
  id: string;
  ownerUserId: string;
  channel: string;
  threadTs?: string;
  channelName?: string;
  task: string;
  responseMode?: "reminder" | "prompt";
  kind: ScheduleKind;
  createdAt: string;
  nextRunAt: string;
  intervalMs?: number;
  weekday?: number;
  hour?: number;
  minute?: number;
  timezone: "America/Chicago";
};

type ParsedSchedule =
  | {
      kind: "once" | "interval";
      task: string;
      intervalMs: number;
      firstRunAt: Date;
    }
  | {
      kind: "daily";
      task: string;
      hour: number;
      minute: number;
      firstRunAt: Date;
    }
  | {
      kind: "weekly";
      task: string;
      weekday: number;
      hour: number;
      minute: number;
      firstRunAt: Date;
    };

const SCHEDULE_DUE_KEY = "schedules:due";
const SCHEDULE_JOB_PREFIX = "schedules:job:";
const SCHEDULE_USER_PREFIX = "schedules:user:";
const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;
const MAX_DUE_JOBS_PER_TICK = 10;
const MIN_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = new Map([
  ["sunday", 0],
  ["sun", 0],
  ["monday", 1],
  ["mon", 1],
  ["tuesday", 2],
  ["tue", 2],
  ["wednesday", 3],
  ["wed", 3],
  ["thursday", 4],
  ["thu", 4],
  ["friday", 5],
  ["fri", 5],
  ["saturday", 6],
  ["sat", 6]
]);

let schedulerStarted = false;
let schedulerRunning = false;

export async function maybeHandleScheduleCommand(event: SlackMessageEvent) {
  if (!event.user) {
    return null;
  }

  const redis = await getRedisClient();
  if (!redis) {
    return null;
  }

  const text = stripSlackFormatting(event.text);
  const trimmed = text.trim();

  if (/^(list|show)\s+(my\s+)?(reminders|crons|schedules)$/i.test(trimmed)) {
    return listUserSchedules(event.user);
  }

  const cancelMatch = trimmed.match(/^(cancel|delete|remove)\s+(?:reminder|cron|schedule)\s+([a-z0-9-]+)$/i);
  if (cancelMatch) {
    return cancelUserSchedule(event.user, cancelMatch[2] ?? "");
  }

  return null;
}

export function startScheduleRunner({
  postSlackMessage,
  runScheduledTask
}: {
  postSlackMessage: SlackPostMessage;
  runScheduledTask?: ScheduledTaskRunner;
}) {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  const intervalMs = getSchedulerIntervalMs();

  void runDueSchedules({ postSlackMessage, runScheduledTask }).catch((error) => {
    console.error(`Schedule runner failed: ${summarizeError(error)}`);
  });

  setInterval(() => {
    void runDueSchedules({ postSlackMessage, runScheduledTask }).catch((error) => {
      console.error(`Schedule runner failed: ${summarizeError(error)}`);
    });
  }, intervalMs).unref();
}

export async function createScheduleFromTool(
  context: SlackScheduleContext,
  input: ScheduleToolInput
) {
  const parsed = scheduleToolInputToParsedSchedule(input);
  const destination = getScheduleDestination(context, input);
  const schedule = await createSchedule(context, parsed, destination);

  return {
    id: schedule.id,
    summary: formatScheduleSummary(schedule),
    nextRunAt: schedule.nextRunAt
  };
}

export async function listSchedulesFromTool(context: SlackScheduleContext) {
  return getUserScheduleSummaries(context.ownerUserId);
}

export async function cancelScheduleFromTool(context: SlackScheduleContext, idPrefix: string) {
  return cancelUserSchedule(context.ownerUserId, idPrefix);
}

export async function updateScheduleFromTool(
  context: SlackScheduleContext,
  idPrefix: string,
  input: ScheduleToolInput
) {
  const existingSchedule = await findUserScheduleByPrefix(context.ownerUserId, idPrefix);

  if (!existingSchedule.ok) {
    return existingSchedule.message;
  }

  await deleteSchedule(existingSchedule.schedule.id, context.ownerUserId);

  const parsed = scheduleToolInputToParsedSchedule(input);
  const destination = getScheduleDestinationForUpdate(context, input, existingSchedule.schedule);
  const schedule = await createSchedule(context, parsed, destination);

  return `Updated schedule \`${existingSchedule.schedule.id.slice(0, 8)}\` -> \`${schedule.id.slice(0, 8)}\`: ${formatScheduleSummary(schedule)}`;
}

async function createSchedule(
  context: SlackScheduleContext,
  parsed: ParsedSchedule,
  destination: ScheduleDestination
) {
  const redis = await requireRedis();
  const now = new Date();
  const id = randomUUID();
  const base = {
    id,
    ownerUserId: context.ownerUserId,
    channel: destination.channel,
    threadTs: destination.threadTs,
    channelName: destination.channelName,
    task: parsed.task,
    responseMode: destination.responseMode,
    kind: parsed.kind,
    createdAt: now.toISOString(),
    nextRunAt: parsed.firstRunAt.toISOString(),
    timezone: "America/Chicago" as const
  };

  const schedule: ScheduleRecord =
    parsed.kind === "weekly"
      ? {
          ...base,
          weekday: parsed.weekday,
          hour: parsed.hour,
          minute: parsed.minute
        }
      : parsed.kind === "daily"
        ? {
            ...base,
            hour: parsed.hour,
            minute: parsed.minute
          }
        : {
            ...base,
            intervalMs: parsed.intervalMs
          };

  await redis.set(getScheduleJobKey(id), JSON.stringify(schedule));
  await redis.zAdd(SCHEDULE_DUE_KEY, {
    score: parsed.firstRunAt.getTime(),
    value: id
  });
  await redis.sAdd(getScheduleUserKey(schedule.ownerUserId), id);

  return schedule;
}

function getScheduleDestination(
  context: SlackScheduleContext,
  input: ScheduleToolInput
): ScheduleDestination {
  const targetChannel = getTargetChannel(context, input);
  const responseMode = input.responseMode ?? inferResponseMode(input.task);

  if (!targetChannel) {
    return {
      channel: context.channel,
      threadTs: context.threadTs,
      responseMode
    };
  }

  return {
    channel: targetChannel.id,
    channelName: targetChannel.name,
    responseMode
  };
}

function getScheduleDestinationForUpdate(
  context: SlackScheduleContext,
  input: ScheduleToolInput,
  existingSchedule: ScheduleRecord
): ScheduleDestination {
  const requestedDestination = getScheduleDestination(context, input);
  const requestedChannelId = normalizeSlackChannelId(input.targetChannelId);
  const requestedChannelName = input.targetChannelName?.trim();
  const hasExplicitDestination =
    Boolean(requestedChannelId || requestedChannelName || context.mentionedChannels.length === 1);

  if (hasExplicitDestination) {
    return requestedDestination;
  }

  return {
    channel: existingSchedule.channel,
    threadTs: existingSchedule.threadTs,
    channelName: existingSchedule.channelName,
    responseMode: input.responseMode ?? existingSchedule.responseMode ?? inferResponseMode(input.task)
  };
}

function getTargetChannel(context: SlackScheduleContext, input: OptionalScheduleDestination) {
  const targetChannelId = normalizeSlackChannelId(input.targetChannelId);

  if (targetChannelId) {
    const mentionedChannel = context.mentionedChannels.find((channel) => channel.id === targetChannelId);
    return {
      id: targetChannelId,
      name: input.targetChannelName?.trim() || mentionedChannel?.name
    };
  }

  const targetChannelName = input.targetChannelName?.trim().replace(/^#/, "").toLowerCase();
  if (targetChannelName) {
    const mentionedChannel = context.mentionedChannels.find(
      (channel) => channel.name?.toLowerCase() === targetChannelName
    );

    if (mentionedChannel) {
      return mentionedChannel;
    }
  }

  if (context.mentionedChannels.length === 1) {
    return context.mentionedChannels[0] ?? null;
  }

  return null;
}

function inferResponseMode(task: string): "reminder" | "prompt" {
  if (/[?]/.test(task) || /\b(what|who|when|where|why|how|search|find|trending|latest|current|summarize|report)\b/i.test(task)) {
    return "prompt";
  }

  return "reminder";
}

function scheduleToolInputToParsedSchedule(input: ScheduleToolInput): ParsedSchedule {
  const task = cleanTask(input.task);

  if (!task) {
    throw new Error("Schedule task cannot be empty.");
  }

  if (input.kind === "once" || input.kind === "interval") {
    const intervalMs = amountToMs(input.amount, input.unit);

    if (intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Schedule delay must be at least 1 minute.");
    }

    return {
      kind: input.kind,
      task,
      intervalMs,
      firstRunAt: new Date(Date.now() + intervalMs)
    };
  }

  if (input.kind === "daily") {
    const hour = parseInteger(input.hour, "hour");
    const minute = parseInteger(input.minute, "minute");
    validateTime(hour, minute);

    return {
      kind: "daily",
      task,
      hour,
      minute,
      firstRunAt: nextDailyRun(hour, minute)
    };
  }

  const hour = parseInteger(input.hour, "hour");
  const minute = parseInteger(input.minute, "minute");
  validateTime(hour, minute);

  return {
    kind: "weekly",
    task,
    weekday: WEEKDAYS.get(input.weekday) ?? 0,
    hour,
    minute,
    firstRunAt: nextWeeklyRun(WEEKDAYS.get(input.weekday) ?? 0, hour, minute)
  };
}

async function listUserSchedules(userId: string) {
  return getUserScheduleSummaries(userId);
}

async function getUserScheduleSummaries(userId: string) {
  const redis = await requireRedis();
  const ids = await redis.sMembers(getScheduleUserKey(userId));
  const schedules = (
    await Promise.all(ids.map((id) => loadSchedule(id)))
  ).filter((schedule): schedule is ScheduleRecord => schedule !== null);

  if (schedules.length === 0) {
    return "You don't have any active reminders or crons.";
  }

  const sorted = schedules.sort(
    (left, right) => new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime()
  );

  return `Your active reminders and crons:\n${sorted
    .map((schedule) => `- \`${schedule.id.slice(0, 8)}\` ${formatScheduleSummary(schedule)}`)
    .join("\n")}`;
}

async function cancelUserSchedule(userId: string, idPrefix: string) {
  const match = await findUserScheduleByPrefix(userId, idPrefix);

  if (!match.ok) {
    return match.message;
  }

  await deleteSchedule(match.schedule.id, userId);
  return `Canceled schedule \`${match.schedule.id.slice(0, 8)}\`.`;
}

async function runDueSchedules({
  postSlackMessage,
  runScheduledTask
}: {
  postSlackMessage: SlackPostMessage;
  runScheduledTask?: ScheduledTaskRunner;
}) {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      return;
    }

    const now = Date.now();
    const dueIds = await redis.zRangeByScore(SCHEDULE_DUE_KEY, 0, now, {
      LIMIT: {
        offset: 0,
        count: MAX_DUE_JOBS_PER_TICK
      }
    });

    for (const id of dueIds) {
      const claimed = await redis.zRem(SCHEDULE_DUE_KEY, id);
      if (!claimed) {
        continue;
      }

      const schedule = await loadSchedule(id);
      if (!schedule) {
        continue;
      }

      try {
        const dueText =
          schedule.responseMode === "prompt" && runScheduledTask
            ? await runScheduledTask({
                task: schedule.task,
                ownerUserId: schedule.ownerUserId
              })
            : schedule.task;

        await postSlackMessage({
          token: requireEnv("SLACK_BOT_TOKEN"),
          channel: schedule.channel,
          threadTs: schedule.threadTs,
          text: `<@${schedule.ownerUserId}> ${dueText}`
        });

        const nextRunAt = getNextRunAt(schedule);
        if (nextRunAt) {
          schedule.nextRunAt = nextRunAt.toISOString();
          await redis.set(getScheduleJobKey(schedule.id), JSON.stringify(schedule));
          await redis.zAdd(SCHEDULE_DUE_KEY, {
            score: nextRunAt.getTime(),
            value: schedule.id
          });
        } else {
          await deleteSchedule(schedule.id, schedule.ownerUserId);
        }
      } catch (error) {
        console.error(`Schedule ${schedule.id} failed: ${summarizeError(error)}`);
        const retryAt = new Date(Date.now() + 5 * 60 * 1000);
        await redis.zAdd(SCHEDULE_DUE_KEY, {
          score: retryAt.getTime(),
          value: schedule.id
        });
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

function amountToMs(amountInput: number | string, unit: "minutes" | "hours" | "days") {
  const amount = parseWholeNumber(amountInput, "amount");

  if (unit === "minutes") {
    return amount * 60 * 1000;
  }

  if (unit === "hours") {
    return amount * 60 * 60 * 1000;
  }

  return amount * DAY_MS;
}

function parseWholeNumber(input: number | string, label: string) {
  const value = parseInteger(input, label);

  if (value <= 0) {
    throw new Error(`Schedule ${label} must be a positive whole number.`);
  }

  return value;
}

function parseInteger(input: number | string, label: string) {
  const value = typeof input === "string" ? Number(input.trim()) : input;

  if (!Number.isInteger(value)) {
    throw new Error(`Schedule ${label} must be a whole number.`);
  }

  return value;
}

function validateTime(hour: number, minute: number) {
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Schedule time must use hour 0-23 and minute 0-59.");
  }
}

function nextDailyRun(hour: number, minute: number) {
  const now = new Date();
  const today = getChicagoDateParts(now);
  let next = chicagoDateToUtc(today.year, today.month, today.day, hour, minute);

  if (next.getTime() <= now.getTime()) {
    const tomorrow = addChicagoDays(today, 1);
    next = chicagoDateToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute);
  }

  return next;
}

function nextWeeklyRun(weekday: number, hour: number, minute: number) {
  const now = new Date();
  const today = getChicagoDateParts(now);
  const daysUntil = (weekday - today.weekday + 7) % 7;
  const targetDay = addChicagoDays(today, daysUntil);
  let next = chicagoDateToUtc(targetDay.year, targetDay.month, targetDay.day, hour, minute);

  if (next.getTime() <= now.getTime()) {
    const followingWeek = addChicagoDays(targetDay, 7);
    next = chicagoDateToUtc(followingWeek.year, followingWeek.month, followingWeek.day, hour, minute);
  }

  return next;
}

function getNextRunAt(schedule: ScheduleRecord) {
  if (schedule.kind === "once") {
    return null;
  }

  if (schedule.kind === "interval") {
    return new Date(Date.now() + (schedule.intervalMs ?? MIN_INTERVAL_MS));
  }

  if (schedule.kind === "daily") {
    const nextBase = new Date(new Date(schedule.nextRunAt).getTime() + 60_000);
    const nextDay = addChicagoDays(getChicagoDateParts(nextBase), 1);
    return chicagoDateToUtc(nextDay.year, nextDay.month, nextDay.day, schedule.hour ?? 0, schedule.minute ?? 0);
  }

  const nextBase = new Date(new Date(schedule.nextRunAt).getTime() + 60_000);
  const nextWeek = addChicagoDays(getChicagoDateParts(nextBase), 7);
  return chicagoDateToUtc(nextWeek.year, nextWeek.month, nextWeek.day, schedule.hour ?? 0, schedule.minute ?? 0);
}

function formatScheduleSummary(schedule: ScheduleRecord) {
  const next = formatDateTime(new Date(schedule.nextRunAt));
  const destination = formatScheduleDestination(schedule);

  if (schedule.kind === "once") {
    return `one-time reminder for ${next}${destination}: ${schedule.task}`;
  }

  if (schedule.kind === "interval") {
    return `every ${formatDuration(schedule.intervalMs ?? MIN_INTERVAL_MS)}, next ${next}${destination}: ${schedule.task}`;
  }

  if (schedule.kind === "daily") {
    return `daily at ${formatTime(schedule.hour ?? 0, schedule.minute ?? 0)} CT, next ${next}${destination}: ${schedule.task}`;
  }

  return `every ${formatWeekday(schedule.weekday ?? 0)} at ${formatTime(schedule.hour ?? 0, schedule.minute ?? 0)} CT, next ${next}${destination}: ${schedule.task}`;
}

function formatScheduleDestination(schedule: ScheduleRecord) {
  if (schedule.threadTs) {
    return "";
  }

  if (schedule.channelName) {
    return ` in #${schedule.channelName}`;
  }

  return ` in <#${schedule.channel}>`;
}

function formatDuration(intervalMs: number) {
  if (intervalMs % DAY_MS === 0) {
    return `${intervalMs / DAY_MS} day${intervalMs === DAY_MS ? "" : "s"}`;
  }

  const hourMs = 60 * 60 * 1000;
  if (intervalMs % hourMs === 0) {
    return `${intervalMs / hourMs} hour${intervalMs === hourMs ? "" : "s"}`;
  }

  const minuteMs = 60 * 1000;
  return `${intervalMs / minuteMs} minute${intervalMs === minuteMs ? "" : "s"}`;
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago"
  }).format(date);
}

function formatTime(hour: number, minute: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago"
  }).format(chicagoDateToUtc(2026, 1, 1, hour, minute));
}

function formatWeekday(weekday: number) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] ?? "Sunday";
}

function getChicagoDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: WEEKDAYS.get((values.weekday ?? "sun").toLowerCase()) ?? 0,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function chicagoDateToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  for (let index = 0; index < 2; index += 1) {
    const parts = getChicagoDateParts(utc);
    const renderedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0
    );
    const intendedAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    utc = new Date(utc.getTime() - (renderedAsUtc - intendedAsUtc));
  }

  return utc;
}

function addChicagoDays(
  date: Pick<ReturnType<typeof getChicagoDateParts>, "year" | "month" | "day">,
  days: number
) {
  const noon = chicagoDateToUtc(date.year, date.month, date.day + days, 12, 0);
  return getChicagoDateParts(noon);
}

async function loadSchedule(id: string) {
  const redis = await requireRedis();
  const payload = await redis.get(getScheduleJobKey(id));

  if (!payload) {
    return null;
  }

  return JSON.parse(payload) as ScheduleRecord;
}

async function findUserScheduleByPrefix(userId: string, idPrefix: string): Promise<
  | { ok: true; schedule: ScheduleRecord }
  | { ok: false; message: string }
> {
  const redis = await requireRedis();
  const normalizedPrefix = idPrefix.trim();

  if (!normalizedPrefix) {
    return { ok: false, message: "Tell me the schedule ID to use." };
  }

  const ids = await redis.sMembers(getScheduleUserKey(userId));
  const matches = ids.filter((id) => id.startsWith(normalizedPrefix));

  if (matches.length === 0) {
    return { ok: false, message: "I couldn't find one of your reminders or crons with that ID." };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      message: `That ID matches more than one schedule. Use a longer ID:\n${matches
        .map((id) => `- \`${id.slice(0, 12)}\``)
        .join("\n")}`
    };
  }

  const schedule = await loadSchedule(matches[0] ?? "");
  if (!schedule) {
    return { ok: false, message: "That schedule no longer exists." };
  }

  return { ok: true, schedule };
}

async function deleteSchedule(id: string, userId: string) {
  const redis = await requireRedis();
  await redis.del(getScheduleJobKey(id));
  await redis.zRem(SCHEDULE_DUE_KEY, id);
  await redis.sRem(getScheduleUserKey(userId), id);
}

async function requireRedis() {
  const redis = await getRedisClient();

  if (!redis) {
    throw new Error("Scheduling requires REDIS_URL.");
  }

  return redis;
}

function getScheduleJobKey(id: string) {
  return `${SCHEDULE_JOB_PREFIX}${id}`;
}

function getScheduleUserKey(userId: string) {
  return `${SCHEDULE_USER_PREFIX}${userId}`;
}

function getSchedulerIntervalMs() {
  const rawValue = process.env.SCHEDULER_INTERVAL_MS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 5_000) {
    return DEFAULT_SCHEDULER_INTERVAL_MS;
  }

  return parsedValue;
}

function normalizeSlackChannelId(input: string | undefined) {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  const channelIdMatch = trimmed.match(/#?(C[A-Z0-9]+|G[A-Z0-9]+|D[A-Z0-9]+)/i);

  if (!channelIdMatch) {
    return null;
  }

  return channelIdMatch[1]?.toUpperCase() ?? null;
}

function cleanTask(input: string) {
  return input
    .replace(/^(?:to|about)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
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

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
