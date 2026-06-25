import { randomUUID } from "node:crypto";
import { requireEnv } from "./env.js";
import { fetchSlackChannelHistory } from "./channel-history.js";
import { recordOpsError } from "./ops-errors.js";
import {
  getUserPreferences,
  normalizeTimeZone,
  type UserPreferences
} from "./preferences.js";
import { getRedisClient } from "./redis.js";
import type { SlackScheduleContext } from "./schedules.js";

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

export type MonitorSource = "channel_history" | "web_search" | "prompt";
export type MonitorConditionType = "appears" | "changes" | "fails";

export type ConditionalMonitorCheckRequest = {
  source: MonitorSource;
  conditionType: MonitorConditionType;
  query: string;
  ownerUserId: string;
  channel: string;
  lastObservation?: string;
};

export type ConditionalMonitorCheckResult = {
  matched: boolean;
  summary: string;
  fingerprint: string;
  observation?: string;
};

type MonitorCheckRunner = (
  request: ConditionalMonitorCheckRequest
) => Promise<ConditionalMonitorCheckResult>;

type MonitorCadenceInput =
  | {
      kind: "interval";
      amount: number | string;
      unit: "minutes" | "hours" | "days";
    }
  | {
      kind: "daily";
      hour: number | string;
      minute: number | string;
    }
  | {
      kind: "weekly";
      weekday: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
      hour: number | string;
      minute: number | string;
    };

export type MonitorToolInput = MonitorCadenceInput & {
  query: string;
  conditionType: MonitorConditionType;
  source?: MonitorSource;
  targetChannelId?: string;
  targetChannelName?: string;
};

type MonitorRecord = {
  id: string;
  ownerUserId: string;
  channel: string;
  threadTs?: string;
  channelName?: string;
  source: MonitorSource;
  conditionType: MonitorConditionType;
  query: string;
  kind: MonitorCadenceInput["kind"];
  createdAt: string;
  nextRunAt: string;
  intervalMs?: number;
  weekday?: number;
  hour?: number;
  minute?: number;
  timezone: string;
  lastCheckedAt?: string;
  lastObservation?: string;
  lastAlertFingerprint?: string;
};

type ParsedMonitor =
  | {
      kind: "interval";
      query: string;
      source: MonitorSource;
      conditionType: MonitorConditionType;
      intervalMs: number;
      firstRunAt: Date;
    }
  | {
      kind: "daily";
      query: string;
      source: MonitorSource;
      conditionType: MonitorConditionType;
      hour: number;
      minute: number;
      firstRunAt: Date;
    }
  | {
      kind: "weekly";
      query: string;
      source: MonitorSource;
      conditionType: MonitorConditionType;
      weekday: number;
      hour: number;
      minute: number;
      firstRunAt: Date;
    };

type MonitorDestination = {
  channel: string;
  threadTs?: string;
  channelName?: string;
};

type CreatedMonitorResult = {
  id: string;
  summary: string;
  nextRunAt: string | null;
};

export type MonitorDashboardItem = {
  id: string;
  summary: string;
  nextRunAt: string;
};

const MONITOR_DUE_KEY = "monitors:due";
const MONITOR_JOB_PREFIX = "monitors:job:";
const MONITOR_USER_PREFIX = "monitors:user:";
const MONITOR_CREATE_RESULT_PREFIX = "monitors:create:result:";
const MONITOR_CREATE_LOCK_PREFIX = "monitors:create:lock:";
const DEFAULT_MONITOR_INTERVAL_MS = 60_000;
const DEFAULT_MONITOR_TIME_ZONE = "America/Chicago";
const DEFAULT_MONITOR_CREATE_IDEMPOTENCY_TTL_SECONDS = 60 * 10;
const MAX_DUE_MONITORS_PER_TICK = 10;
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

let monitorRunnerStarted = false;
let monitorRunnerRunning = false;

export async function maybeHandleMonitorCommand(event: SlackMessageEvent) {
  if (!event.user) {
    return null;
  }

  const redis = await getRedisClient();
  if (!redis) {
    return null;
  }

  return handleMonitorCommandText({
    text: stripSlackFormatting(event.text),
    context: {
      ownerUserId: event.user,
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      sourceTs: event.ts,
      mentionedChannels: []
    }
  });
}

export async function handleMonitorCommandText({
  text,
  context
}: {
  text: string;
  context?: SlackScheduleContext;
}) {
  const parsed = parseMonitorCommandText(text);

  if (!parsed) {
    return null;
  }

  if (!context) {
    return "Monitor commands need a Slack context.";
  }

  if (parsed.action === "list") {
    return listUserMonitors(context.ownerUserId);
  }

  if (parsed.action === "cancel") {
    return cancelUserMonitor(context.ownerUserId, parsed.idPrefix);
  }

  return formatCreatedMonitorResult(await createMonitorFromTool(context, parsed.monitor));
}

export function startMonitorRunner({
  postSlackMessage,
  runMonitorCheck
}: {
  postSlackMessage: SlackPostMessage;
  runMonitorCheck?: MonitorCheckRunner;
}) {
  if (monitorRunnerStarted) {
    return;
  }

  monitorRunnerStarted = true;
  const intervalMs = getMonitorRunnerIntervalMs();

  void runDueMonitors({ postSlackMessage, runMonitorCheck }).catch((error) => {
    recordOpsError("monitor runner", error);
    console.error(`Monitor runner failed: ${summarizeError(error)}`);
  });

  setInterval(() => {
    void runDueMonitors({ postSlackMessage, runMonitorCheck }).catch((error) => {
      recordOpsError("monitor runner", error);
      console.error(`Monitor runner failed: ${summarizeError(error)}`);
    });
  }, intervalMs).unref();
}

export function getMonitorRunnerStatus() {
  return {
    started: monitorRunnerStarted,
    running: monitorRunnerRunning,
    intervalMs: getMonitorRunnerIntervalMs(),
    redisConfigured: Boolean(process.env.REDIS_URL?.trim())
  };
}

export async function createMonitorFromTool(
  context: SlackScheduleContext,
  input: MonitorToolInput
) {
  const preferences = await getUserPreferences(context.ownerUserId);
  const parsed = monitorToolInputToParsedMonitor(input, context.timeZone ?? preferences.timeZone);
  const destination = getMonitorDestination(context, input);
  const idempotencyResult = await getIdempotentCreatedMonitor(context);

  if (idempotencyResult.status === "exists") {
    return idempotencyResult.monitor;
  }

  if (idempotencyResult.status === "locked") {
    return {
      id: idempotencyResult.lockedId,
      summary: "Monitor creation is already in progress for this Slack message.",
      nextRunAt: null
    };
  }

  const monitor = await createMonitor(context, parsed, destination, preferences);
  const result = {
    id: monitor.id,
    summary: formatMonitorSummary(monitor),
    nextRunAt: monitor.nextRunAt
  };

  await saveIdempotentCreatedMonitor(context, result);

  return result;
}

export async function listMonitorsFromTool(context: SlackScheduleContext) {
  return listUserMonitors(context.ownerUserId);
}

export async function getUserMonitorDashboardItems(
  userId: string,
  limit = 5
): Promise<MonitorDashboardItem[]> {
  const redis = await getRedisClient();

  if (!redis) {
    return [];
  }

  const ids = await redis.sMembers(getMonitorUserKey(userId));
  const monitors = (
    await Promise.all(ids.map((id) => loadMonitor(id)))
  ).filter((monitor): monitor is MonitorRecord => monitor !== null);

  return monitors
    .sort(
      (left, right) =>
        new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime()
    )
    .slice(0, normalizeDashboardLimit(limit, 5, 20))
    .map((monitor) => ({
      id: monitor.id,
      summary: formatMonitorSummary(monitor),
      nextRunAt: monitor.nextRunAt
    }));
}

export async function cancelMonitorFromTool(context: SlackScheduleContext, idPrefix: string) {
  return cancelUserMonitor(context.ownerUserId, idPrefix);
}

async function createMonitor(
  context: SlackScheduleContext,
  parsed: ParsedMonitor,
  destination: MonitorDestination,
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
    source: parsed.source,
    conditionType: parsed.conditionType,
    query: parsed.query,
    kind: parsed.kind,
    createdAt: now.toISOString(),
    nextRunAt: parsed.firstRunAt.toISOString(),
    timezone: timeZone
  };

  const monitor: MonitorRecord =
    parsed.kind === "weekly"
      ? { ...base, weekday: parsed.weekday, hour: parsed.hour, minute: parsed.minute }
      : parsed.kind === "daily"
        ? { ...base, hour: parsed.hour, minute: parsed.minute }
        : { ...base, intervalMs: parsed.intervalMs };

  await redis.set(getMonitorJobKey(id), JSON.stringify(monitor));
  await redis.zAdd(MONITOR_DUE_KEY, {
    score: parsed.firstRunAt.getTime(),
    value: id
  });
  await redis.sAdd(getMonitorUserKey(monitor.ownerUserId), id);

  return monitor;
}

async function runDueMonitors({
  postSlackMessage,
  runMonitorCheck
}: {
  postSlackMessage: SlackPostMessage;
  runMonitorCheck?: MonitorCheckRunner;
}) {
  if (monitorRunnerRunning) {
    return;
  }

  monitorRunnerRunning = true;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      return;
    }

    const dueIds = await redis.zRangeByScore(MONITOR_DUE_KEY, 0, Date.now(), {
      LIMIT: {
        offset: 0,
        count: MAX_DUE_MONITORS_PER_TICK
      }
    });

    for (const id of dueIds) {
      const claimed = await redis.zRem(MONITOR_DUE_KEY, id);
      if (!claimed) {
        continue;
      }

      const monitor = await loadMonitor(id);
      if (!monitor) {
        continue;
      }

      try {
        const result = await evaluateMonitor(monitor, runMonitorCheck);

        monitor.lastCheckedAt = new Date().toISOString();
        monitor.lastObservation = result.observation ?? monitor.lastObservation;

        if (shouldPostMonitorAlert(monitor, result)) {
          const messageText = `<@${monitor.ownerUserId}> ${formatMonitorAlert(monitor, result)}`;
          await postSlackMessage({
            token: requireEnv("SLACK_BOT_TOKEN"),
            channel: monitor.channel,
            threadTs: monitor.threadTs,
            text: messageText
          });
          monitor.lastAlertFingerprint = result.fingerprint;
        }

        const nextRunAt = getNextRunAt(monitor);
        monitor.nextRunAt = nextRunAt.toISOString();
        await redis.set(getMonitorJobKey(monitor.id), JSON.stringify(monitor));
        await redis.zAdd(MONITOR_DUE_KEY, {
          score: nextRunAt.getTime(),
          value: monitor.id
        });
      } catch (error) {
        recordOpsError("monitor job", error);
        console.error(`Monitor ${monitor.id} failed: ${summarizeError(error)}`);
        await redis.zAdd(MONITOR_DUE_KEY, {
          score: Date.now() + 5 * 60 * 1000,
          value: monitor.id
        });
      }
    }
  } finally {
    monitorRunnerRunning = false;
  }
}

async function evaluateMonitor(
  monitor: MonitorRecord,
  runMonitorCheck?: MonitorCheckRunner
): Promise<ConditionalMonitorCheckResult> {
  if (monitor.source === "channel_history") {
    const messages = await fetchSlackChannelHistory({
      channel: monitor.channel,
      days: 7,
      limit: 200
    });
    return evaluateChannelHistoryMonitor(monitor, messages);
  }

  if (!runMonitorCheck) {
    return {
      matched: false,
      summary: "Monitor check runner is not configured.",
      fingerprint: monitor.lastAlertFingerprint ?? "not-configured"
    };
  }

  return runMonitorCheck({
    source: monitor.source,
    conditionType: monitor.conditionType,
    query: monitor.query,
    ownerUserId: monitor.ownerUserId,
    channel: monitor.channel,
    lastObservation: monitor.lastObservation
  });
}

function evaluateChannelHistoryMonitor(
  monitor: Pick<MonitorRecord, "query" | "conditionType" | "lastCheckedAt" | "lastObservation">,
  messages: Array<{ ts: string; datetime: string; speaker: string; text: string }>
): ConditionalMonitorCheckResult {
  const query = monitor.query.toLowerCase();
  const since = monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).getTime() : 0;
  const candidates = messages
    .filter((message) => new Date(message.datetime).getTime() > since)
    .sort((left, right) => new Date(left.datetime).getTime() - new Date(right.datetime).getTime());

  if (monitor.conditionType === "appears") {
    const match = candidates.find((message) => message.text.toLowerCase().includes(query));
    if (!match) {
      return {
        matched: false,
        summary: `No new mention of "${monitor.query}".`,
        fingerprint: monitor.lastObservation ?? "no-match",
        observation: monitor.lastObservation
      };
    }

    return {
      matched: true,
      summary: `${match.speaker}: ${match.text}`,
      fingerprint: `${match.ts}:${stableHash(match.text)}`,
      observation: match.text
    };
  }

  const observation = candidates.map((message) => message.text).join("\n").trim();
  if (!observation) {
    return {
      matched: false,
      summary: "No new channel messages.",
      fingerprint: monitor.lastObservation ?? "no-new-messages",
      observation: monitor.lastObservation
    };
  }

  const fingerprint = stableHash(observation);
  if (monitor.conditionType === "changes") {
    return {
      matched: Boolean(monitor.lastObservation && monitor.lastObservation !== fingerprint),
      summary: "Channel history changed.",
      fingerprint,
      observation: fingerprint
    };
  }

  const failed = /\b(fail(?:ed|ing|s)?|error|broken|down|incident|outage|regression)\b/i.test(observation);
  return {
    matched: failed,
    summary: failed ? "Recent channel history mentions a failure." : "No failure language found.",
    fingerprint,
    observation: fingerprint
  };
}

function shouldPostMonitorAlert(
  monitor: Pick<MonitorRecord, "lastAlertFingerprint">,
  result: ConditionalMonitorCheckResult
) {
  return result.matched && result.fingerprint !== monitor.lastAlertFingerprint;
}

function parseMonitorCommandText(text: string):
  | { action: "list" }
  | { action: "cancel"; idPrefix: string }
  | { action: "create"; monitor: MonitorToolInput }
  | null {
  const trimmed = text.trim();
  const withoutPrefix = trimmed.replace(/^monitor(?:s)?\s*/i, "").trim();

  if (/^(list|show)(\s+(my\s+)?monitors)?$/i.test(trimmed) || /^(list|show)$/i.test(withoutPrefix)) {
    return { action: "list" };
  }

  const cancelMatch =
    trimmed.match(/^(?:cancel|delete|remove)\s+monitor\s+([a-z0-9-]+)$/i) ??
    withoutPrefix.match(/^(?:cancel|delete|remove)\s+([a-z0-9-]+)$/i);

  if (cancelMatch) {
    return { action: "cancel", idPrefix: cancelMatch[1] ?? "" };
  }

  const createText = withoutPrefix || trimmed;
  const sourceMatch = createText.match(/^(channel|web|search|prompt)\s+(.+)$/i);
  const source = sourceMatch ? sourceNameToMonitorSource(sourceMatch[1] ?? "") : undefined;
  const cadenceText = sourceMatch ? sourceMatch[2] ?? "" : createText;
  const intervalMatch = cadenceText.match(
    /^every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\s+alert\s+if\s+(.+)$/i
  );

  if (!intervalMatch) {
    return null;
  }

  const condition = parseMonitorCondition(intervalMatch[3] ?? "");
  if (!condition) {
    return null;
  }

  return {
    action: "create",
    monitor: {
      kind: "interval",
      amount: intervalMatch[1] ?? "1",
      unit: normalizeUnit(intervalMatch[2] ?? "minutes"),
      query: condition.query,
      conditionType: condition.conditionType,
      source: source ?? inferMonitorSource(condition.conditionType)
    }
  };
}

function parseMonitorCondition(input: string) {
  const match = input.trim().match(/^(.+?)\s+(appears?|changes?|fails?)$/i);

  if (!match) {
    return null;
  }

  const query = cleanQuery(match[1] ?? "");
  const rawCondition = (match[2] ?? "").toLowerCase();
  const conditionType: MonitorConditionType = rawCondition.startsWith("appear")
    ? "appears"
    : rawCondition.startsWith("change")
      ? "changes"
      : "fails";

  if (!query) {
    return null;
  }

  return { query, conditionType };
}

function monitorToolInputToParsedMonitor(
  input: MonitorToolInput,
  timeZone = DEFAULT_MONITOR_TIME_ZONE
): ParsedMonitor {
  const query = cleanQuery(input.query);
  const source = input.source ?? inferMonitorSource(input.conditionType);
  const normalizedTimeZone = normalizeTimeZone(timeZone);

  if (!query) {
    throw new Error("Monitor query cannot be empty.");
  }

  if (input.kind === "interval") {
    const intervalMs = amountToMs(input.amount, input.unit);

    if (intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Monitor interval must be at least 1 minute.");
    }

    return {
      kind: "interval",
      query,
      source,
      conditionType: input.conditionType,
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
      query,
      source,
      conditionType: input.conditionType,
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
    query,
    source,
    conditionType: input.conditionType,
    weekday: WEEKDAYS.get(input.weekday) ?? 0,
    hour,
    minute,
    firstRunAt: nextWeeklyRun(WEEKDAYS.get(input.weekday) ?? 0, hour, minute, normalizedTimeZone)
  };
}

function getMonitorDestination(
  context: SlackScheduleContext,
  input: Pick<MonitorToolInput, "targetChannelId" | "targetChannelName">
): MonitorDestination {
  const targetChannel = getTargetChannel(context, input);

  if (!targetChannel) {
    return {
      channel: context.channel,
      threadTs: context.threadTs
    };
  }

  return {
    channel: targetChannel.id,
    channelName: targetChannel.name
  };
}

function getTargetChannel(
  context: SlackScheduleContext,
  input: Pick<MonitorToolInput, "targetChannelId" | "targetChannelName">
) {
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
    return context.mentionedChannels.find((channel) => channel.name?.toLowerCase() === targetChannelName) ?? null;
  }

  if (context.mentionedChannels.length === 1) {
    return context.mentionedChannels[0] ?? null;
  }

  return null;
}

async function listUserMonitors(userId: string) {
  const redis = await requireRedis();
  const ids = await redis.sMembers(getMonitorUserKey(userId));
  const monitors = (
    await Promise.all(ids.map((id) => loadMonitor(id)))
  ).filter((monitor): monitor is MonitorRecord => monitor !== null);

  if (monitors.length === 0) {
    return "You don't have any active monitors.";
  }

  const sorted = monitors.sort(
    (left, right) => new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime()
  );

  return `Your active monitors:\n${sorted
    .map((monitor) => `- \`${monitor.id.slice(0, 8)}\` ${formatMonitorSummary(monitor)}`)
    .join("\n")}`;
}

async function cancelUserMonitor(userId: string, idPrefix: string) {
  const match = await findUserMonitorByPrefix(userId, idPrefix);

  if (!match.ok) {
    return match.message;
  }

  await deleteMonitor(match.monitor.id, userId);
  return `Canceled monitor \`${match.monitor.id.slice(0, 8)}\`.`;
}

async function getIdempotentCreatedMonitor(context: SlackScheduleContext): Promise<
  | { status: "ready" }
  | { status: "exists"; monitor: CreatedMonitorResult }
  | { status: "locked"; lockedId: string }
> {
  const redis = await requireRedis();
  const resultKey = getMonitorCreateResultKey(context);
  const existingResult = await redis.get(resultKey);

  if (existingResult) {
    return {
      status: "exists",
      monitor: JSON.parse(existingResult) as CreatedMonitorResult
    };
  }

  const lockedId = randomUUID();
  const lockResult = await redis.set(getMonitorCreateLockKey(context), lockedId, {
    condition: "NX",
    expiration: {
      type: "EX",
      value: DEFAULT_MONITOR_CREATE_IDEMPOTENCY_TTL_SECONDS
    }
  });

  if (lockResult === "OK") {
    return { status: "ready" };
  }

  return { status: "locked", lockedId };
}

async function saveIdempotentCreatedMonitor(context: SlackScheduleContext, result: CreatedMonitorResult) {
  const redis = await requireRedis();

  await redis.set(getMonitorCreateResultKey(context), JSON.stringify(result), {
    expiration: {
      type: "EX",
      value: DEFAULT_MONITOR_CREATE_IDEMPOTENCY_TTL_SECONDS
    }
  });
}

async function loadMonitor(id: string) {
  const redis = await requireRedis();
  const payload = await redis.get(getMonitorJobKey(id));

  if (!payload) {
    return null;
  }

  return JSON.parse(payload) as MonitorRecord;
}

async function findUserMonitorByPrefix(userId: string, idPrefix: string): Promise<
  | { ok: true; monitor: MonitorRecord }
  | { ok: false; message: string }
> {
  const redis = await requireRedis();
  const normalizedPrefix = idPrefix.trim();

  if (!normalizedPrefix) {
    return { ok: false, message: "Tell me the monitor ID to use." };
  }

  const ids = await redis.sMembers(getMonitorUserKey(userId));
  const matches = ids.filter((id) => id.startsWith(normalizedPrefix));

  if (matches.length === 0) {
    return { ok: false, message: "I couldn't find one of your monitors with that ID." };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      message: `That ID matches more than one monitor. Use a longer ID:\n${matches
        .map((id) => `- \`${id.slice(0, 12)}\``)
        .join("\n")}`
    };
  }

  const monitor = await loadMonitor(matches[0] ?? "");
  if (!monitor) {
    return { ok: false, message: "That monitor no longer exists." };
  }

  return { ok: true, monitor };
}

async function deleteMonitor(id: string, userId: string) {
  const redis = await requireRedis();
  await redis.del(getMonitorJobKey(id));
  await redis.zRem(MONITOR_DUE_KEY, id);
  await redis.sRem(getMonitorUserKey(userId), id);
}

function formatMonitorAlert(monitor: MonitorRecord, result: ConditionalMonitorCheckResult) {
  const prefix = monitor.conditionType === "appears"
    ? "Monitor matched"
    : monitor.conditionType === "changes"
      ? "Monitor changed"
      : "Monitor failure condition matched";
  return `${prefix} for \`${monitor.query}\`: ${result.summary}`;
}

function formatCreatedMonitorResult(result: CreatedMonitorResult) {
  return `Created monitor \`${result.id.slice(0, 8)}\`: ${result.summary}`;
}

function formatMonitorSummary(monitor: MonitorRecord) {
  const timeZone = normalizeTimeZone(monitor.timezone);
  const next = formatDateTime(new Date(monitor.nextRunAt), timeZone);
  const destination = formatMonitorDestination(monitor);
  const source = formatMonitorSource(monitor.source);
  const condition = `${monitor.conditionType} for \`${monitor.query}\``;

  if (monitor.kind === "interval") {
    return `${source} ${condition} every ${formatDuration(monitor.intervalMs ?? MIN_INTERVAL_MS)}, next ${next}${destination}`;
  }

  if (monitor.kind === "daily") {
    return `${source} ${condition} daily at ${formatTime(monitor.hour ?? 0, monitor.minute ?? 0, timeZone)} ${formatTimeZoneLabel(timeZone)}, next ${next}${destination}`;
  }

  return `${source} ${condition} every ${formatWeekday(monitor.weekday ?? 0)} at ${formatTime(monitor.hour ?? 0, monitor.minute ?? 0, timeZone)} ${formatTimeZoneLabel(timeZone)}, next ${next}${destination}`;
}

function formatMonitorDestination(monitor: MonitorRecord) {
  if (monitor.threadTs) {
    return "";
  }

  if (monitor.channelName) {
    return ` in #${monitor.channelName}`;
  }

  return ` in <#${monitor.channel}>`;
}

function formatMonitorSource(source: MonitorSource) {
  if (source === "channel_history") {
    return "channel monitor";
  }

  if (source === "web_search") {
    return "web monitor";
  }

  return "prompt monitor";
}

function getNextRunAt(monitor: MonitorRecord) {
  if (monitor.kind === "interval") {
    return new Date(Date.now() + (monitor.intervalMs ?? MIN_INTERVAL_MS));
  }

  if (monitor.kind === "daily") {
    const timeZone = normalizeTimeZone(monitor.timezone);
    const nextBase = new Date(new Date(monitor.nextRunAt).getTime() + 60_000);
    const nextDay = addZonedDays(getZonedDateParts(nextBase, timeZone), 1, timeZone);
    return zonedDateToUtc(timeZone, nextDay.year, nextDay.month, nextDay.day, monitor.hour ?? 0, monitor.minute ?? 0);
  }

  const timeZone = normalizeTimeZone(monitor.timezone);
  const nextBase = new Date(new Date(monitor.nextRunAt).getTime() + 60_000);
  const nextWeek = addZonedDays(getZonedDateParts(nextBase, timeZone), 7, timeZone);
  return zonedDateToUtc(timeZone, nextWeek.year, nextWeek.month, nextWeek.day, monitor.hour ?? 0, monitor.minute ?? 0);
}

function inferMonitorSource(conditionType: MonitorConditionType): MonitorSource {
  if (conditionType === "appears") {
    return "channel_history";
  }

  if (conditionType === "changes") {
    return "web_search";
  }

  return "prompt";
}

function sourceNameToMonitorSource(input: string): MonitorSource {
  const normalized = input.toLowerCase();

  if (normalized === "web" || normalized === "search") {
    return "web_search";
  }

  if (normalized === "prompt") {
    return "prompt";
  }

  return "channel_history";
}

function normalizeUnit(input: string): "minutes" | "hours" | "days" {
  const normalized = input.toLowerCase();

  if (normalized.startsWith("hour")) {
    return "hours";
  }

  if (normalized.startsWith("day")) {
    return "days";
  }

  return "minutes";
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
    throw new Error(`Monitor ${label} must be a positive whole number.`);
  }

  return value;
}

function parseInteger(input: number | string, label: string) {
  const value = typeof input === "string" ? Number(input.trim()) : input;

  if (!Number.isInteger(value)) {
    throw new Error(`Monitor ${label} must be a whole number.`);
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
    throw new Error("Monitor time must use hour 0-23 and minute 0-59.");
  }
}

function nextDailyRun(hour: number, minute: number, timeZone = DEFAULT_MONITOR_TIME_ZONE) {
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
  timeZone = DEFAULT_MONITOR_TIME_ZONE
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

function formatDateTime(date: Date, timeZone = DEFAULT_MONITOR_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone
  }).format(date);
}

function formatTime(hour: number, minute: number, timeZone = DEFAULT_MONITOR_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(zonedDateToUtc(timeZone, 2026, 1, 1, hour, minute));
}

function formatTimeZoneLabel(timeZone: string) {
  return timeZone === DEFAULT_MONITOR_TIME_ZONE ? "CT" : timeZone;
}

function formatWeekday(weekday: number) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] ?? "Sunday";
}

function getZonedDateParts(date: Date, timeZone = DEFAULT_MONITOR_TIME_ZONE) {
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
  timeZone = DEFAULT_MONITOR_TIME_ZONE
) {
  const noon = zonedDateToUtc(timeZone, date.year, date.month, date.day + days, 12, 0);
  return getZonedDateParts(noon, timeZone);
}

function cleanQuery(input: string) {
  return input.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
}

function stableHash(input: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16);
}

function stripSlackFormatting(input: string) {
  return input
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/<#([CGD][A-Z0-9]+)\|([^>]+)>/g, "#$2")
    .trim();
}

function normalizeSlackChannelId(input: string | undefined) {
  const trimmed = input?.trim();

  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/^<#([CGD][A-Z0-9]+)(?:\|[^>]+)?>$/);
  return match?.[1] ?? trimmed;
}

function getMonitorRunnerIntervalMs() {
  const configured = Number(process.env.NOBO_MONITOR_RUNNER_INTERVAL_MS);

  if (Number.isFinite(configured) && configured >= 1000) {
    return configured;
  }

  return DEFAULT_MONITOR_INTERVAL_MS;
}

function normalizeDashboardLimit(limit: number, fallback: number, max: number) {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
}

function getMonitorJobKey(id: string) {
  return `${MONITOR_JOB_PREFIX}${id}`;
}

function getMonitorUserKey(userId: string) {
  return `${MONITOR_USER_PREFIX}${userId}`;
}

function getMonitorCreateResultKey(context: SlackScheduleContext) {
  return `${MONITOR_CREATE_RESULT_PREFIX}${context.channel}:${context.sourceTs}`;
}

function getMonitorCreateLockKey(context: SlackScheduleContext) {
  return `${MONITOR_CREATE_LOCK_PREFIX}${context.channel}:${context.sourceTs}`;
}

async function requireRedis() {
  const redis = await getRedisClient();

  if (!redis) {
    throw new Error("Monitors require REDIS_URL.");
  }

  return redis;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export const __testing = {
  evaluateChannelHistoryMonitor,
  formatMonitorSummary,
  inferMonitorSource,
  monitorToolInputToParsedMonitor,
  parseMonitorCommandText,
  shouldPostMonitorAlert
};
