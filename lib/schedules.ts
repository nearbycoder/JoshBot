import { randomUUID } from "node:crypto";
import { requireEnv } from "./env.js";
import { appendChannelMemory, type ChannelMemoryEntry } from "./memory.js";
import { recordOpsError } from "./ops-errors.js";
import {
  getUserPreferences,
  normalizeTimeZone,
  type ReminderStyle,
  type UserPreferences
} from "./preferences.js";
import { getRedisClient } from "./redis.js";
import {
  assertSlackTargetChannelAllowed,
  normalizeSlackChannelId,
  resolveSlackTargetChannel
} from "./slack-targets.js";

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
}) => Promise<{ ts?: string }>;

type ScheduledTaskRunner = (options: {
  task: string;
  ownerUserId: string;
}) => Promise<string>;

export type SlackScheduleContext = {
  ownerUserId: string;
  channel: string;
  threadTs: string;
  sourceTs: string;
  timeZone?: string;
  reminderStyle?: ReminderStyle;
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
      kind: "at";
      task: string;
      runAt: string;
    } & OptionalScheduleDestination
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
  timezone: string;
  reminderStyle?: ReminderStyle;
};

type ParsedSchedule =
  | {
      kind: "once";
      task: string;
      intervalMs: number;
      firstRunAt: Date;
    }
  | {
      kind: "interval";
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

type CreatedScheduleToolResult = {
  id: string;
  summary: string;
  nextRunAt: string | null;
};

export type ScheduleDashboardItem = {
  id: string;
  summary: string;
  nextRunAt: string;
};

const SCHEDULE_DUE_KEY = "schedules:due";
const SCHEDULE_JOB_PREFIX = "schedules:job:";
const SCHEDULE_USER_PREFIX = "schedules:user:";
const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;
const DEFAULT_SCHEDULE_CREATE_IDEMPOTENCY_TTL_SECONDS = 60 * 10;
const MAX_DUE_JOBS_PER_TICK = 10;
const MIN_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCHEDULE_TIME_ZONE = "America/Chicago";

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
    recordOpsError("schedule runner", error);
    console.error(`Schedule runner failed: ${summarizeError(error)}`);
  });

  setInterval(() => {
    void runDueSchedules({ postSlackMessage, runScheduledTask }).catch((error) => {
      recordOpsError("schedule runner", error);
      console.error(`Schedule runner failed: ${summarizeError(error)}`);
    });
  }, intervalMs).unref();
}

export function getScheduleRunnerStatus() {
  return {
    started: schedulerStarted,
    running: schedulerRunning,
    intervalMs: getSchedulerIntervalMs(),
    redisConfigured: Boolean(process.env.REDIS_URL?.trim())
  };
}

export async function createScheduleFromTool(
  context: SlackScheduleContext,
  input: ScheduleToolInput
) {
  const preferences = await getUserPreferences(context.ownerUserId);
  const parsed = scheduleToolInputToParsedSchedule(input, context.timeZone ?? preferences.timeZone);
  const destination = getScheduleDestination(context, input);
  await assertSlackTargetChannelAllowed({
    userId: context.ownerUserId,
    channelId: destination.channel,
    action: "create_schedule",
    surface: "slack-tool"
  });

  const idempotencyResult = await getIdempotentCreatedSchedule(context);

  if (idempotencyResult.status === "exists") {
    return idempotencyResult.schedule;
  }

  if (idempotencyResult.status === "locked") {
    return {
      id: idempotencyResult.lockedId,
      summary: "Schedule creation is already in progress for this Slack message.",
      nextRunAt: null
    };
  }

  const schedule = await createSchedule(context, parsed, destination, preferences);
  const result = {
    id: schedule.id,
    summary: formatScheduleSummary(schedule),
    nextRunAt: schedule.nextRunAt
  };

  await saveIdempotentCreatedSchedule(context, result);

  return result;
}

export async function listSchedulesFromTool(context: SlackScheduleContext) {
  return getUserScheduleSummaries(context.ownerUserId);
}

export async function getUserScheduleDashboardItems(
  userId: string,
  limit = 5
): Promise<ScheduleDashboardItem[]> {
  const redis = await getRedisClient();

  if (!redis) {
    return [];
  }

  const ids = await redis.sMembers(getScheduleUserKey(userId));
  const schedules = (
    await Promise.all(ids.map((id) => loadSchedule(id)))
  ).filter((schedule): schedule is ScheduleRecord => schedule !== null);

  return schedules
    .sort(
      (left, right) =>
        new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime()
    )
    .slice(0, normalizeDashboardLimit(limit, 5, 20))
    .map((schedule) => ({
      id: schedule.id,
      summary: formatScheduleSummary(schedule),
      nextRunAt: schedule.nextRunAt
    }));
}

export async function cancelScheduleFromTool(context: SlackScheduleContext, idPrefix: string) {
  return cancelUserSchedule(context.ownerUserId, idPrefix);
}

export async function cancelScheduleById(scheduleId: string, ownerUserId: string) {
  await deleteSchedule(scheduleId, ownerUserId);
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

  const preferences = await getUserPreferences(context.ownerUserId);
  const parsed = scheduleToolInputToParsedSchedule(input, context.timeZone ?? preferences.timeZone);
  const destination = getScheduleDestinationForUpdate(context, input, existingSchedule.schedule);
  const schedule = await createSchedule(context, parsed, destination, preferences);

  return `Updated schedule \`${existingSchedule.schedule.id.slice(0, 8)}\` -> \`${schedule.id.slice(0, 8)}\`: ${formatScheduleSummary(schedule)}`;
}

async function createSchedule(
  context: SlackScheduleContext,
  parsed: ParsedSchedule,
  destination: ScheduleDestination,
  preferences: UserPreferences
) {
  const redis = await requireRedis();
  const now = new Date();
  const id = randomUUID();
  const timeZone = normalizeTimeZone(context.timeZone ?? preferences.timeZone);
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
    timezone: timeZone,
    reminderStyle: context.reminderStyle ?? preferences.reminderStyle
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

async function getIdempotentCreatedSchedule(context: SlackScheduleContext): Promise<
  | { status: "ready" }
  | { status: "exists"; schedule: CreatedScheduleToolResult }
  | { status: "locked"; lockedId: string }
> {
  const redis = await requireRedis();
  const resultKey = getScheduleCreateResultKey(context);
  const existingResult = await redis.get(resultKey);

  if (existingResult) {
    return {
      status: "exists",
      schedule: JSON.parse(existingResult) as CreatedScheduleToolResult
    };
  }

  const lockedId = randomUUID();
  const lockResult = await redis.set(getScheduleCreateLockKey(context), lockedId, {
    condition: "NX",
    expiration: {
      type: "EX",
      value: getScheduleCreateIdempotencyTtlSeconds()
    }
  });

  if (lockResult === "OK") {
    return { status: "ready" };
  }

  return {
    status: "locked",
    lockedId
  };
}

async function saveIdempotentCreatedSchedule(
  context: SlackScheduleContext,
  result: CreatedScheduleToolResult
) {
  const redis = await requireRedis();

  await redis.set(getScheduleCreateResultKey(context), JSON.stringify(result), {
    expiration: {
      type: "EX",
      value: getScheduleCreateIdempotencyTtlSeconds()
    }
  });
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
  const resolution = resolveSlackTargetChannel(context, input);

  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }

  return resolution.channel;
}

function inferResponseMode(task: string): "reminder" | "prompt" {
  if (/[?]/.test(task) || /\b(what|who|when|where|why|how|search|find|trending|latest|current|summarize|report)\b/i.test(task)) {
    return "prompt";
  }

  return "reminder";
}

function scheduleToolInputToParsedSchedule(
  input: ScheduleToolInput,
  timeZone = DEFAULT_SCHEDULE_TIME_ZONE
): ParsedSchedule {
  const task = cleanTask(input.task);
  const normalizedTimeZone = normalizeTimeZone(timeZone);

  if (!task) {
    throw new Error("Schedule task cannot be empty.");
  }

  if (input.kind === "at") {
    const firstRunAt = parseFutureRunAt(input.runAt);

    return {
      kind: "once",
      task,
      intervalMs: Math.max(firstRunAt.getTime() - Date.now(), MIN_INTERVAL_MS),
      firstRunAt
    };
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
      firstRunAt: nextDailyRun(hour, minute, normalizedTimeZone)
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
    firstRunAt: nextWeeklyRun(WEEKDAYS.get(input.weekday) ?? 0, hour, minute, normalizedTimeZone)
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
            : formatReminderText(schedule.task, schedule.reminderStyle);

        const messageText = `<@${schedule.ownerUserId}> ${dueText}`;
        const postedMessage = await postSlackMessage({
          token: requireEnv("SLACK_BOT_TOKEN"),
          channel: schedule.channel,
          threadTs: schedule.threadTs,
          text: messageText
        });
        await recordScheduleChannelMemory(schedule.channel, {
          role: "assistant",
          content: messageText,
          ts: postedMessage.ts,
          threadTs: schedule.threadTs ?? postedMessage.ts
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
        recordOpsError("schedule job", error);
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

function parseFutureRunAt(input: string) {
  const runAt = new Date(input);

  if (!input.trim() || Number.isNaN(runAt.getTime())) {
    throw new Error("Schedule runAt must be an ISO date/time.");
  }

  if (runAt.getTime() <= Date.now()) {
    throw new Error("Schedule runAt must be in the future.");
  }

  return runAt;
}

function nextDailyRun(hour: number, minute: number, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  const now = new Date();
  const today = getZonedDateParts(now, timeZone);
  let next = zonedDateToUtc(timeZone, today.year, today.month, today.day, hour, minute);

  if (next.getTime() <= now.getTime()) {
    const tomorrow = addZonedDays(today, 1, timeZone);
    next = zonedDateToUtc(timeZone, tomorrow.year, tomorrow.month, tomorrow.day, hour, minute);
  }

  return next;
}

function nextWeeklyRun(
  weekday: number,
  hour: number,
  minute: number,
  timeZone = DEFAULT_SCHEDULE_TIME_ZONE
) {
  const now = new Date();
  const today = getZonedDateParts(now, timeZone);
  const daysUntil = (weekday - today.weekday + 7) % 7;
  const targetDay = addZonedDays(today, daysUntil, timeZone);
  let next = zonedDateToUtc(timeZone, targetDay.year, targetDay.month, targetDay.day, hour, minute);

  if (next.getTime() <= now.getTime()) {
    const followingWeek = addZonedDays(targetDay, 7, timeZone);
    next = zonedDateToUtc(timeZone, followingWeek.year, followingWeek.month, followingWeek.day, hour, minute);
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
    const timeZone = normalizeTimeZone(schedule.timezone);
    const nextBase = new Date(new Date(schedule.nextRunAt).getTime() + 60_000);
    const nextDay = addZonedDays(getZonedDateParts(nextBase, timeZone), 1, timeZone);
    return zonedDateToUtc(timeZone, nextDay.year, nextDay.month, nextDay.day, schedule.hour ?? 0, schedule.minute ?? 0);
  }

  const timeZone = normalizeTimeZone(schedule.timezone);
  const nextBase = new Date(new Date(schedule.nextRunAt).getTime() + 60_000);
  const nextWeek = addZonedDays(getZonedDateParts(nextBase, timeZone), 7, timeZone);
  return zonedDateToUtc(timeZone, nextWeek.year, nextWeek.month, nextWeek.day, schedule.hour ?? 0, schedule.minute ?? 0);
}

function formatScheduleSummary(schedule: ScheduleRecord) {
  const timeZone = normalizeTimeZone(schedule.timezone);
  const next = formatDateTime(new Date(schedule.nextRunAt), timeZone);
  const destination = formatScheduleDestination(schedule);

  if (schedule.kind === "once") {
    return `one-time reminder for ${next}${destination}: ${schedule.task}`;
  }

  if (schedule.kind === "interval") {
    return `every ${formatDuration(schedule.intervalMs ?? MIN_INTERVAL_MS)}, next ${next}${destination}: ${schedule.task}`;
  }

  if (schedule.kind === "daily") {
    return `daily at ${formatTime(schedule.hour ?? 0, schedule.minute ?? 0, timeZone)} ${formatTimeZoneLabel(timeZone)}, next ${next}${destination}: ${schedule.task}`;
  }

  return `every ${formatWeekday(schedule.weekday ?? 0)} at ${formatTime(schedule.hour ?? 0, schedule.minute ?? 0, timeZone)} ${formatTimeZoneLabel(timeZone)}, next ${next}${destination}: ${schedule.task}`;
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

async function recordScheduleChannelMemory(channel: string, entry: ChannelMemoryEntry) {
  try {
    await appendChannelMemory(channel, entry);
  } catch (error) {
    console.warn(`Unable to append scheduled Slack channel memory: ${summarizeError(error)}`);
  }
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

function formatReminderText(task: string, reminderStyle: ReminderStyle = "direct") {
  if (reminderStyle === "gentle") {
    return `Gentle reminder: ${task}`;
  }

  if (reminderStyle === "detailed") {
    return `Reminder: ${task}\nScheduled by NoBo.`;
  }

  return task;
}

function formatDateTime(date: Date, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone
  }).format(date);
}

function formatTime(hour: number, minute: number, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(zonedDateToUtc(timeZone, 2026, 1, 1, hour, minute));
}

function formatTimeZoneLabel(timeZone: string) {
  return timeZone === DEFAULT_SCHEDULE_TIME_ZONE ? "CT" : timeZone;
}

function formatWeekday(weekday: number) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] ?? "Sunday";
}

function getZonedDateParts(date: Date, timeZone = DEFAULT_SCHEDULE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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

function zonedDateToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
) {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  for (let index = 0; index < 2; index += 1) {
    const parts = getZonedDateParts(utc, timeZone);
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

function addZonedDays(
  date: Pick<ReturnType<typeof getZonedDateParts>, "year" | "month" | "day">,
  days: number,
  timeZone = DEFAULT_SCHEDULE_TIME_ZONE
) {
  const noon = zonedDateToUtc(timeZone, date.year, date.month, date.day + days, 12, 0);
  return getZonedDateParts(noon, timeZone);
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

function getScheduleCreateLockKey(context: SlackScheduleContext) {
  return `schedules:create-lock:${context.ownerUserId}:${context.channel}:${context.threadTs}:${context.sourceTs}`;
}

function getScheduleCreateResultKey(context: SlackScheduleContext) {
  return `schedules:create-result:${context.ownerUserId}:${context.channel}:${context.threadTs}:${context.sourceTs}`;
}

function getSchedulerIntervalMs() {
  const rawValue = process.env.SCHEDULER_INTERVAL_MS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 5_000) {
    return DEFAULT_SCHEDULER_INTERVAL_MS;
  }

  return parsedValue;
}

function getScheduleCreateIdempotencyTtlSeconds() {
  const rawValue = process.env.SCHEDULE_CREATE_IDEMPOTENCY_TTL_SECONDS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 60) {
    return DEFAULT_SCHEDULE_CREATE_IDEMPOTENCY_TTL_SECONDS;
  }

  return parsedValue;
}

function normalizeDashboardLimit(input: number, fallback: number, max: number) {
  if (!Number.isInteger(input) || input < 1) {
    return fallback;
  }

  return Math.min(input, max);
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

export const __testing = {
  formatReminderText,
  formatScheduleSummary,
  getScheduleDestination,
  getScheduleDestinationForUpdate,
  inferResponseMode,
  nextDailyRun,
  scheduleToolInputToParsedSchedule
};
