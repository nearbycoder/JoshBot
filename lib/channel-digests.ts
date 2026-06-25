import { randomUUID } from "node:crypto";
import { createSlackSkillReply } from "./ai.js";
import { fetchSlackChannelHistory } from "./channel-history.js";
import { getRedisClient } from "./redis.js";

type ChannelDigestFrequency = "daily" | "weekly";

type ChannelDigestHistoryMessage = Awaited<ReturnType<typeof fetchSlackChannelHistory>>[number];

type ChannelDigestSubscription = {
  id: string;
  ownerUserId: string;
  channel: string;
  frequency: ChannelDigestFrequency;
  weekday?: number;
  hour: number;
  minute: number;
  focus: string;
  createdAt: string;
  nextRunAt: string;
  timezone: "America/Chicago";
};

type ParsedChannelDigestCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "cancel"; idPrefix: string }
  | {
      kind: "create";
      frequency: ChannelDigestFrequency;
      weekday?: number;
      hour: number;
      minute: number;
      focus: string;
    };

type SlackGeneratedMessagePoster = (options: {
  channel: string;
  threadTs?: string;
  createReply: (onTextDelta: (delta: string) => Promise<void>) => Promise<string | null>;
}) => Promise<unknown>;

const CHANNEL_DIGEST_DUE_KEY = "channel-digests:due";
const CHANNEL_DIGEST_JOB_PREFIX = "channel-digests:subscription:";
const CHANNEL_DIGEST_CHANNEL_PREFIX = "channel-digests:channel:";
const CHANNEL_DIGEST_USER_PREFIX = "channel-digests:user:";
const DEFAULT_CHANNEL_DIGEST_RUNNER_INTERVAL_MS = 30_000;
const CHANNEL_DIGEST_HISTORY_LIMIT = 200;
const MAX_DUE_DIGESTS_PER_TICK = 5;
const RETRY_DELAY_MS = 5 * 60 * 1000;

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

let channelDigestRunnerStarted = false;
let channelDigestRunnerRunning = false;

export async function handleChannelDigestCommand({
  text,
  channelId,
  ownerUserId,
  commandName = "/nobo-channel-digest"
}: {
  text: string;
  channelId?: string;
  ownerUserId?: string;
  commandName?: string;
}) {
  const command = parseChannelDigestCommand(text);

  if (command.kind === "help") {
    return formatChannelDigestCommandHelp(commandName);
  }

  if (!channelId) {
    return "Slack did not send a channel for this command. Try again in a channel.";
  }

  try {
    if (command.kind === "list") {
      return listChannelDigestSubscriptions(channelId);
    }

    if (command.kind === "cancel") {
      return cancelChannelDigestSubscriptionByPrefix(channelId, command.idPrefix);
    }

    if (!ownerUserId) {
      return "Slack did not send a user for this command. Try again in Slack.";
    }

    const subscription = await createChannelDigestSubscription({
      ownerUserId,
      channel: channelId,
      frequency: command.frequency,
      weekday: command.weekday,
      hour: command.hour,
      minute: command.minute,
      focus: command.focus
    });

    return `Subscribed this channel: \`${subscription.id.slice(0, 8)}\` ${formatChannelDigestSubscriptionSummary(subscription)}.`;
  } catch (error) {
    return `Couldn't update channel digest subscriptions: ${summarizeError(error)}`;
  }
}

export function formatChannelDigestCommandHelp(command = "/nobo-channel-digest") {
  return [
    "*NoBo channel digests*",
    `\`${command} daily 09:00 [focus]\`: subscribe this channel to a daily digest`,
    `\`${command} weekly monday 09:00 [focus]\`: subscribe this channel to a weekly digest`,
    `\`${command} list\`: show this channel's digest subscriptions`,
    `\`${command} cancel <id>\`: cancel a subscription`,
    "Times are America/Chicago."
  ].join("\n");
}

export async function createChannelDigestSlackMessage({
  channel,
  frequency,
  focus,
  currentUserId,
  onTextDelta
}: {
  channel: string;
  frequency: ChannelDigestFrequency;
  focus: string;
  currentUserId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  const days = frequency === "daily" ? 1 : 7;
  const messages = await fetchSlackChannelHistory({
    channel,
    days,
    limit: CHANNEL_DIGEST_HISTORY_LIMIT
  });

  if (messages.length === 0) {
    return formatEmptyChannelDigest(frequency, focus, days);
  }

  return createSlackSkillReply({
    messages: [
      {
        role: "user",
        content: formatChannelDigestPrompt({
          channel,
          frequency,
          focus,
          days,
          messages
        })
      }
    ],
    memories: [],
    currentUserId,
    channelId: channel,
    skillName: "channel-digest",
    instructions: `Your job is to produce a concise Slack channel digest.
- Use only the supplied channel history.
- If a focus is supplied, center the digest on relevant messages while still calling out major decisions or blockers.
- Prefer sections only when useful: Highlights, Decisions, Action items, Needs attention.
- Keep it concise: 5-10 bullets total.
- Do not include a Sources section.`,
    onTextDelta
  });
}

export function startChannelDigestSubscriptionRunner({
  postGeneratedSlackMessage
}: {
  postGeneratedSlackMessage: SlackGeneratedMessagePoster;
}) {
  if (channelDigestRunnerStarted) {
    return;
  }

  channelDigestRunnerStarted = true;

  void runDueChannelDigestSubscriptions({ postGeneratedSlackMessage }).catch((error) => {
    console.error(`Channel digest runner failed: ${summarizeError(error)}`);
  });

  setInterval(() => {
    void runDueChannelDigestSubscriptions({ postGeneratedSlackMessage }).catch((error) => {
      console.error(`Channel digest runner failed: ${summarizeError(error)}`);
    });
  }, getChannelDigestRunnerIntervalMs()).unref();
}

async function createChannelDigestSubscription({
  ownerUserId,
  channel,
  frequency,
  weekday,
  hour,
  minute,
  focus
}: {
  ownerUserId: string;
  channel: string;
  frequency: ChannelDigestFrequency;
  weekday?: number;
  hour: number;
  minute: number;
  focus: string;
}) {
  const redis = await requireRedis();
  const now = new Date();
  const id = randomUUID();
  const firstRunAt =
    frequency === "daily"
      ? nextDailyRun(hour, minute)
      : nextWeeklyRun(weekday ?? 1, hour, minute);
  const subscription: ChannelDigestSubscription = {
    id,
    ownerUserId,
    channel,
    frequency,
    ...(frequency === "weekly" ? { weekday: weekday ?? 1 } : {}),
    hour,
    minute,
    focus,
    createdAt: now.toISOString(),
    nextRunAt: firstRunAt.toISOString(),
    timezone: "America/Chicago"
  };

  await redis.set(getChannelDigestJobKey(id), JSON.stringify(subscription));
  await redis.zAdd(CHANNEL_DIGEST_DUE_KEY, {
    score: firstRunAt.getTime(),
    value: id
  });
  await redis.sAdd(getChannelDigestChannelKey(channel), id);
  await redis.sAdd(getChannelDigestUserKey(ownerUserId), id);

  return subscription;
}

async function listChannelDigestSubscriptions(channelId: string) {
  const redis = await requireRedis();
  const ids = await redis.sMembers(getChannelDigestChannelKey(channelId));
  const subscriptions = (
    await Promise.all(ids.map((id) => loadChannelDigestSubscription(id)))
  ).filter((subscription): subscription is ChannelDigestSubscription => subscription !== null);

  if (subscriptions.length === 0) {
    return "This channel has no digest subscriptions.";
  }

  const sorted = subscriptions.sort(
    (left, right) => new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime()
  );

  return `Channel digest subscriptions:\n${sorted
    .map((subscription) => `- \`${subscription.id.slice(0, 8)}\` ${formatChannelDigestSubscriptionSummary(subscription)}`)
    .join("\n")}`;
}

async function cancelChannelDigestSubscriptionByPrefix(channelId: string, idPrefix: string) {
  const match = await findChannelDigestSubscriptionByPrefix(channelId, idPrefix);

  if (!match.ok) {
    return match.message;
  }

  await deleteChannelDigestSubscription(match.subscription);
  return `Canceled channel digest subscription \`${match.subscription.id.slice(0, 8)}\`.`;
}

async function runDueChannelDigestSubscriptions({
  postGeneratedSlackMessage
}: {
  postGeneratedSlackMessage: SlackGeneratedMessagePoster;
}) {
  if (channelDigestRunnerRunning) {
    return;
  }

  channelDigestRunnerRunning = true;

  try {
    const redis = await getRedisClient();
    if (!redis) {
      return;
    }

    const dueIds = await redis.zRangeByScore(CHANNEL_DIGEST_DUE_KEY, 0, Date.now(), {
      LIMIT: {
        offset: 0,
        count: MAX_DUE_DIGESTS_PER_TICK
      }
    });

    for (const id of dueIds) {
      const claimed = await redis.zRem(CHANNEL_DIGEST_DUE_KEY, id);
      if (!claimed) {
        continue;
      }

      const subscription = await loadChannelDigestSubscription(id);
      if (!subscription) {
        continue;
      }

      try {
        await postGeneratedSlackMessage({
          channel: subscription.channel,
          createReply: (onTextDelta) =>
            createChannelDigestSlackMessage({
              channel: subscription.channel,
              frequency: subscription.frequency,
              focus: subscription.focus,
              currentUserId: subscription.ownerUserId,
              onTextDelta
            })
        });

        const nextRunAt = getNextChannelDigestRunAt(subscription);
        subscription.nextRunAt = nextRunAt.toISOString();
        await redis.set(getChannelDigestJobKey(subscription.id), JSON.stringify(subscription));
        await redis.zAdd(CHANNEL_DIGEST_DUE_KEY, {
          score: nextRunAt.getTime(),
          value: subscription.id
        });
      } catch (error) {
        console.error(`Channel digest subscription ${subscription.id} failed: ${summarizeError(error)}`);
        await redis.zAdd(CHANNEL_DIGEST_DUE_KEY, {
          score: Date.now() + RETRY_DELAY_MS,
          value: subscription.id
        });
      }
    }
  } finally {
    channelDigestRunnerRunning = false;
  }
}

function parseChannelDigestCommand(text: string): ParsedChannelDigestCommand {
  const trimmed = text.trim();

  if (!trimmed || /^help$/i.test(trimmed)) {
    return { kind: "help" };
  }

  if (/^(list|show|status)$/i.test(trimmed)) {
    return { kind: "list" };
  }

  const cancelMatch = trimmed.match(/^(?:cancel|delete|remove)\s+([a-z0-9-]+)$/i);
  if (cancelMatch) {
    return { kind: "cancel", idPrefix: cancelMatch[1] ?? "" };
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = normalizeToken(tokens.shift() ?? "");
  const frequencyToken =
    firstToken === "subscribe" || firstToken === "add" ? normalizeToken(tokens.shift() ?? "") : firstToken;

  if (frequencyToken === "daily") {
    return parseDailyDigestCommand(tokens);
  }

  if (frequencyToken === "weekly") {
    return parseWeeklyDigestCommand(tokens);
  }

  return { kind: "help" };
}

function parseDailyDigestCommand(tokens: string[]): ParsedChannelDigestCommand {
  skipOptionalAt(tokens);
  const time = parseTimeToken(tokens.shift());

  if (!time) {
    return { kind: "help" };
  }

  return {
    kind: "create",
    frequency: "daily",
    hour: time.hour,
    minute: time.minute,
    focus: cleanFocus(tokens.join(" "))
  };
}

function parseWeeklyDigestCommand(tokens: string[]): ParsedChannelDigestCommand {
  const weekday = WEEKDAYS.get(normalizeToken(tokens.shift() ?? ""));

  if (weekday === undefined) {
    return { kind: "help" };
  }

  skipOptionalAt(tokens);
  const time = parseTimeToken(tokens.shift());

  if (!time) {
    return { kind: "help" };
  }

  return {
    kind: "create",
    frequency: "weekly",
    weekday,
    hour: time.hour,
    minute: time.minute,
    focus: cleanFocus(tokens.join(" "))
  };
}

function parseTimeToken(token: string | undefined) {
  if (!token) {
    return null;
  }

  const clockMatch = token.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (clockMatch) {
    return {
      hour: Number(clockMatch[1]),
      minute: Number(clockMatch[2])
    };
  }

  const meridiemMatch = token.match(/^(\d{1,2})(?::([0-5]\d))?(am|pm)$/i);
  if (!meridiemMatch) {
    return null;
  }

  const rawHour = Number(meridiemMatch[1]);
  const minute = Number(meridiemMatch[2] ?? "0");
  const meridiem = meridiemMatch[3]?.toLowerCase();

  if (rawHour < 1 || rawHour > 12) {
    return null;
  }

  return {
    hour: meridiem === "pm" && rawHour !== 12 ? rawHour + 12 : meridiem === "am" && rawHour === 12 ? 0 : rawHour,
    minute
  };
}

function skipOptionalAt(tokens: string[]) {
  if (normalizeToken(tokens[0] ?? "") === "at") {
    tokens.shift();
  }
}

function cleanFocus(input: string) {
  return input.replace(/^(?:focus|focused|about|on)\s+/i, "").trim();
}

function normalizeToken(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9:-]/g, "");
}

function formatChannelDigestPrompt({
  channel,
  frequency,
  focus,
  days,
  messages
}: {
  channel: string;
  frequency: ChannelDigestFrequency;
  focus: string;
  days: number;
  messages: ChannelDigestHistoryMessage[];
}) {
  const orderedMessages = [...messages].reverse();

  return [
    `Create a ${frequency} Slack channel digest for channel ${channel}.`,
    `History window: last ${days} ${days === 1 ? "day" : "days"}.`,
    focus ? `Focus: ${focus}` : "Focus: general channel activity.",
    "",
    "Messages, oldest first:",
    ...orderedMessages.map((message) => `- [${message.datetime}] ${message.speaker}: ${message.text}`)
  ].join("\n");
}

function formatEmptyChannelDigest(frequency: ChannelDigestFrequency, focus: string, days: number) {
  const heading = focus
    ? `*${capitalize(frequency)} channel digest for "${escapeSlackText(focus)}"*`
    : `*${capitalize(frequency)} channel digest*`;

  return `${heading}\nNo summarizable channel messages found for the last ${days === 1 ? "day" : `${days} days`}.`;
}

function formatChannelDigestSubscriptionSummary(subscription: ChannelDigestSubscription) {
  const cadence =
    subscription.frequency === "daily"
      ? `daily at ${formatTime(subscription.hour, subscription.minute)} CT`
      : `weekly ${formatWeekday(subscription.weekday ?? 1)} at ${formatTime(subscription.hour, subscription.minute)} CT`;
  const focus = subscription.focus ? `, focus "${escapeSlackText(subscription.focus)}"` : "";
  const next = formatDateTime(new Date(subscription.nextRunAt));

  return `${cadence}${focus}, next ${next}`;
}

function getNextChannelDigestRunAt(subscription: ChannelDigestSubscription) {
  const nextBase = new Date(new Date(subscription.nextRunAt).getTime() + 60_000);

  if (subscription.frequency === "daily") {
    const nextDay = addChicagoDays(getChicagoDateParts(nextBase), 1);
    return chicagoDateToUtc(nextDay.year, nextDay.month, nextDay.day, subscription.hour, subscription.minute);
  }

  const nextWeek = addChicagoDays(getChicagoDateParts(nextBase), 7);
  return chicagoDateToUtc(nextWeek.year, nextWeek.month, nextWeek.day, subscription.hour, subscription.minute);
}

async function loadChannelDigestSubscription(id: string) {
  const redis = await requireRedis();
  const payload = await redis.get(getChannelDigestJobKey(id));

  if (!payload) {
    return null;
  }

  return JSON.parse(payload) as ChannelDigestSubscription;
}

async function findChannelDigestSubscriptionByPrefix(channelId: string, idPrefix: string): Promise<
  | { ok: true; subscription: ChannelDigestSubscription }
  | { ok: false; message: string }
> {
  const redis = await requireRedis();
  const normalizedPrefix = idPrefix.trim();

  if (!normalizedPrefix) {
    return { ok: false, message: "Tell me the channel digest subscription ID to use." };
  }

  const ids = await redis.sMembers(getChannelDigestChannelKey(channelId));
  const matches = ids.filter((id) => id.startsWith(normalizedPrefix));

  if (matches.length === 0) {
    return { ok: false, message: "I couldn't find a channel digest subscription with that ID." };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      message: `That ID matches more than one channel digest subscription. Use a longer ID:\n${matches
        .map((id) => `- \`${id.slice(0, 12)}\``)
        .join("\n")}`
    };
  }

  const subscription = await loadChannelDigestSubscription(matches[0] ?? "");
  if (!subscription) {
    return { ok: false, message: "That channel digest subscription no longer exists." };
  }

  return { ok: true, subscription };
}

async function deleteChannelDigestSubscription(subscription: ChannelDigestSubscription) {
  const redis = await requireRedis();

  await redis.del(getChannelDigestJobKey(subscription.id));
  await redis.zRem(CHANNEL_DIGEST_DUE_KEY, subscription.id);
  await redis.sRem(getChannelDigestChannelKey(subscription.channel), subscription.id);
  await redis.sRem(getChannelDigestUserKey(subscription.ownerUserId), subscription.id);
}

async function requireRedis() {
  const redis = await getRedisClient();

  if (!redis) {
    throw new Error("Channel digest subscriptions require REDIS_URL.");
  }

  return redis;
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
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday] ?? "Monday";
}

function getChannelDigestRunnerIntervalMs() {
  const rawValue = process.env.CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS ?? process.env.SCHEDULER_INTERVAL_MS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 5_000) {
    return DEFAULT_CHANNEL_DIGEST_RUNNER_INTERVAL_MS;
  }

  return parsedValue;
}

function getChannelDigestJobKey(id: string) {
  return `${CHANNEL_DIGEST_JOB_PREFIX}${id}`;
}

function getChannelDigestChannelKey(channelId: string) {
  return `${CHANNEL_DIGEST_CHANNEL_PREFIX}${channelId}`;
}

function getChannelDigestUserKey(userId: string) {
  return `${CHANNEL_DIGEST_USER_PREFIX}${userId}`;
}

function capitalize(input: string) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

function escapeSlackText(input: string) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  formatChannelDigestPrompt,
  formatChannelDigestSubscriptionSummary,
  getChannelDigestChannelKey,
  getChannelDigestJobKey,
  getChannelDigestRunnerIntervalMs,
  parseChannelDigestCommand,
  parseTimeToken
};
