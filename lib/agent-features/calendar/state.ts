import type { AgentFeatureStore } from "../types.js";
import { eventId, MAX_EVENTS, type CalendarEvent } from "./ics.js";
import { CalendarError, date, timezone } from "./time.js";

export const STATE_KEY = "calendar-v1";
export const PREVIEW_TTL_MS = 30 * 60_000;

export type CalendarPreview = {
  id: string;
  createdAt: string;
  expiresAt: string;
  baseRevision: number;
  events: CalendarEvent[];
};
export type CalendarState = {
  version: 1;
  revision: number;
  events: CalendarEvent[];
  pending: CalendarPreview | null;
};

export function emptyState(): CalendarState {
  return { version: 1, revision: 0, events: [], pending: null };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function string(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function iso(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function event(value: unknown): value is CalendarEvent {
  if (!record(value) || !string(value.uid, 512) || !value.uid.trim() ||
      value.id !== eventId(value.uid) || !string(value.title, 160) || !value.title.trim() ||
      !string(value.location, 160) || typeof value.busy !== "boolean" || !iso(value.updatedAt)) return false;
  const base = ["id", "uid", "title", "location", "busy", "updatedAt", "allDay"];
  if (value.allDay === true) {
    return keys(value, [...base, "startDate", "endDate"]) &&
      typeof value.startDate === "string" && typeof value.endDate === "string" &&
      date(value.startDate) < date(value.endDate);
  }
  return value.allDay === false && keys(value, [...base, "startAt", "endAt", "timezone"]) &&
    iso(value.startAt) && iso(value.endAt) && date(value.startAt.slice(0, 10)) <= date(value.endAt.slice(0, 10)) &&
    value.endAt >= value.startAt && typeof value.timezone === "string" && !!timezone(value.timezone);
}

function events(value: unknown, nonempty = false): value is CalendarEvent[] {
  if (!Array.isArray(value) || value.length > MAX_EVENTS || (nonempty && !value.length) || !value.every(event)) return false;
  return new Set(value.map(item => item.id)).size === value.length && new Set(value.map(item => item.uid)).size === value.length;
}

/** Fail closed on invalid data. Never silently discard records during a mutation. */
export function validateState(raw: unknown): CalendarState {
  try {
    if (!record(raw) || !keys(raw, ["version", "revision", "events", "pending"]) ||
        raw.version !== 1 || !revision(raw.revision) || !events(raw.events)) throw new Error("shape");
    if (raw.pending !== null) {
      const pending = raw.pending;
      if (!record(pending) || !keys(pending, ["id", "createdAt", "expiresAt", "baseRevision", "events"]) ||
          typeof pending.id !== "string" || !/^[a-f0-9]{32}$/.test(pending.id) ||
          !iso(pending.createdAt) || !iso(pending.expiresAt) ||
          Date.parse(pending.expiresAt) - Date.parse(pending.createdAt) !== PREVIEW_TTL_MS ||
          !revision(pending.baseRevision) || pending.baseRevision !== raw.revision || !events(pending.events, true)) {
        throw new Error("preview");
      }
    }
    return raw as unknown as CalendarState;
  } catch {
    throw new CalendarError("Saved calendar data is invalid; it was left unchanged. Ask for storage recovery, or use clear confirm to discard this private calendar and its preview.");
  }
}

export async function readState(store: AgentFeatureStore): Promise<CalendarState> {
  const raw = await store.read<unknown>(STATE_KEY);
  return raw === null ? emptyState() : validateState(raw);
}

export function nextRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new CalendarError("Calendar revision limit reached. Keep your original ICS and use clear confirm before importing again.");
  return current + 1;
}

function sameEvent(first: CalendarEvent, second: CalendarEvent): boolean {
  if (first.uid !== second.uid || first.title !== second.title || first.location !== second.location ||
      first.busy !== second.busy || first.allDay !== second.allDay) return false;
  if (first.allDay && second.allDay) return first.startDate === second.startDate && first.endDate === second.endDate;
  return !first.allDay && !second.allDay && first.startAt === second.startAt && first.endAt === second.endAt && first.timezone === second.timezone;
}

/** UID-based upsert: importing a subset never deletes other events. */
export function mergeEvents(existing: CalendarEvent[], incoming: CalendarEvent[], updatedAt: string): {
  events: CalendarEvent[]; added: number; changed: number; unchanged: number;
} {
  const merged = new Map(existing.map(item => [item.id, item]));
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const candidate of incoming) {
    const previous = merged.get(candidate.id);
    if (previous && previous.uid !== candidate.uid) throw new CalendarError("Event identifier collision. Nothing was imported.");
    if (previous && sameEvent(previous, candidate)) { unchanged++; continue; }
    if (previous) changed++; else added++;
    merged.set(candidate.id, { ...candidate, updatedAt });
  }
  if (merged.size > MAX_EVENTS) throw new CalendarError(`Calendar capacity is ${MAX_EVENTS} saved events. Remove old events before importing these additions.`);
  return { events: [...merged.values()], added, changed, unchanged };
}
