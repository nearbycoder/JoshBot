import type { AgentContextItem, AgentContextKind, AgentFeatureStore } from "./types.js";
import type { AgentStateBackend } from "./store.js";
import { createAgentFeatureStore, validateAgentIdentity } from "./store.js";
import { readCalendarEventContext } from "./calendar.js";
import { readApprovedMemoryContext } from "./memory-review.js";
import { LEGACY_SOURCES, readLegacyContext, type ContextOwner, type LegacyContextAdapters, type LegacyContextKind } from "./context/legacy.js";
import { civilDate, contextRead, normalizedStatus, parseContextRecord, record, sourceId, timestamp } from "./context/shared.js";

export type { ContextOwner, LegacyContextAdapters } from "./context/legacy.js";

export type AgentContextRequest = {
  now: Date;
  timezone: string;
  signal?: AbortSignal;
  /** Suppresses approved cards in memory-review's legacy import candidate reader. */
  featureId?: string;
};
export interface AgentContextAdapters extends LegacyContextAdapters {
  readCalendar?: typeof readCalendarEventContext;
  readApprovedMemory?: typeof readApprovedMemoryContext;
}

const TOOLBOX_SOURCES = [
  ["notes", "note"], ["goals", "goal"], ["habits", "habit"],
  ["journal", "journal"], ["bookmarks", "bookmark"],
] as const;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function toolboxMetadata(data: Record<string, unknown>, kind: AgentContextKind): Record<string, unknown> {
  const metadata = { ...data };
  for (const key of ["target", "current", "mood"]) {
    if (data[key] !== undefined && (typeof data[key] !== "number" || !Number.isFinite(data[key]) || data[key] < 0 || data[key] > 1_000_000_000)) {
      throw new Error("Personal context contains invalid numeric data.");
    }
  }
  if (data.completedAt !== undefined) metadata.completedAt = timestamp(data.completedAt);
  if (data.due !== undefined) metadata.due = timestamp(data.due, true);
  if (kind === "habit" && data.days !== undefined) {
    if (!Array.isArray(data.days) || data.days.length > 366 || !data.days.every(civilDate)) {
      throw new Error("Personal context contains invalid habit dates.");
    }
    metadata.days = [...new Set(data.days)].sort();
    metadata.dateBasis = "UTC calendar labels (original toolbox dates)";
  }
  if (kind === "goal" && data.history !== undefined) {
    if (!Array.isArray(data.history) || data.history.length > 366) throw new Error("Personal context contains invalid goal history.");
    metadata.history = data.history.map(checkin => {
      if (!record(checkin) || typeof checkin.value !== "number" || !Number.isFinite(checkin.value) || typeof checkin.at !== "string") {
        throw new Error("Personal context contains invalid goal history.");
      }
      return { ...checkin, at: timestamp(checkin.at) };
    });
  }
  if (kind === "journal" && data.day !== undefined && !civilDate(data.day)) throw new Error("Personal context contains an invalid journal date.");
  return metadata;
}

function bookmarkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? value : undefined;
  } catch { return undefined; }
}

/** Reads only the caller's existing private toolbox namespaces. */
export async function readAgentToolboxContext(
  backend: AgentStateBackend,
  owner: { teamId: string; userId: string },
  kinds?: AgentContextKind[],
  signal?: AbortSignal,
): Promise<AgentContextItem[]> {
  validateAgentIdentity(owner);
  signal?.throwIfAborted();
  const items: AgentContextItem[] = [];
  for (const [tool, kind] of TOOLBOX_SOURCES.filter(([, kind]) => !kinds || kinds.includes(kind))) {
    const raw = await contextRead(signal, () => backend.get(`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:${tool}`));
    if (raw === null) continue;
    const state = parseContextRecord(raw, 2_000_000);
    if (!Array.isArray(state.entries) || state.entries.length > 100) throw new Error("Personal context contains unsupported data.");
    const seen = new Set<string>();
    for (const entry of state.entries) {
      if (!record(entry) || typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.body !== "string" || !record(entry.data)) {
        throw new Error("Personal context contains an invalid entry.");
      }
      if ((entry.teamId !== undefined && entry.teamId !== owner.teamId) ||
          (entry.userId !== undefined && entry.userId !== owner.userId) ||
          (entry.ownerUserId !== undefined && entry.ownerUserId !== owner.userId)) continue;
      const id = sourceId(`toolbox:${tool}`, entry.id);
      if (seen.has(id)) throw new Error("Personal context contains duplicate source IDs.");
      seen.add(id);
      const data = toolboxMetadata(entry.data, kind);
      const dueAt = timestamp(data.due, true);
      const sourceUrl = kind === "bookmark" ? bookmarkUrl(data.url) : undefined;
      let status = normalizedStatus(entry.status ?? data.status);
      // A reached numeric target is current state, not a dated completion event.
      if (!status && kind === "goal" && typeof data.target === "number" && data.target > 0 && typeof data.current === "number") {
        status = data.current >= data.target ? "done" : "open";
      }
      const fullText = [entry.body, JSON.stringify(data)].filter(Boolean).join("\n");
      items.push({
        id, kind,
        title: entry.title.slice(0, 300),
        text: fullText.slice(0, 12_000),
        updatedAt: timestamp(entry.updatedAt), dueAt, sourceUrl, status,
        metadata: { ...data, createdAt: timestamp(entry.createdAt), source: `Personal toolbox / ${tool}`,
          textTruncated: fullText.length > 12_000, titleTruncated: entry.title.length > 300 },
      });
    }
  }
  return items.sort((a, b) => compareText(b.updatedAt ?? "", a.updatedAt ?? "") || compareText(a.id, b.id));
}

/** No adapter can mutate a sibling feature namespace, even if miswired. */
function readOnlyStore(backend: AgentStateBackend, owner: ContextOwner, feature: string, signal?: AbortSignal): AgentFeatureStore {
  const store = createAgentFeatureStore(backend, owner, feature, signal);
  return {
    read: key => contextRead(signal, () => store.read(key)),
    update: async () => { throw new Error("Personal source adapters are read-only."); },
  };
}

/** Complete within documented source bounds; errors never become empty sources. */
export async function readAgentOwnedContext(
  backend: AgentStateBackend, owner: ContextOwner, request: AgentContextRequest,
  adapters: AgentContextAdapters, kinds?: AgentContextKind[],
): Promise<AgentContextItem[]> {
  validateAgentIdentity(owner);
  const { signal, now, timezone } = request;
  signal?.throwIfAborted();
  if (!Number.isFinite(now.getTime())) throw new Error("Personal context needs a valid request time.");
  if (typeof timezone !== "string" || !timezone.trim()) throw new Error("Personal context needs the caller's timezone.");
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const wants = (kind: AgentContextKind) => !kinds || kinds.includes(kind);
  const read = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    try { return await contextRead(signal, work); }
    catch (cause) {
      signal?.throwIfAborted();
      throw new Error(`Personal context source ${label} could not be read completely. Retry after checking that source.`, { cause });
    }
  };
  const items: AgentContextItem[] = [];
  if (wants("event")) {
    const events = await read("calendar", () => (adapters.readCalendar ?? readCalendarEventContext)(readOnlyStore(backend, owner, "calendar", signal), timezone));
    // Never truncate calendar ranges: missing busy intervals would claim false availability.
    if (!Array.isArray(events) || events.length > 100 || events.some(item => item.kind !== "event")) throw new Error("Personal calendar context is not a complete bounded event list.");
    items.push(...events);
  }
  items.push(...await read("toolbox", () => readAgentToolboxContext(backend, owner, kinds, signal)));
  const legacyKinds = (Object.keys(LEGACY_SOURCES) as LegacyContextKind[]).filter(wants);
  if (legacyKinds.length) items.push(...await read("legacy owner/current-channel records", () => readLegacyContext(backend, owner, legacyKinds, adapters, signal)));
  // Legacy user memory has no workspace/channel provenance and is deliberately
  // excluded. Do not recursively offer approved cards as legacy import candidates.
  if (wants("memory") && request.featureId !== "memory-review") {
    const memories = await read("approved memory", () => (adapters.readApprovedMemory ?? readApprovedMemoryContext)({
      store: readOnlyStore(backend, owner, "memory-review", signal), now, timezone,
    }));
    if (!Array.isArray(memories) || memories.length > 100 || memories.some(item => item.kind !== "memory")) throw new Error("Approved memory context is not a bounded memory list.");
    items.push(...memories);
  }
  // Legacy artifacts have no workspace/channel provenance or bounded owner index.
  // No filesystem enumeration, arbitrary paths, or URL fetches are permitted here.
  signal?.throwIfAborted();
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error("Personal context contains duplicate source IDs.");
    ids.add(item.id);
  }
  // Events first (complete chronological agenda), then due commitments/jobs, then
  // recent undated evidence. All ties are stable and independent of index order.
  return items.sort((a, b) => Number(b.kind === "event") - Number(a.kind === "event") ||
    compareText(a.dueAt ?? "~", b.dueAt ?? "~") || compareText(b.updatedAt ?? "", a.updatedAt ?? "") || compareText(a.id, b.id));
}
