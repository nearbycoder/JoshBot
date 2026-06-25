import { getRedisClient } from "./redis.js";

type AccessKind = "channels" | "users";
type AccessMode = "allow" | "deny";

export type NoboAccessSubject = {
  userId?: string;
  channelId?: string;
  teamId?: string;
  action?: string;
  surface?: string;
};

export type NoboAccessDecision = {
  allowed: boolean;
  reason?: string;
};

export type NoboAuditEvent = {
  actorUserId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  surface?: string;
  ok?: boolean;
};

type RedisLike = {
  sMembers(key: string): Promise<string[]>;
  sAdd(key: string, value: string): Promise<number>;
  sRem(key: string, value: string): Promise<number>;
  lPush(key: string, value: string): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<string>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
};

const ACCESS_KEY_PREFIX = "nobo:access";
const AUDIT_KEY = "nobo:audit-log";
const AUDIT_MAX_ITEMS = 200;

let redisOverride: RedisLike | null | undefined;

export async function evaluateNoboAccess(subject: NoboAccessSubject): Promise<NoboAccessDecision> {
  const config = await getAccessConfig();
  const userId = normalizeSlackId(subject.userId);
  const channelId = normalizeSlackId(subject.channelId);

  if (userId && config.deny.users.has(userId)) {
    return deny(`User \`${userId}\` is denied.`);
  }

  if (channelId && config.deny.channels.has(channelId)) {
    return deny(`Channel \`${channelId}\` is denied.`);
  }

  if (config.allow.users.size > 0 && (!userId || !config.allow.users.has(userId))) {
    return deny("This user is not on the NoBo allowlist.");
  }

  if (config.allow.channels.size > 0 && (!channelId || !config.allow.channels.has(channelId))) {
    return deny("This channel is not on the NoBo allowlist.");
  }

  return { allowed: true };
}

export async function isNoboAdmin(userId?: string) {
  const normalized = normalizeSlackId(userId);
  if (!normalized) {
    return false;
  }

  const config = await getAccessConfig();
  return config.adminUsers.has(normalized);
}

export async function getAccessConfig() {
  const bootstrap = getBootstrapAccessConfig();
  const redis = await getAccessRedis();

  if (!redis) {
    return bootstrap;
  }

  const [
    adminUsers,
    allowChannels,
    denyChannels,
    allowUsers,
    denyUsers
  ] = await Promise.all([
    redis.sMembers(getAccessKey("admin", "users")),
    redis.sMembers(getAccessKey("allow", "channels")),
    redis.sMembers(getAccessKey("deny", "channels")),
    redis.sMembers(getAccessKey("allow", "users")),
    redis.sMembers(getAccessKey("deny", "users"))
  ]);

  return {
    adminUsers: mergeIdSets(bootstrap.adminUsers, adminUsers),
    allow: {
      channels: mergeIdSets(bootstrap.allow.channels, allowChannels),
      users: mergeIdSets(bootstrap.allow.users, allowUsers)
    },
    deny: {
      channels: mergeIdSets(bootstrap.deny.channels, denyChannels),
      users: mergeIdSets(bootstrap.deny.users, denyUsers)
    }
  };
}

export async function updateAccessControl(input: {
  actorUserId?: string;
  mode: AccessMode;
  kind: AccessKind;
  targetId: string;
  remove?: boolean;
}) {
  const targetId = normalizeSlackId(input.targetId);
  if (!targetId) {
    return {
      ok: false as const,
      reason: "Target must be a Slack user or channel ID."
    };
  }

  const redis = await getAccessRedis();
  if (!redis) {
    return {
      ok: false as const,
      reason: "Admin updates require REDIS_URL."
    };
  }

  const key = getAccessKey(input.mode, input.kind);
  if (input.remove) {
    await redis.sRem(key, targetId);
  } else {
    await redis.sAdd(key, targetId);
  }

  const oppositeMode = input.mode === "allow" ? "deny" : "allow";
  if (!input.remove) {
    await redis.sRem(getAccessKey(oppositeMode, input.kind), targetId);
  }

  await recordNoboAuditEvent({
    actorUserId: input.actorUserId,
    action: `${input.remove ? "remove_" : ""}${input.mode}`,
    targetType: input.kind.slice(0, -1),
    targetId,
    surface: "slash-command",
    ok: true
  });

  return {
    ok: true as const,
    targetId
  };
}

export async function recordNoboAuditEvent(event: NoboAuditEvent) {
  const redis = await getAccessRedis();
  if (!redis) {
    return false;
  }

  await redis.lPush(AUDIT_KEY, JSON.stringify(normalizeAuditEvent(event)));
  await redis.lTrim(AUDIT_KEY, 0, AUDIT_MAX_ITEMS - 1);
  return true;
}

export async function listNoboAuditEvents(limit = 10) {
  const redis = await getAccessRedis();
  if (!redis) {
    return [];
  }

  const clampedLimit = Math.min(Math.max(limit, 1), 50);
  const entries = await redis.lRange(AUDIT_KEY, 0, clampedLimit - 1);
  return entries.map(parseAuditEvent).filter((event) => event !== null);
}

export function formatNoboAccessDenied(decision: NoboAccessDecision) {
  return decision.reason
    ? `NoBo access denied: ${decision.reason}`
    : "NoBo access denied.";
}

export function formatNoboAdminHelp() {
  return [
    "*NoBo admin*",
    "`/nobo-admin list`: show admins and access controls",
    "`/nobo-admin allow channel <id>`: allow a channel",
    "`/nobo-admin deny channel <id>`: deny a channel",
    "`/nobo-admin allow user <id>`: allow a user",
    "`/nobo-admin deny user <id>`: deny a user",
    "`/nobo-admin remove allow|deny channel|user <id>`: remove a rule",
    "`/nobo-admin audit [limit]`: show audit entries"
  ].join("\n");
}

export async function formatNoboAccessConfig() {
  const config = await getAccessConfig();
  return [
    "*NoBo admin controls*",
    `Admins: ${formatIdSet(config.adminUsers)}`,
    `Allowed channels: ${formatIdSet(config.allow.channels)}`,
    `Denied channels: ${formatIdSet(config.deny.channels)}`,
    `Allowed users: ${formatIdSet(config.allow.users)}`,
    `Denied users: ${formatIdSet(config.deny.users)}`
  ].join("\n");
}

export function formatNoboAuditLog(events: NoboAuditEvent[]) {
  if (events.length === 0) {
    return "No NoBo audit entries found.";
  }

  return [
    "*NoBo audit log*",
    ...events.map(formatNoboAuditEvent)
  ].join("\n");
}

function formatNoboAuditEvent(event: NoboAuditEvent) {
  const actor = event.actorUserId ? sanitizeAuditPart(event.actorUserId) : "unknown";
  const target = event.targetType && event.targetId
    ? `${sanitizeAuditPart(event.targetType)} \`${sanitizeAuditPart(event.targetId)}\``
    : "none";
  const status = event.ok === false ? "failed" : "ok";
  const at = "at" in event && typeof (event as { at?: unknown }).at === "string"
    ? sanitizeAuditPart((event as { at: string }).at)
    : "unknown-time";

  return `- ${at} actor=\`${actor}\` action=\`${sanitizeAuditPart(event.action)}\` target=${target} status=${status}`;
}

function getBootstrapAccessConfig() {
  return {
    adminUsers: parseIdSet(readEnvList("NOBO_ADMIN_USER_IDS", "NOBO_ADMIN_USERS")),
    allow: {
      channels: parseIdSet(readEnvList("NOBO_ALLOWED_CHANNEL_IDS", "NOBO_ALLOW_CHANNEL_IDS")),
      users: parseIdSet(readEnvList("NOBO_ALLOWED_USER_IDS", "NOBO_ALLOW_USER_IDS"))
    },
    deny: {
      channels: parseIdSet(readEnvList("NOBO_DENIED_CHANNEL_IDS", "NOBO_DENY_CHANNEL_IDS")),
      users: parseIdSet(readEnvList("NOBO_DENIED_USER_IDS", "NOBO_DENY_USER_IDS"))
    }
  };
}

function readEnvList(...names: string[]) {
  return names.flatMap((name) => (process.env[name] ?? "").split(","));
}

function parseIdSet(values: string[]) {
  return new Set(values.map(normalizeSlackId).filter((value): value is string => Boolean(value)));
}

function mergeIdSets(base: Set<string>, values: string[]) {
  const next = new Set(base);
  for (const value of values) {
    const normalized = normalizeSlackId(value);
    if (normalized) {
      next.add(normalized);
    }
  }
  return next;
}

function normalizeSlackId(input?: string) {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }

  const mentionMatch = trimmed.match(/^<[@#]([A-Z0-9][A-Z0-9_-]{1,80})(?:\|[^>]+)?>$/i);
  const normalized = mentionMatch?.[1] ?? trimmed.replace(/^[@#]/, "");

  return /^[A-Z0-9][A-Z0-9_-]{1,80}$/i.test(normalized) ? normalized : undefined;
}

function normalizeAuditEvent(event: NoboAuditEvent) {
  return {
    at: new Date().toISOString(),
    actorUserId: normalizeSlackId(event.actorUserId),
    action: sanitizeAuditPart(event.action),
    targetType: event.targetType ? sanitizeAuditPart(event.targetType) : undefined,
    targetId: normalizeSlackId(event.targetId),
    surface: event.surface ? sanitizeAuditPart(event.surface) : undefined,
    ok: event.ok !== false
  };
}

function parseAuditEvent(input: string) {
  try {
    const parsed = JSON.parse(input) as NoboAuditEvent;
    return normalizeStoredAuditEvent(parsed);
  } catch {
    return null;
  }
}

function normalizeStoredAuditEvent(event: NoboAuditEvent) {
  return {
    ...event,
    actorUserId: normalizeSlackId(event.actorUserId),
    action: sanitizeAuditPart(event.action),
    targetType: event.targetType ? sanitizeAuditPart(event.targetType) : undefined,
    targetId: normalizeSlackId(event.targetId),
    surface: event.surface ? sanitizeAuditPart(event.surface) : undefined,
    ok: event.ok !== false
  };
}

function sanitizeAuditPart(input: string) {
  return input
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[hidden]@")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 100);
}

function formatIdSet(ids: Set<string>) {
  return ids.size ? [...ids].sort().map((id) => `\`${id}\``).join(", ") : "none";
}

function deny(reason: string): NoboAccessDecision {
  return { allowed: false, reason };
}

function getAccessKey(mode: AccessMode | "admin", kind: AccessKind) {
  return `${ACCESS_KEY_PREFIX}:${mode}:${kind}`;
}

async function getAccessRedis(): Promise<RedisLike | null> {
  if (redisOverride !== undefined) {
    return redisOverride;
  }

  return await getRedisClient();
}

export const __testing = {
  setRedisClient(redis: RedisLike | null | undefined) {
    redisOverride = redis;
  },
  formatNoboAuditEvent,
  normalizeSlackId
};
