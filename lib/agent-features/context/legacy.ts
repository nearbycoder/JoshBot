import type { AgentContextItem } from "../types.js";
import type { AgentStateBackend } from "../store.js";
import { contextRead, normalizedStatus, parseContextRecord, sourceId, text, timestamp } from "./shared.js";

export type ContextOwner = { teamId: string; userId: string; channelId?: string };
export type LegacyContextKind = "follow-up" | "reminder" | "monitor" | "digest";
export const LEGACY_INDEX_LIMIT = 200;
export const LEGACY_SOURCES = {
  "follow-up": { index: "follow-ups:user:", record: "follow-ups:record:" },
  reminder: { index: "schedules:user:", record: "schedules:job:" },
  monitor: { index: "monitors:user:", record: "monitors:job:" },
  digest: { index: "channel-digests:user:", record: "channel-digests:subscription:" },
} as const;

export interface LegacyContextAdapters {
  /** Must reject oversized indexes, never return a silently truncated subset. */
  readOwnerIndex(key: string, limit: number, signal?: AbortSignal): Promise<unknown>;
  /** Read-only access policy check; do not probe Slack or log an audit mutation. */
  authorizeChannel(owner: ContextOwner, signal?: AbortSignal): Promise<void>;
}

function scheduleLabel(value: Record<string, unknown>, kind: LegacyContextKind): string | undefined {
  const cadence = kind === "digest" ? value.frequency : value.kind;
  if (cadence === "once") return "once";
  if (cadence === "interval") {
    return typeof value.intervalMs === "number" && Number.isSafeInteger(value.intervalMs) && value.intervalMs > 0
      ? `every ${value.intervalMs} ms` : undefined;
  }
  const hour = value.hour, minute = value.minute, weekday = value.weekday;
  if (!Number.isInteger(hour) || Number(hour) < 0 || Number(hour) > 23 ||
      !Number.isInteger(minute) || Number(minute) < 0 || Number(minute) > 59) return undefined;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (cadence === "daily") return `daily ${time}`;
  if (cadence === "weekly" && Number.isInteger(weekday) && Number(weekday) >= 0 && Number(weekday) <= 6) {
    return `weekly ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(weekday)]} ${time}`;
  }
  return undefined;
}

function scheduleTimezone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Personal context contains an invalid schedule timezone.");
  new Intl.DateTimeFormat("en", { timeZone: value });
  return value;
}

function owned(value: Record<string, unknown>, owner: ContextOwner, kind: LegacyContextKind): boolean {
  // Even a matching optional teamId does not broaden legacy reads beyond the
  // signed current channel. A mismatching/invalid teamId never gets the fallback.
  if (value.teamId !== undefined && value.teamId !== owner.teamId) return false;
  if (value.channel !== owner.channelId) return false;
  return kind === "follow-up"
    ? value.createdByUserId === owner.userId || value.assigneeUserId === owner.userId
    : value.ownerUserId === owner.userId;
}

function mapLegacy(kind: LegacyContextKind, value: Record<string, unknown>): AgentContextItem {
  const id = sourceId(kind, value.id);
  const createdAt = timestamp(value.createdAt);
  if (kind === "follow-up") {
    const task = text(value.task);
    if (!task.trim()) throw new Error("Personal follow-up contains an empty task.");
    const completedAt = timestamp(value.completedAt);
    const dates = [createdAt, completedAt, timestamp(value.updatedAt)].filter((at): at is string => !!at).sort();
    return {
      id, kind, title: task.slice(0, 300), text: task,
      updatedAt: dates.at(-1), dueAt: timestamp(value.dueAt, true), status: normalizedStatus(value.status),
      metadata: { source: "Personal follow-ups", coverage: "owner/current-channel", channelId: value.channel,
        createdAt, completedAt,
        assigneeUserId: typeof value.assigneeUserId === "string" ? value.assigneeUserId : undefined,
        scheduleId: typeof value.scheduleId === "string" ? value.scheduleId : undefined },
    };
  }
  const purpose = text(kind === "reminder" ? value.task : kind === "monitor" ? value.query : value.focus);
  if (kind !== "digest" && !purpose.trim()) throw new Error("Personal automation contains an empty purpose.");
  const nextRunAt = timestamp(value.nextRunAt);
  const lastCheckedAt = kind === "monitor" ? timestamp(value.lastCheckedAt) : undefined;
  const rawStatus = normalizedStatus(value.status) ?? "active";
  const status = ["active", "paused", "disabled", "completed", "cancelled", "unknown"].includes(rawStatus) ? rawStatus : "unknown";
  const cadence = kind === "digest" ? value.frequency : value.kind;
  // Live legacy job records are active; completed/cancelled jobs are removed.
  // Neither creation nor a changed next occurrence is evidence of a last run.
  return {
    id, kind, title: purpose.slice(0, 300) || (kind === "digest" ? "Channel digest" : `Personal ${kind}`), text: purpose,
    status, updatedAt: timestamp(value.updatedAt), dueAt: nextRunAt,
    metadata: {
      source: `Personal ${kind}`, coverage: "owner/current-channel", channelId: value.channel,
      purpose, createdAt, nextRunAt, schedule: scheduleLabel(value, kind), timezone: scheduleTimezone(value.timezone),
      destination: `current channel ${value.channel}`,
      cadence: typeof cadence === "string" && ["once", "interval", "daily", "weekly"].includes(cadence) ? cadence : undefined,
      ...(typeof value.intervalMs === "number" && Number.isSafeInteger(value.intervalMs) && value.intervalMs > 0 ? { intervalMs: value.intervalMs } : {}),
      ...(kind === "monitor" ? {
        monitorSource: typeof value.source === "string" && ["channel_history", "web_search", "prompt"].includes(value.source) ? value.source : undefined,
        conditionType: typeof value.conditionType === "string" && ["appears", "changes", "fails"].includes(value.conditionType) ? value.conditionType : undefined,
        lastCheckedAt, lastRunAt: lastCheckedAt, lastRunMeaning: "monitor check; delivery outcome unknown" } : {}),
    },
  };
}

/** Bounded owner indexes only. No shared channel history/memory or due-job scans. */
export async function readLegacyContext(
  backend: AgentStateBackend, owner: ContextOwner, kinds: LegacyContextKind[],
  adapters: LegacyContextAdapters, signal?: AbortSignal,
): Promise<AgentContextItem[]> {
  if (!kinds.length || !owner.channelId) return [];
  if (!/^[CGD][A-Z0-9]{1,31}$/.test(owner.channelId)) throw new Error("Personal context needs a signed current channel ID.");
  await contextRead(signal, () => adapters.authorizeChannel(owner, signal));
  const items: AgentContextItem[] = [];
  for (const kind of kinds) {
    const source = LEGACY_SOURCES[kind];
    const ids = await contextRead(signal, () => adapters.readOwnerIndex(`${source.index}${owner.userId}`, LEGACY_INDEX_LIMIT, signal));
    if (!Array.isArray(ids) || ids.length > LEGACY_INDEX_LIMIT || new Set(ids).size !== ids.length) {
      throw new Error(`Personal ${kind} index is invalid or too large to read completely (limit ${LEGACY_INDEX_LIMIT}).`);
    }
    for (const id of ids) sourceId(kind, id); // Validate every ID before constructing any record keys.
    for (const id of (ids as string[]).sort()) {
      const raw = await contextRead(signal, () => backend.get(`${source.record}${id}`));
      if (raw === null) continue; // Stale owner-index member: source was deleted.
      const value = parseContextRecord(raw, 64_000);
      if (!owned(value, owner, kind)) continue;
      if (value.id !== id) throw new Error(`Personal ${kind} source ID does not match its indexed record.`);
      items.push(mapLegacy(kind, value));
    }
  }
  return items;
}
