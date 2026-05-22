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
  threadTs: string;
  text: string;
}) => Promise<unknown>;

type ScheduleKind = "once" | "interval" | "daily" | "weekly";

type ScheduleRecord = {
  id: string;
  ownerUserId: string;
  channel: string;
  threadTs: string;
  task: string;
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

  const parsed = parseScheduleRequest(trimmed);
  if (!parsed) {
    return null;
  }

  const schedule = await createSchedule(event, parsed);
  return `Scheduled ${formatScheduleSummary(schedule)}.\nID: \`${schedule.id.slice(0, 8)}\``;
}

export function startScheduleRunner({
  postSlackMessage
}: {
  postSlackMessage: SlackPostMessage;
}) {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  const intervalMs = getSchedulerIntervalMs();

  void runDueSchedules(postSlackMessage).catch((error) => {
    console.error(`Schedule runner failed: ${summarizeError(error)}`);
  });

  setInterval(() => {
    void runDueSchedules(postSlackMessage).catch((error) => {
      console.error(`Schedule runner failed: ${summarizeError(error)}`);
    });
  }, intervalMs).unref();
}

async function createSchedule(event: SlackMessageEvent, parsed: ParsedSchedule) {
  const redis = await requireRedis();
  const now = new Date();
  const id = randomUUID();
  const base = {
    id,
    ownerUserId: event.user ?? "",
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    task: parsed.task,
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

async function listUserSchedules(userId: string) {
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
  const redis = await requireRedis();
  const ids = await redis.sMembers(getScheduleUserKey(userId));
  const matches = ids.filter((id) => id.startsWith(idPrefix));

  if (matches.length === 0) {
    return "I couldn't find one of your reminders or crons with that ID.";
  }

  if (matches.length > 1) {
    return `That ID matches more than one schedule. Use a longer ID:\n${matches
      .map((id) => `- \`${id.slice(0, 12)}\``)
      .join("\n")}`;
  }

  const id = matches[0] ?? "";
  await deleteSchedule(id, userId);
  return `Canceled schedule \`${id.slice(0, 8)}\`.`;
}

async function runDueSchedules(postSlackMessage: SlackPostMessage) {
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
        await postSlackMessage({
          token: requireEnv("SLACK_BOT_TOKEN"),
          channel: schedule.channel,
          threadTs: schedule.threadTs,
          text: `<@${schedule.ownerUserId}> ${schedule.task}`
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

function parseScheduleRequest(input: string): ParsedSchedule | null {
  const text = input.replace(/^schedule\s+/i, "").trim();

  const listLike = /^(list|show|cancel|delete|remove)\b/i.test(text);
  if (!text || listLike) {
    return null;
  }

  const weeklyLeading = text.match(
    /^every\s+(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+at\s+([0-9]{1,2}(?::[0-9]{2})?)\s*(am|pm)?\s*(?:cst|cdt|ct)?\s+(?:do|remind\s+me\s+(?:to|about))\s+(.+)$/i
  );
  if (weeklyLeading) {
    return parseWeekly(weeklyLeading[1] ?? "", weeklyLeading[2] ?? "", weeklyLeading[3], weeklyLeading[4] ?? "");
  }

  const dailyLeading = text.match(
    /^every\s+day\s+at\s+([0-9]{1,2}(?::[0-9]{2})?)\s*(am|pm)?\s*(?:cst|cdt|ct)?\s+(?:do|remind\s+me\s+(?:to|about))\s+(.+)$/i
  );
  if (dailyLeading) {
    return parseDaily(dailyLeading[1] ?? "", dailyLeading[2], dailyLeading[3] ?? "");
  }

  const intervalLeading = text.match(
    /^every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s+(?:do|remind\s+me\s+(?:to|about))\s+(.+)$/i
  );
  if (intervalLeading) {
    return parseInterval(intervalLeading[1] ?? "", intervalLeading[2] ?? "", intervalLeading[3] ?? "", true);
  }

  const inTrailing = text.match(
    /^(?:remind\s+me\s+(?:to|about)?\s*)?(.+?)\s+in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i
  );
  if (inTrailing) {
    return parseInterval(inTrailing[2] ?? "", inTrailing[3] ?? "", inTrailing[1] ?? "", false);
  }

  const inLeading = text.match(
    /^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s+(?:remind\s+me\s+(?:to|about)?\s*)?(.+)$/i
  );
  if (inLeading) {
    return parseInterval(inLeading[1] ?? "", inLeading[2] ?? "", inLeading[3] ?? "", false);
  }

  const weeklyTrailing = text.match(
    /^(?:remind\s+me\s+(?:to|about)?\s*)?(.+?)\s+every\s+(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+at\s+([0-9]{1,2}(?::[0-9]{2})?)\s*(am|pm)?\s*(?:cst|cdt|ct)?$/i
  );
  if (weeklyTrailing) {
    return parseWeekly(weeklyTrailing[2] ?? "", weeklyTrailing[3] ?? "", weeklyTrailing[4], weeklyTrailing[1] ?? "");
  }

  const dailyTrailing = text.match(
    /^(?:remind\s+me\s+(?:to|about)?\s*)?(.+?)\s+every\s+day\s+at\s+([0-9]{1,2}(?::[0-9]{2})?)\s*(am|pm)?\s*(?:cst|cdt|ct)?$/i
  );
  if (dailyTrailing) {
    return parseDaily(dailyTrailing[2] ?? "", dailyTrailing[3], dailyTrailing[1] ?? "");
  }

  return null;
}

function parseInterval(amountText: string, unit: string, taskText: string, repeats: boolean): ParsedSchedule | null {
  const amount = Number(amountText);
  const multiplier = unit.toLowerCase().startsWith("minute")
    ? 60 * 1000
    : unit.toLowerCase().startsWith("hour")
      ? 60 * 60 * 1000
      : DAY_MS;
  const intervalMs = amount * multiplier;
  const task = cleanTask(taskText);

  if (!Number.isInteger(amount) || amount <= 0 || intervalMs < MIN_INTERVAL_MS || !task) {
    return null;
  }

  return {
    kind: repeats ? "interval" : "once",
    task,
    intervalMs,
    firstRunAt: new Date(Date.now() + intervalMs)
  };
}

function parseDaily(timeText: string, meridiem: string | undefined, taskText: string): ParsedSchedule | null {
  const time = parseTime(timeText, meridiem);
  const task = cleanTask(taskText);

  if (!time || !task) {
    return null;
  }

  return {
    kind: "daily",
    task,
    hour: time.hour,
    minute: time.minute,
    firstRunAt: nextDailyRun(time.hour, time.minute)
  };
}

function parseWeekly(
  weekdayText: string,
  timeText: string,
  meridiem: string | undefined,
  taskText: string
): ParsedSchedule | null {
  const weekday = WEEKDAYS.get(weekdayText.toLowerCase());
  const time = parseTime(timeText, meridiem);
  const task = cleanTask(taskText);

  if (weekday === undefined || !time || !task) {
    return null;
  }

  return {
    kind: "weekly",
    task,
    weekday,
    hour: time.hour,
    minute: time.minute,
    firstRunAt: nextWeeklyRun(weekday, time.hour, time.minute)
  };
}

function parseTime(timeText: string, meridiem: string | undefined) {
  const [hourText, minuteText = "0"] = timeText.split(":");
  let hour = Number(hourText);
  const minute = Number(minuteText);

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem) {
    const normalized = meridiem.toLowerCase();
    if (hour < 1 || hour > 12) {
      return null;
    }

    if (normalized === "pm" && hour !== 12) {
      hour += 12;
    }

    if (normalized === "am" && hour === 12) {
      hour = 0;
    }
  }

  if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
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

  if (schedule.kind === "once") {
    return `one-time reminder for ${next}: ${schedule.task}`;
  }

  if (schedule.kind === "interval") {
    return `every ${formatDuration(schedule.intervalMs ?? MIN_INTERVAL_MS)}, next ${next}: ${schedule.task}`;
  }

  if (schedule.kind === "daily") {
    return `daily at ${formatTime(schedule.hour ?? 0, schedule.minute ?? 0)} CT, next ${next}: ${schedule.task}`;
  }

  return `every ${formatWeekday(schedule.weekday ?? 0)} at ${formatTime(schedule.hour ?? 0, schedule.minute ?? 0)} CT, next ${next}: ${schedule.task}`;
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
