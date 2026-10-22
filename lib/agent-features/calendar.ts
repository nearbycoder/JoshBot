import { randomUUID } from "node:crypto";
import type { AgentContextItem, AgentFeature, AgentFeatureContext, AgentFeatureStore } from "./types.js";
import { MAX_EVENTS, parseCalendar, type CalendarEvent } from "./calendar/ics.js";
import {
  boundedState, emptyState, MAX_CONFIRMED_STATE_BYTES, MAX_IMPORT_STATE_BYTES,
  mergeEvents, nextRevision, PREVIEW_TTL_MS, readState, STATE_KEY, stateBytes, validateState,
  type CalendarPreview, type CalendarState,
} from "./calendar/state.js";
import { CalendarError, date, dayBounds, displayInstant, localInstant, timezone } from "./calendar/time.js";

export type { CalendarEvent } from "./calendar/ics.js";

const HELP = `Private calendar import and availability
/nobo-help agent calendar import preview <pasted BEGIN:VCALENDAR … END:VCALENDAR>
import confirm <preview-token> — apply the reviewed UID-based additions/updates
import cancel <preview-token> — discard a pending preview
list — saved events and removal IDs
agenda YYYY-MM-DD — events touching that local date
free YYYY-MM-DD | <minutes, 30m, or 1h> — free windows across the whole local day
conflicts — overlapping busy events (at most 20 pairs shown)
remove <event-id> confirm — delete one event
clear confirm — delete all events and any preview
Example: /nobo-help agent calendar free 2026-10-23 | 45m
Paste ICS directly; URLs are never fetched. Max 100 saved events, 64 KiB/import, one preview (expires in 30 minutes).
The whole feature command must fit 48,000 characters. UTF-8 JSON quotas: 432,000 bytes confirmed, 464,000 with preview; additional lifecycle space is reserved below 480,000 bytes.
At quota, keep the original ICS; use list then remove <event-id> confirm, import cancel <preview-token>, or clear confirm. Smaller imports and shorter text also help.
UTC and IANA TZID times are supported. Floating times use your supplied timezone at import; all-day dates use your viewing timezone.
Recurrence, DURATION, VTIMEZONE, VALARM, calendar timezone overrides, and DST-ambiguous/nonexistent local times are rejected. Use explicit UTC/DTEND or individual events.
Only this private imported snapshot is checked; availability is not a booking or a live-calendar guarantee.`;

type Interval = { event: CalendarEvent; start: number; end: number };

function safe(value: string, limit = 72): string {
  let result = "";
  for (const character of value) {
    const escaped = character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character;
    if (result.length + escaped.length > limit - 1) return `${result}…`;
    result += escaped;
  }
  return result;
}

function interval(event: CalendarEvent, zone: string): Interval {
  return event.allDay
    ? { event, start: localInstant(event.startDate, "00:00:00", zone), end: localInstant(event.endDate, "00:00:00", zone) }
    : { event, start: Date.parse(event.startAt), end: Date.parse(event.endAt) };
}

function intervals(events: CalendarEvent[], zone: string): Interval[] {
  return events.map(event => interval(event, zone))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.event.id.localeCompare(b.event.id));
}

function range(item: Interval, zone: string): string {
  if (item.event.allDay) return `all day ${item.event.startDate} → ${item.event.endDate} (exclusive end)`;
  if (item.start === item.end) return `${displayInstant(item.start, zone)} (no duration; does not block)`;
  return `${displayInstant(item.start, zone)} → ${displayInstant(item.end, zone)}`;
}

function row(item: Interval, zone: string): string {
  return `${item.event.id} | ${safe(item.event.title)} | ${range(item, zone)}${item.event.busy ? "" : " | free/transparent"}`;
}

function now(context: AgentFeatureContext): string {
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
    throw new CalendarError("A valid request timestamp is required; no time was guessed.");
  }
  const timestamp = context.now.toISOString();
  date(timestamp.slice(0, 10));
  return timestamp;
}

function previewMessage(preview: CalendarPreview, current: CalendarEvent[], zone: string): string {
  const changes = mergeEvents(current, preview.events, preview.createdAt);
  // Titles are deliberately shorter here so even 100 events with escaped text fit Slack.
  const lines = intervals(preview.events, zone).map(item =>
    `${item.event.id} | ${safe(item.event.title, 40)} | ${range(item, zone)}${item.event.busy ? "" : " | transparent"}`);
  return [
    `Import preview (${zone}): ${changes.added} new, ${changes.changed} changed, ${changes.unchanged} unchanged; ${changes.events.length}/${MAX_EVENTS} saved after confirmation.`,
    "Existing events absent from this paste are retained. Floating times were resolved in your supplied timezone. All-day end dates are exclusive.",
    ...lines,
    `Storage including preview: ${stateBytes({ version: 1, revision: preview.baseRevision, events: current, pending: preview })}/${MAX_IMPORT_STATE_BYTES} UTF-8 JSON bytes.`,
    `Confirm within 30 minutes: import confirm ${preview.id}`,
    `Discard: import cancel ${preview.id}`,
    "Only the latest preview can be confirmed. No saved events have changed.",
  ].join("\n");
}

async function stage(raw: string, context: AgentFeatureContext): Promise<string> {
  const zone = timezone(context.timezone);
  const createdAt = now(context);
  const parsed = parseCalendar(raw, zone, createdAt);
  // Resolve all-day boundaries now too: do not stage an import that cannot be displayed safely.
  intervals(parsed, zone);
  const id = randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.parse(createdAt) + PREVIEW_TTL_MS).toISOString();
  const result = await context.store.update<CalendarState, { preview: CalendarPreview; existing: CalendarEvent[] }>(
    STATE_KEY, emptyState(), rawState => {
      const current = validateState(rawState);
      const merged = mergeEvents(current.events, parsed, createdAt);
      // Admit only previews whose eventual confirmation also fits. Reserving
      // stable-state space permits another single-event preview near capacity.
      boundedState({ version: 1, revision: nextRevision(current.revision), events: merged.events, pending: null }, MAX_CONFIRMED_STATE_BYTES);
      const pending: CalendarPreview = { id, createdAt, expiresAt, baseRevision: current.revision, events: parsed };
      return { value: boundedState({ ...current, pending }, MAX_IMPORT_STATE_BYTES), result: { preview: pending, existing: current.events } };
    },
  );
  return previewMessage(result.preview, result.existing, zone);
}

async function confirm(token: string, context: AgentFeatureContext): Promise<string> {
  const confirmedAt = now(context);
  return context.store.update<CalendarState, string>(STATE_KEY, emptyState(), rawState => {
    const current = validateState(rawState);
    const pending = current.pending;
    if (!pending || pending.id !== token) throw new CalendarError("That preview is no longer current. Paste the ICS again to review a new preview; no events were changed.");
    if (Date.parse(confirmedAt) >= Date.parse(pending.expiresAt) || confirmedAt < pending.createdAt) {
      throw new CalendarError("That preview has expired or its request timestamp is invalid. Paste the ICS again; no events were changed.");
    }
    // The revision guard remains explicit even though shape validation also checks it.
    if (pending.baseRevision !== current.revision) throw new CalendarError("Calendar changed since preview. Paste the ICS again.");
    const merged = mergeEvents(current.events, pending.events, confirmedAt);
    return {
      value: boundedState({ version: 1, revision: nextRevision(current.revision), events: merged.events, pending: null }, MAX_CONFIRMED_STATE_BYTES),
      result: `Imported: ${merged.added} new, ${merged.changed} changed, ${merged.unchanged} unchanged. ${merged.events.length}/${MAX_EVENTS} saved events. Try list, agenda YYYY-MM-DD, or conflicts.`,
    };
  });
}

async function cancel(token: string, context: AgentFeatureContext): Promise<string> {
  return context.store.update<CalendarState, string>(STATE_KEY, emptyState(), rawState => {
    const current = validateState(rawState);
    if (current.pending?.id !== token) throw new CalendarError("That preview is no longer current. Saved events were left unchanged.");
    return { value: boundedState({ ...current, pending: null }), result: "Import preview discarded. Saved events were left unchanged." };
  });
}

function parseDuration(value: string): number {
  const match = /^(\d{1,4})(m|h)?$/.exec(value);
  const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : 0;
  if (!minutes || minutes > 1440) throw new CalendarError("Duration must be 1–1,440 whole minutes, for example 45, 45m, or 2h.");
  return minutes;
}

function touches(item: Interval, start: number, end: number): boolean {
  return item.start === item.end ? item.start >= start && item.start < end : item.start < end && item.end > start;
}

async function agenda(day: string, context: AgentFeatureContext): Promise<string> {
  const zone = timezone(context.timezone);
  const bounds = dayBounds(date(day), zone);
  const state = await readState(context.store);
  const matches = intervals(state.events, zone).filter(item => touches(item, bounds.start, bounds.end));
  return [`Agenda ${day} (${zone}) — ${matches.length} imported event(s).`,
    ...matches.map(item => row(item, zone)),
    ...(matches.length ? [] : ["No imported events on this date. Use import preview <ICS> to add your calendar snapshot."]),
  ].join("\n");
}

async function free(day: string, duration: string, context: AgentFeatureContext): Promise<string> {
  const minutes = parseDuration(duration);
  const zone = timezone(context.timezone);
  const bounds = dayBounds(date(day), zone);
  const state = await readState(context.store);
  const busy = intervals(state.events, zone).filter(item => item.event.busy && item.start < item.end && touches(item, bounds.start, bounds.end));
  const windows: { start: number; end: number }[] = [];
  let cursor = bounds.start;
  for (const item of busy) {
    const start = Math.max(bounds.start, item.start);
    const end = Math.min(bounds.end, item.end);
    if (start - cursor >= minutes * 60_000) windows.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (bounds.end - cursor >= minutes * 60_000) windows.push({ start: cursor, end: bounds.end });
  return [
    `Free windows ≥ ${minutes} minutes on ${day} (${zone}; whole local day, ${(bounds.end - bounds.start) / 3_600_000} elapsed hours).`,
    ...windows.map(window => `${displayInstant(window.start, zone)} → ${displayInstant(window.end, zone)} (${Math.floor((window.end - window.start) / 60_000)} minutes)`),
    ...(!windows.length ? ["No matching free window in the imported calendar."] : []),
    ...(!state.events.length ? ["No saved events yet; this day is unchecked against your real calendar. Paste ICS with import preview <ICS>."] : []),
    "Based only on imported busy events; transparent/zero-duration events do not block. These windows are not bookings.",
  ].join("\n");
}

async function conflicts(context: AgentFeatureContext): Promise<string> {
  const zone = timezone(context.timezone);
  const state = await readState(context.store);
  const busy = intervals(state.events, zone).filter(item => item.event.busy && item.start < item.end);
  const lines: string[] = [];
  let count = 0;
  for (let i = 0; i < busy.length; i++) {
    for (let j = i + 1; j < busy.length && busy[j].start < busy[i].end; j++) {
      count++;
      if (lines.length < 20) lines.push(
        `${busy[i].event.id} (${safe(busy[i].event.title, 40)}) overlaps ${busy[j].event.id} (${safe(busy[j].event.title, 40)}): ${displayInstant(Math.max(busy[i].start, busy[j].start), zone)} → ${displayInstant(Math.min(busy[i].end, busy[j].end), zone)}`,
      );
    }
  }
  return [
    `Conflicts (${zone}): ${count} overlapping busy pair(s).`, ...lines,
    ...(count > 20 ? [`Showing 20 of ${count}; use agenda YYYY-MM-DD to inspect a day.`] : []),
    ...(!count ? [state.events.length ? "No busy overlaps in the imported snapshot. Adjacent events do not conflict." : "No saved events. Start with import preview <ICS>."] : []),
  ].join("\n");
}

async function remove(id: string, context: AgentFeatureContext): Promise<string> {
  return context.store.update<CalendarState, string>(STATE_KEY, emptyState(), rawState => {
    const current = validateState(rawState);
    const events = current.events.filter(event => event.id !== id);
    if (events.length === current.events.length) throw new CalendarError("Event not found. Use list for current event IDs; nothing was removed.");
    return {
      value: boundedState({ version: 1, revision: nextRevision(current.revision), events, pending: null }),
      result: `Removed ${id}. ${events.length} events remain.${current.pending ? " Pending import preview discarded; paste it again if still needed." : ""}`,
    };
  });
}

async function clear(context: AgentFeatureContext): Promise<string> {
  // Explicit clear is also the recovery path for invalid persisted state.
  return context.store.update<CalendarState, string>(STATE_KEY, emptyState(), () => ({
    value: boundedState(emptyState()), result: "Cleared all saved calendar events and the pending import preview.",
  }));
}

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  try {
    context.signal?.throwIfAborted();
    if (typeof command !== "string" || command.length > 48_000) throw new CalendarError("Command is too large. Use at most 48,000 characters including the import command, and at most 64 KiB of pasted ICS.");
    const input = command.trim();
    if (!input || input === "help") return HELP;
    const confirmation = /^import (confirm|cancel) ([a-f0-9]{32})$/.exec(input);
    if (confirmation) return await (confirmation[1] === "confirm" ? confirm(confirmation[2], context) : cancel(confirmation[2], context));
    if (/^import\s+(?:confirm|cancel)\b/.test(input)) throw new CalendarError("Use import confirm <preview-token> or import cancel <preview-token>, copying the token from the latest preview.");
    const importing = /^import(?:\s+preview)?\s+([\s\S]+)$/.exec(input);
    if (importing) return await stage(importing[1], context);
    if (input === "list") {
      const zone = timezone(context.timezone);
      const state = await readState(context.store);
      return [`Saved calendar: ${state.events.length}/${MAX_EVENTS} events (${zone}).`,
        `Storage: ${stateBytes(state)} UTF-8 JSON bytes; confirmed import budget ${MAX_CONFIRMED_STATE_BYTES}, preview budget ${MAX_IMPORT_STATE_BYTES}. At quota, cancel the preview or remove old events with confirmation.`,
        ...intervals(state.events, zone).map(item => `${item.event.id} | ${safe(item.event.title, 40)} | ${range(item, zone)}${item.event.busy ? "" : " | transparent"}`),
        ...(!state.events.length ? ["No saved events. Paste a calendar using import preview <ICS>, then import confirm <preview-token>."] : []),
        ...(state.pending ? [`Pending preview ${state.pending.id}; expires ${state.pending.expiresAt}. It is not included in saved events.`] : []),
      ].join("\n");
    }
    const agendaMatch = /^agenda (\S+)$/.exec(input);
    if (agendaMatch) return await agenda(agendaMatch[1], context);
    const freeMatch = /^free\s+(\S+)\s*\|\s*(\S+)$/.exec(input);
    if (freeMatch) return await free(freeMatch[1], freeMatch[2], context);
    if (input === "conflicts") return await conflicts(context);
    const removeMatch = /^remove (cal_[a-f0-9]{24}) confirm$/.exec(input);
    if (removeMatch) return await remove(removeMatch[1], context);
    if (input === "clear confirm") return await clear(context);
    if (input === "clear") return "Delete this private calendar and its preview with: clear confirm";
    if (input.startsWith("remove")) return "Use list to find the event ID, then remove <event-id> confirm. No event was removed.";
    throw new CalendarError("Unknown or incomplete command. Use help for import, list, agenda YYYY-MM-DD, free YYYY-MM-DD | 45m, conflicts, remove, and clear.");
  } catch (error) {
    // Parent runtime owns prompt cancellation and guarded CAS writes. Preserve
    // its abort reason instead of reporting cancellation as a storage failure.
    context.signal?.throwIfAborted();
    if (error instanceof CalendarError) return `Calendar: ${error.message}`;
    return "Calendar storage is unavailable. Retry the command; no successful change was confirmed.";
  }
}

/**
 * Parent-only adapter: supply the *calendar*-scoped store for the authenticated
 * workspace/user, even when serving another feature's readContext(["event"]).
 * Throws on invalid/unavailable data; do not turn these errors into 'no events'.
 * Only confirmed events are exposed. metadata.startAt/endAt are half-open ISO
 * intervals; all-day dates are interpreted in the supplied viewing timezone.
 * Titles, locations, and UIDs remain untrusted user data, never instructions.
 */
export async function readCalendarEventContext(store: AgentFeatureStore, suppliedTimezone: string): Promise<AgentContextItem[]> {
  const zone = timezone(suppliedTimezone);
  const state = await readState(store);
  return intervals(state.events, zone).map(item => ({
    id: `calendar:${item.event.id}`, kind: "event", title: item.event.title,
    text: `${range(item, zone)}${item.event.location ? `; location: ${item.event.location}` : ""}; ${item.event.busy ? "busy" : "free/transparent"}. Imported calendar snapshot.`,
    updatedAt: item.event.updatedAt, dueAt: new Date(item.start).toISOString(),
    status: item.event.busy ? "busy" : "free",
    metadata: {
      source: "calendar", calendarEventId: item.event.id, uid: item.event.uid,
      startAt: new Date(item.start).toISOString(), endAt: new Date(item.end).toISOString(),
      allDay: item.event.allDay, busy: item.event.busy, location: item.event.location,
      timezone: item.event.allDay ? zone : item.event.timezone,
      ...(item.event.allDay ? { startDate: item.event.startDate, endDate: item.event.endDate } : {}),
    },
  }));
}

export const feature: AgentFeature = {
  id: "calendar",
  title: "Calendar import and availability",
  description: "Privately preview pasted ICS, inspect your agenda, and find free time or conflicts in imported events.",
  help: HELP,
  execute,
};

export default feature;
