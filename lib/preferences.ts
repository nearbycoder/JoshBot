import { getRedisClient } from "./redis.js";
import { normalizeOpenCodeGoSupportedModelId } from "./nobo-models.js";

export type UserVerbosity = "concise" | "normal" | "detailed";
export type ReminderStyle = "direct" | "gentle" | "detailed";

export type UserPreferences = {
  timeZone: string;
  verbosity: UserVerbosity;
  newsInterests: string[];
  reminderStyle: ReminderStyle;
};

export type ChannelPreferences = {
  modelId: string | null;
};

export type ChannelPreferenceStatus = {
  channelId: string;
  modelId: string | null;
};

const USER_PREFERENCES_PREFIX = "slack-preferences:user:";
const CHANNEL_PREFERENCES_PREFIX = "slack-preferences:channel:";
const DEFAULT_TIME_ZONE = "America/Chicago";
const DEFAULT_VERBOSITY: UserVerbosity = "normal";
const DEFAULT_REMINDER_STYLE: ReminderStyle = "direct";
const MAX_NEWS_INTERESTS = 12;
const MAX_NEWS_INTEREST_LENGTH = 80;

const TIME_ZONE_ALIASES = new Map([
  ["ct", "America/Chicago"],
  ["cst", "America/Chicago"],
  ["cdt", "America/Chicago"],
  ["et", "America/New_York"],
  ["est", "America/New_York"],
  ["edt", "America/New_York"],
  ["pt", "America/Los_Angeles"],
  ["pst", "America/Los_Angeles"],
  ["pdt", "America/Los_Angeles"],
  ["mt", "America/Denver"],
  ["mst", "America/Denver"],
  ["mdt", "America/Denver"],
  ["utc", "UTC"]
]);

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  timeZone: DEFAULT_TIME_ZONE,
  verbosity: DEFAULT_VERBOSITY,
  newsInterests: [],
  reminderStyle: DEFAULT_REMINDER_STYLE
};

export const DEFAULT_CHANNEL_PREFERENCES: ChannelPreferences = {
  modelId: null
};

export async function getUserPreferences(userId: string | undefined) {
  if (!userId) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  const redis = await getRedisClient();

  if (!redis) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  const payload = await redis.get(getUserPreferencesKey(userId));
  return normalizeUserPreferencesPayload(payload);
}

export async function getChannelPreferences(channelId: string | undefined) {
  if (!channelId) {
    return { ...DEFAULT_CHANNEL_PREFERENCES };
  }

  const redis = await getRedisClient();

  if (!redis) {
    return { ...DEFAULT_CHANNEL_PREFERENCES };
  }

  const payload = await redis.get(getChannelPreferencesKey(channelId));
  return normalizeChannelPreferencesPayload(payload);
}

export async function listChannelPreferenceStatuses(limit = 20) {
  const redis = await getRedisClient();

  if (!redis) {
    return [];
  }

  const statuses: ChannelPreferenceStatus[] = [];
  let cursor = "0";

  do {
    const reply = await redis.sendCommand([
      "SCAN",
      cursor,
      "MATCH",
      `${CHANNEL_PREFERENCES_PREFIX}*`,
      "COUNT",
      "100"
    ]);
    const scan = parseScanReply(reply);
    cursor = scan.cursor;

    const batch = await Promise.all(
      scan.keys.map(async (key) => {
        const payload = await redis.get(key);
        const channelId = key.slice(CHANNEL_PREFERENCES_PREFIX.length);

        if (!payload || !channelId) {
          return null;
        }

        return {
          channelId,
          modelId: normalizeChannelPreferencesPayload(payload).modelId
        };
      })
    );

    statuses.push(...batch.filter((status): status is ChannelPreferenceStatus => status !== null));
  } while (cursor !== "0");

  return statuses
    .sort(
      (left, right) =>
        Number(Boolean(right.modelId)) - Number(Boolean(left.modelId)) ||
        left.channelId.localeCompare(right.channelId)
    )
    .slice(0, normalizeLimit(limit, 20, 100));
}

export async function updateUserPreferences(
  userId: string,
  patch: Partial<UserPreferences>
) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const current = await getUserPreferences(userId);
  const next = normalizeUserPreferences({
    ...current,
    ...patch
  });

  await redis.set(getUserPreferencesKey(userId), JSON.stringify(next));

  return {
    ok: true as const,
    preferences: next
  };
}

export async function updateChannelPreferences(
  channelId: string,
  patch: Partial<ChannelPreferences>
) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const current = await getChannelPreferences(channelId);
  const next = normalizeChannelPreferences({
    ...current,
    ...patch
  });

  await redis.set(getChannelPreferencesKey(channelId), JSON.stringify(next));

  return {
    ok: true as const,
    preferences: next
  };
}

export async function setChannelModelPreference(channelId: string, modelId: string) {
  const normalizedModelId = normalizeOpenCodeGoSupportedModelId(modelId);

  if (!normalizedModelId) {
    return {
      ok: false as const,
      reason: "Model ID is not valid."
    };
  }

  return updateChannelPreferences(channelId, {
    modelId: normalizedModelId
  });
}

export async function clearChannelModelPreference(channelId: string) {
  return updateChannelPreferences(channelId, {
    modelId: null
  });
}

export async function clearUserPreferences(userId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  await redis.del(getUserPreferencesKey(userId));

  return {
    ok: true as const,
    preferences: { ...DEFAULT_USER_PREFERENCES }
  };
}

export async function maybeHandleUserPreferencesCommand({
  userId,
  commandText
}: {
  userId: string | undefined;
  commandText: string;
}) {
  const args = parsePreferenceCommand(commandText);

  if (args === null) {
    return null;
  }

  return handleUserPreferencesCommand(userId, args);
}

export async function handleUserPreferencesCommand(
  userId: string | undefined,
  args: string
) {
  if (!userId) {
    return "I couldn't tell which Slack user to save preferences for.";
  }

  const trimmed = args.trim();

  if (!trimmed || /^(show|list|status)$/i.test(trimmed)) {
    return formatUserPreferencesForSlack(await getUserPreferences(userId));
  }

  if (/^help$/i.test(trimmed)) {
    return formatUserPreferencesHelp();
  }

  if (/^(clear|reset)$/i.test(trimmed)) {
    const result = await clearUserPreferences(userId);
    return result.ok
      ? `Reset preferences.\n${formatUserPreferencesForSlack(result.preferences)}`
      : `Couldn't reset preferences: ${result.reason}`;
  }

  const command = trimmed.replace(/^set\s+/i, "");
  const fieldMatch = command.match(/^([a-z-]+)\s*(.*)$/i);
  const field = normalizePreferenceField(fieldMatch?.[1] ?? "");
  const value = (fieldMatch?.[2] ?? "").trim();

  if (!field) {
    return `I don't recognize that preference.\n\n${formatUserPreferencesHelp()}`;
  }

  if (field === "timezone") {
    return updatePreference(userId, parseTimeZonePreference(value));
  }

  if (field === "verbosity") {
    return updatePreference(userId, parseVerbosityPreference(value));
  }

  if (field === "reminder-style") {
    return updatePreference(userId, parseReminderStylePreference(value));
  }

  return updateNewsInterestsPreference(userId, value);
}

export function formatUserPreferencesHelp() {
  return [
    "*NoBo preferences*",
    "`/nobo-prefs`: show preferences",
    "`/nobo-prefs timezone America/New_York`",
    "`/nobo-prefs verbosity concise|normal|detailed`",
    "`/nobo-prefs news ai, startups, security`",
    "`/nobo-prefs news add robotics`",
    "`/nobo-prefs news remove security`",
    "`/nobo-prefs reminder-style direct|gentle|detailed`",
    "`/nobo-prefs clear`"
  ].join("\n");
}

export function formatUserPreferencesForSlack(preferences: UserPreferences) {
  return [
    "*Your NoBo preferences*",
    `Timezone: \`${preferences.timeZone}\``,
    `Verbosity: \`${preferences.verbosity}\``,
    `News interests: ${preferences.newsInterests.length ? preferences.newsInterests.map((interest) => `\`${interest}\``).join(", ") : "_none_"}`,
    `Reminder style: \`${preferences.reminderStyle}\``
  ].join("\n");
}

export function formatUserPreferencesPrompt(
  preferences: UserPreferences,
  currentUserId: string | undefined
) {
  const currentUserLabel = currentUserId ? `Slack user ${currentUserId}` : "the current speaker";
  const newsInterests = preferences.newsInterests.length
    ? preferences.newsInterests.join(", ")
    : "none";

  return `Personal preferences for ${currentUserLabel}:
- Timezone: ${preferences.timeZone}
- Verbosity: ${preferences.verbosity}
- News interests: ${newsInterests}
- Reminder style: ${preferences.reminderStyle}

Apply these preferences only to ${currentUserLabel}. Use the timezone for relative dates and schedules. Match verbosity unless the user asks otherwise. Use news interests to focus broad news requests. Use reminder style for reminder wording.`;
}

export function getPreferredNewsFocus(preferences: UserPreferences) {
  return preferences.newsInterests.join(", ");
}

export function normalizeTimeZone(input: string | undefined, fallback = DEFAULT_TIME_ZONE) {
  const trimmed = input?.trim();

  if (!trimmed) {
    return fallback;
  }

  const aliased = TIME_ZONE_ALIASES.get(trimmed.toLowerCase()) ?? trimmed;

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: aliased
    }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
}

function getUserPreferencesKey(userId: string) {
  return `${USER_PREFERENCES_PREFIX}${userId}`;
}

function getChannelPreferencesKey(channelId: string) {
  return `${CHANNEL_PREFERENCES_PREFIX}${channelId}`;
}

function normalizeUserPreferencesPayload(payload: string | null) {
  if (!payload) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  try {
    return normalizeUserPreferences(JSON.parse(payload) as unknown);
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
}

function normalizeChannelPreferencesPayload(payload: string | null) {
  if (!payload) {
    return { ...DEFAULT_CHANNEL_PREFERENCES };
  }

  try {
    return normalizeChannelPreferences(JSON.parse(payload) as unknown);
  } catch {
    return { ...DEFAULT_CHANNEL_PREFERENCES };
  }
}

function normalizeUserPreferences(input: unknown): UserPreferences {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  const record = input as Partial<Record<keyof UserPreferences, unknown>>;

  return {
    timeZone: normalizeTimeZone(
      typeof record.timeZone === "string" ? record.timeZone : undefined
    ),
    verbosity: normalizeVerbosity(record.verbosity),
    newsInterests: normalizeNewsInterests(record.newsInterests),
    reminderStyle: normalizeReminderStyle(record.reminderStyle)
  };
}

function normalizeChannelPreferences(input: unknown): ChannelPreferences {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_CHANNEL_PREFERENCES };
  }

  const record = input as Partial<Record<keyof ChannelPreferences, unknown>>;

  return {
    modelId:
      typeof record.modelId === "string"
        ? normalizeOpenCodeGoSupportedModelId(record.modelId)
        : DEFAULT_CHANNEL_PREFERENCES.modelId
  };
}

function parsePreferenceCommand(commandText: string) {
  const trimmed = commandText.trim();
  const match = trimmed.match(/^(?:prefs|preferences|preference|settings)(?:\s+(.*))?$/i);

  if (!match) {
    return null;
  }

  return match[1]?.trim() ?? "";
}

function normalizePreferenceField(input: string) {
  const normalized = input.toLowerCase();

  if (["tz", "timezone", "time-zone"].includes(normalized)) {
    return "timezone";
  }

  if (["verbosity", "verbose", "length"].includes(normalized)) {
    return "verbosity";
  }

  if (["news", "interests", "news-interests", "topics"].includes(normalized)) {
    return "news";
  }

  if (["reminder", "reminders", "reminder-style", "style"].includes(normalized)) {
    return "reminder-style";
  }

  return null;
}

function parseTimeZonePreference(value: string): Partial<UserPreferences> | string {
  if (!value) {
    return "Usage: `/nobo-prefs timezone America/New_York`";
  }

  const timeZone = normalizeTimeZone(value, "");

  if (!timeZone) {
    return "That timezone was not recognized. Use an IANA name like `America/New_York`.";
  }

  return { timeZone };
}

function parseVerbosityPreference(value: string): Partial<UserPreferences> | string {
  const normalizedValue = value.trim().toLowerCase();
  const verbosity = normalizeVerbosity(value);

  if (
    !normalizedValue ||
    !["concise", "brief", "short", "terse", "normal", "default", "medium", "detailed", "verbose", "thorough", "long"].includes(normalizedValue)
  ) {
    return "Usage: `/nobo-prefs verbosity concise|normal|detailed`";
  }

  return { verbosity };
}

function parseReminderStylePreference(value: string): Partial<UserPreferences> | string {
  const normalizedValue = value.trim().toLowerCase();
  const reminderStyle = normalizeReminderStyle(value);

  if (
    !normalizedValue ||
    !["direct", "brief", "default", "gentle", "friendly", "soft", "detailed", "context", "full"].includes(normalizedValue)
  ) {
    return "Usage: `/nobo-prefs reminder-style direct|gentle|detailed`";
  }

  return { reminderStyle };
}

async function updateNewsInterestsPreference(userId: string, value: string) {
  const current = await getUserPreferences(userId);
  const normalized = value.trim();

  if (!normalized || /^(show|list|status)$/i.test(normalized)) {
    return current.newsInterests.length
      ? `News interests: ${current.newsInterests.join(", ")}`
      : "No news interests set.";
  }

  if (/^(clear|reset|none)$/i.test(normalized)) {
    return updatePreference(userId, { newsInterests: [] });
  }

  const actionMatch = normalized.match(/^(add|remove|delete)\s+(.+)$/i);

  if (actionMatch) {
    const action = actionMatch[1]?.toLowerCase();
    const requested = normalizeNewsInterests(parseNewsInterestList(actionMatch[2] ?? ""));
    const requestedSet = new Set(requested.map(normalizeForCompare));
    const newsInterests =
      action === "add"
        ? normalizeNewsInterests([...current.newsInterests, ...requested])
        : current.newsInterests.filter((interest) => !requestedSet.has(normalizeForCompare(interest)));

    return updatePreference(userId, { newsInterests });
  }

  return updatePreference(userId, {
    newsInterests: normalizeNewsInterests(parseNewsInterestList(normalized))
  });
}

async function updatePreference(userId: string, patchOrError: Partial<UserPreferences> | string) {
  if (typeof patchOrError === "string") {
    return patchOrError;
  }

  const result = await updateUserPreferences(userId, patchOrError);

  return result.ok
    ? `Updated preferences.\n${formatUserPreferencesForSlack(result.preferences)}`
    : `Couldn't update preferences: ${result.reason}`;
}

function normalizeVerbosity(input: unknown): UserVerbosity {
  if (typeof input !== "string") {
    return DEFAULT_VERBOSITY;
  }

  const value = input.trim().toLowerCase();

  if (["concise", "brief", "short", "terse"].includes(value)) {
    return "concise";
  }

  if (["detailed", "verbose", "thorough", "long"].includes(value)) {
    return "detailed";
  }

  if (["normal", "default", "medium"].includes(value)) {
    return "normal";
  }

  return DEFAULT_VERBOSITY;
}

function normalizeReminderStyle(input: unknown): ReminderStyle {
  if (typeof input !== "string") {
    return DEFAULT_REMINDER_STYLE;
  }

  const value = input.trim().toLowerCase();

  if (["gentle", "friendly", "soft"].includes(value)) {
    return "gentle";
  }

  if (["detailed", "context", "full"].includes(value)) {
    return "detailed";
  }

  if (["direct", "brief", "default"].includes(value)) {
    return "direct";
  }

  return DEFAULT_REMINDER_STYLE;
}

function normalizeNewsInterests(input: unknown) {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const interests: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const interest = value.replace(/\s+/g, " ").trim().slice(0, MAX_NEWS_INTEREST_LENGTH);
    const normalized = normalizeForCompare(interest);

    if (!interest || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    interests.push(interest);

    if (interests.length >= MAX_NEWS_INTERESTS) {
      break;
    }
  }

  return interests;
}

function parseNewsInterestList(input: string) {
  return input
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeForCompare(input: string) {
  return input.trim().toLowerCase();
}

function commandReplyToString(input: unknown) {
  if (typeof input === "string") {
    return input;
  }

  if (Buffer.isBuffer(input)) {
    return input.toString("utf8");
  }

  return "";
}

function parseScanReply(input: unknown) {
  if (!Array.isArray(input) || input.length < 2) {
    return { cursor: "0", keys: [] as string[] };
  }

  const keysInput = input[1];
  const keys = Array.isArray(keysInput)
    ? keysInput.map(commandReplyToString).filter(Boolean)
    : [];

  return {
    cursor: commandReplyToString(input[0]) || "0",
    keys
  };
}

function normalizeLimit(input: number, fallback: number, max: number) {
  if (!Number.isInteger(input) || input < 1) {
    return fallback;
  }

  return Math.min(input, max);
}

export const __testing = {
  getChannelPreferencesKey,
  getUserPreferencesKey,
  normalizeChannelPreferences,
  parseScanReply,
  normalizeTimeZone,
  normalizeUserPreferences,
  parseNewsInterestList,
  formatUserPreferencesPrompt
};
