import { randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";

const KEY = "itineraries";
const LIMIT = { trips: 10, entries: 40, packing: 40, title: 100, note: 300, constraints: 800 };
type Moment = { at: string; zone: string };
type Entry = {
  id: string;
  kind: "leg" | "stay" | "activity";
  title: string;
  from: string;
  to: string;
  start: Moment;
  end: Moment;
  note: string;
};
type PackingItem = { id: string; label: string; packed: boolean };
type Trip = {
  id: string;
  title: string;
  zone: string;
  minTransfer: number;
  constraints: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  entries: Entry[];
  packing: PackingItem[];
};
type State = { version: 1; trips: Trip[] };
class InputError extends Error {}
class SavedDataError extends Error {}

const HELP = `Travel — private, user-entered itineraries. Prefix commands with /nobo-help agent travel.
trip <title> | <IANA home zone> [| <minimum transfer minutes> | <constraints>]
trip / show — list trips (including archived)
trip constraints <trip-id> | <minimum transfer minutes> | <constraints or ->
trip remove-entry <trip-id> | <entry-id>
trip delete <trip-id> confirm
add-leg <trip-id> | <title> | <from> | <to> | <departure> | <departure IANA zone> | <arrival> | <arrival IANA zone> [| <confirmation note>]
add-stay <trip-id> | <title> | <location> | <check-in> | <IANA zone> | <check-out> [| <confirmation note>]
add-activity <trip-id> | <title> | <location> | <start> | <IANA zone> | <end> [| <confirmation note>]
timeline <trip-id> / check <trip-id> / show <trip-id> [brief]
packing <trip-id> [add | <item> | <item> ...]
packing <trip-id> done|undo|remove <packing-id>
archive <trip-id> [undo]
Example: trip Japan visit | America/Chicago | 90 | Carry-on only
Example date: 2026-11-02T09:00-06:00 with America/Chicago. Dates require an explicit offset (or Z) matching the named zone; repeated DST times are disambiguated by the offset.
Use consistent location labels (e.g. HND). Confirmation notes are reminders only: no passwords, access codes, passport/payment details, or booking reference secrets. No bookings or verification. Limits: 10 trips, 40 entries and 40 packing items per trip.`;

function clean(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new InputError(`${label} must be ${empty ? "at most " : "1–"}${max} characters of text.`);
  }
  return value.trim();
}

function confirmationNote(value: unknown): string {
  const note = clean(value, LIMIT.note, "Confirmation note", true);
  // Catch obvious pasted credentials without claiming to recognize every secret.
  if (/\b(?:password|passcode|pin|secret|token|api[ _-]?key|access[ _-]?key|door[ _-]?code|passport[ _-]?(?:number|no\.?|#)|card[ _-]?(?:number|no\.?|#)|booking[ _-]?(?:reference|code)|confirmation[ _-]?code|pnr)\s*[:=]\s*\S/i.test(note)
    || /\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(note)) {
    throw new InputError("Confirmation notes must not contain credentials or sensitive booking/access codes. Save only a reminder such as 'confirmation email saved privately'.");
  }
  return note;
}

function zone(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) {
    throw new InputError("Use an explicit IANA timezone, such as America/Chicago, Asia/Tokyo, or UTC.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new InputError(`Unknown IANA timezone: ${value}.`);
  }
}

function wall(at: string, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function offset(moment: Moment): number {
  return (Date.parse(`${wall(moment.at, moment.zone)}Z`) - Date.parse(moment.at)) / 60000;
}

function offsetText(value: number): string {
  const abs = Math.abs(value);
  return `${value >= 0 ? "+" : "-"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function moment(value: string, rawZone: string): Moment {
  const tz = zone(rawZone);
  const match = /^(20\d{2}|2100)-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new InputError("Use a valid 2000–2100 ISO date/time with explicit offset, e.g. 2026-11-02T09:00-06:00, plus its IANA zone.");
  }
  const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}`;
  const at = new Date(value).toISOString();
  // Round-tripping also rejects normalized invalid calendar dates and DST gaps.
  if (wall(at, tz) !== local || match[4] === "24") {
    throw new InputError(`Date or UTC offset does not match ${tz}. Check the calendar date and DST offset; nonexistent local times are not accepted.`);
  }
  return { at, zone: tz };
}

function transfer(value: string): number {
  if (!/^\d{1,4}$/.test(value) || Number(value) > 1440) {
    throw new InputError("Minimum transfer must be a whole number from 0 to 1440 minutes.");
  }
  return Number(value);
}

function fields(value: string, min: number, max = min): string[] {
  const parts = value.split("|").map((part) => part.trim());
  if (parts.length < min || parts.length > max || parts.some((part) => !part)) {
    throw new InputError(`Expected ${min === max ? min : `${min}–${max}`} nonempty fields separated by |. Use help for syntax; omit optional fields entirely.`);
  }
  return parts;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new InputError("Use the full stable ID shown by trip, timeline, or packing.");
  }
  return value;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Invalid saved object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid saved list");
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid saved boolean");
  return value;
}

function savedDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Invalid saved timestamp");
  }
  return value;
}

function savedMoment(value: unknown): Moment {
  const r = record(value, ["at", "zone"]);
  const at = savedDate(r.at), tz = zone(r.zone);
  // Preserve the same minute/second precision and year bounds accepted on input.
  const local = wall(at, tz);
  if (at.slice(20, 23) !== "000" || !/^(20\d{2}|2100)-/.test(local)) throw new Error("Invalid saved itinerary date");
  return { at, zone: tz };
}

function validSpan(entry: Entry): void {
  if (Date.parse(entry.end.at) <= Date.parse(entry.start.at)) {
    throw new InputError("End/arrival must be after start/departure in absolute time. Check dates, day boundaries and UTC offsets.");
  }
  if (entry.kind !== "leg" && (entry.from !== entry.to || entry.start.zone !== entry.end.zone)) throw new Error("Invalid saved stay/activity");
}

function state(value: unknown): State {
  try {
    const r = record(value, ["version", "trips"]);
    if (r.version !== 1) throw new Error("Unsupported saved version");
    const ids = new Set<string>();
    const uniqueId = (raw: unknown) => {
      const v = id(raw);
      if (ids.has(v)) throw new Error("Duplicate saved ID");
      ids.add(v);
      return v;
    };
    const trips = array(r.trips, LIMIT.trips).map((raw): Trip => {
      const t = record(raw, ["id", "title", "zone", "minTransfer", "constraints", "archived", "createdAt", "updatedAt", "entries", "packing"]);
      if (typeof t.minTransfer !== "number" || !Number.isInteger(t.minTransfer)) throw new Error("Invalid transfer minimum");
      const entries = array(t.entries, LIMIT.entries).map((raw): Entry => {
        const e = record(raw, ["id", "kind", "title", "from", "to", "start", "end", "note"]);
        if (e.kind !== "leg" && e.kind !== "stay" && e.kind !== "activity") throw new Error("Invalid entry kind");
        const entry: Entry = {
          id: uniqueId(e.id), kind: e.kind, title: clean(e.title, LIMIT.title, "Title"),
          from: clean(e.from, LIMIT.title, "Location"), to: clean(e.to, LIMIT.title, "Location"),
          start: savedMoment(e.start), end: savedMoment(e.end), note: confirmationNote(e.note),
        };
        validSpan(entry);
        return entry;
      });
      return {
        id: uniqueId(t.id), title: clean(t.title, LIMIT.title, "Trip title"), zone: zone(t.zone),
        minTransfer: transfer(String(t.minTransfer)), constraints: clean(t.constraints, LIMIT.constraints, "Constraints", true),
        archived: boolean(t.archived), createdAt: savedDate(t.createdAt), updatedAt: savedDate(t.updatedAt), entries,
        packing: array(t.packing, LIMIT.packing).map((raw): PackingItem => {
          const p = record(raw, ["id", "label", "packed"]);
          return { id: uniqueId(p.id), label: clean(p.label, LIMIT.title, "Packing item"), packed: boolean(p.packed) };
        }),
      };
    });
    return { version: 1, trips };
  } catch {
    throw new SavedDataError("Saved travel data could not be validated and has been left unchanged. Ask the runtime maintainer to repair the scoped travel record; commands will not overwrite it.");
  }
}

const empty = (): State => ({ version: 1, trips: [] });
async function read(ctx: AgentFeatureContext): Promise<State> {
  const value = await ctx.store.read<unknown>(KEY);
  return value === null ? empty() : state(value);
}

function find(s: State, tripId: string, editable = false): Trip {
  const wanted = id(tripId), trip = s.trips.find((t) => t.id === wanted);
  if (!trip) throw new InputError("Trip not found. Use trip to list your saved IDs.");
  if (editable && trip.archived) throw new InputError(`Trip is archived. Use archive ${trip.id} undo before editing.`);
  return trip;
}

async function mutate(ctx: AgentFeatureContext, change: (s: State) => string): Promise<string> {
  return ctx.store.update<unknown, string>(KEY, empty(), (current) => {
    // Decode into fresh objects. A retry never mutates the store input or captured command data.
    const next = state(current);
    return { value: next, result: change(next) };
  });
}

// Escape Slack control syntax in user text: saved text remains data, even in private replies.
const display = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sameLocation = (a: string, b: string): boolean => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");
const chronological = (trip: Trip): Entry[] => [...trip.entries].sort((a, b) => a.start.at.localeCompare(b.start.at) || a.end.at.localeCompare(b.end.at) || a.id.localeCompare(b.id));
const dateLabel = (m: Moment): string => `${wall(m.at, m.zone).replace(/:00$/, "")} UTC${offsetText(offset(m))} [${m.zone}]`;
const entryRef = (e: Entry): string => `${display(e.title)} [${e.id}]`;

function timeline(trip: Trip, viewerZone: string): string {
  if (!trip.entries.length) return "No dated entries yet. Use add-leg, add-stay, or add-activity; help shows the fields.";
  return `Timeline — ordered by actual start instant. Home: ${trip.zone}; your supplied timezone: ${viewerZone}.\n` + chronological(trip).map((e) => {
    const route = e.kind === "leg" ? `${display(e.from)} → ${display(e.to)}` : display(e.from);
    return `${e.kind.toUpperCase()} ${entryRef(e)} — ${route}\n  ${dateLabel(e.start)} → ${dateLabel(e.end)} (${(Date.parse(e.end.at) - Date.parse(e.start.at)) / 60000} min elapsed)\n  Start in your timezone: ${wall(e.start.at, viewerZone)} [${viewerZone}]${e.note ? `\n  User confirmation note (unverified): ${display(e.note)}` : ""}`;
  }).join("\n\n");
}

function checks(trip: Trip): string[] {
  const entries = chronological(trip), messages: string[] = [], notices: string[] = [];
  for (const e of entries) {
    const start = wall(e.start.at, e.start.zone), end = wall(e.end.at, e.end.zone);
    if (start.slice(0, 10) !== end.slice(0, 10)) {
      notices.push(`DATE BOUNDARY — ${entryRef(e)}: ${start.slice(0, 10)} → ${end.slice(0, 10)} in the entered endpoint zones. Keep both dates in your plans.`);
    }
    if (e.start.zone !== e.end.zone || offset(e.start) !== offset(e.end)) {
      notices.push(`TIMEZONE — ${entryRef(e)}: ${e.start.zone} UTC${offsetText(offset(e.start))} → ${e.end.zone} UTC${offsetText(offset(e.end))}. Use elapsed time, not clock subtraction.`);
    }
    if (end <= start) {
      notices.push(`LOCAL CLOCK REVERSES — ${entryRef(e)} arrives at an equal/earlier local clock/date but later in actual time. This is valid across timezones or a DST fallback.`);
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const overlap = Math.min(Date.parse(a.end.at), Date.parse(b.end.at)) - Math.max(Date.parse(a.start.at), Date.parse(b.start.at));
      if (overlap <= 0) continue;
      if (a.kind === "stay" && b.kind === "stay") {
        messages.push(`LODGING OVERLAP — ${entryRef(a)} and ${entryRef(b)} overlap by ${overlap / 60000} min; confirm whether both stays are intentional.`);
      } else if (a.kind !== "stay" && b.kind !== "stay") {
        messages.push(`CONFLICT — ${entryRef(a)} and ${entryRef(b)} overlap by ${overlap / 60000} min in actual time. Both recorded schedules cannot be followed in full.`);
      }
    }
  }
  const moving = entries.filter((e) => e.kind !== "stay");
  for (let i = 1; i < moving.length; i++) {
    const before = moving[i - 1], after = moving[i];
    const gap = (Date.parse(after.start.at) - Date.parse(before.end.at)) / 60000;
    if (gap < 0) continue; // Already reported as an overlap.
    const different = !sameLocation(before.to, after.from);
    if (different && gap === 0) {
      messages.push(`IMPOSSIBLE RECORDED TRANSFER — ${entryRef(before)} → ${entryRef(after)}: 0 min between different location labels (${display(before.to)} → ${display(after.from)}). Add a transfer or correct the locations/times.`);
    } else if ((different || before.kind === "leg" || after.kind === "leg") && gap < trip.minTransfer) {
      messages.push(`TRANSFER BELOW MINIMUM — ${entryRef(before)} → ${entryRef(after)}: ${gap} min available, below your ${trip.minTransfer}-min minimum${different ? `; ${display(before.to)} → ${display(after.from)} also needs a connecting transfer` : ""}.`);
    } else if (different) {
      messages.push(`LOCATION GAP — ${entryRef(before)} → ${entryRef(after)}: ${display(before.to)} → ${display(after.from)} in ${gap} min. No connecting leg is recorded; actual travel time is unknown.`);
    }
  }
  return [...messages, ...notices];
}

function checkReport(trip: Trip): string {
  if (!trip.entries.length) return "No entries to check. Add your dated transport, lodging, and activities first.";
  const issues = checks(trip);
  const body = issues.length ? issues.slice(0, 50).join("\n") + (issues.length > 50 ? `\n${issues.length - 50} more notices; remove conflicts and run check again.` : "") : "No recorded overlaps or transfer warnings.";
  return `${body}\nChecks use supplied dates and a ${trip.minTransfer}-min transfer minimum. Hotel stays may contain activities/transport. Location labels are compared literally (ignoring case/spacing); routing, airport rules, cancellations, bookings and free-text constraints are not verified.`;
}

function packing(trip: Trip): string {
  return `Packing — ${trip.packing.filter((p) => p.packed).length}/${trip.packing.length} packed\n` + (trip.packing.length
    ? trip.packing.map((p) => `${p.packed ? "[x]" : "[ ]"} ${display(p.label)} [${p.id}]`).join("\n")
    : `No items yet. Use packing ${trip.id} add | Charger | Rain jacket`);
}

function overview(trip: Trip): string {
  return `${display(trip.title)} [${trip.id}]${trip.archived ? " — archived" : ""}\nHome timezone: ${trip.zone}; minimum transfer: ${trip.minTransfer} min\nUser constraints (not automatically enforced): ${trip.constraints ? display(trip.constraints) : "none recorded"}\n${trip.entries.length} itinerary entries; ${trip.packing.filter((p) => p.packed).length}/${trip.packing.length} packing items packed.\nConfirmation notes are user supplied; nothing is booked or verified.`;
}

function brief(trip: Trip, ctx: AgentFeatureContext): string {
  const now = ctx.now.toISOString(), remaining = chronological(trip).filter((e) => e.end.at > now);
  const first = remaining[0];
  const pending = trip.packing.filter((p) => !p.packed);
  return `${overview(trip)}\n\nPreparation brief — deterministic, grounded only in this saved itinerary. As of ${wall(now, zone(ctx.timezone))} [${zone(ctx.timezone)}].\n` +
    (first ? `Next/ongoing recorded entry: ${entryRef(first)}, ${dateLabel(first.start)} → ${dateLabel(first.end)}.\n` : "No upcoming or ongoing entries are recorded.\n") +
    `Still to pack: ${pending.length ? pending.map((p) => `${display(p.label)} [${p.id}]`).join(", ") : trip.packing.length ? "all recorded items marked packed" : "no packing list recorded"}.\n` +
    `Missing confirmation notes: ${remaining.filter((e) => !e.note).length} of ${remaining.length} upcoming/ongoing entries. A saved note is not proof of booking.\n\n${checkReport(trip)}\n\nReview your saved constraints and verify times/confirmation status yourself before departure. No live travel, weather, price or entry-requirement lookup is included.`;
}

function makeEntry(verb: string, args: string): { tripId: string; entry: Entry } {
  const leg = verb === "add-leg", p = fields(args, leg ? 8 : 6, leg ? 9 : 7);
  const entry: Entry = {
    id: randomUUID(), kind: leg ? "leg" : verb === "add-stay" ? "stay" : "activity",
    title: clean(p[1], LIMIT.title, "Entry title"), from: clean(p[2], LIMIT.title, "Location"),
    to: clean(leg ? p[3] : p[2], LIMIT.title, "Location"),
    start: moment(p[leg ? 4 : 3], p[leg ? 5 : 4]),
    end: moment(p[leg ? 6 : 5], p[leg ? 7 : 4]),
    note: confirmationNote(p[leg ? 8 : 6] ?? ""),
  };
  validSpan(entry);
  return { tripId: id(p[0]), entry };
}

async function run(command: string, ctx: AgentFeatureContext): Promise<string> {
  if (command.length > 8000) throw new InputError("Travel commands must be at most 8000 characters.");
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim());
  if (!match || match[1] === "help") return HELP;
  const verb = match[1].toLowerCase(), args = match[2]?.trim() ?? "";
  if ((verb === "trip" || verb === "show") && !args) {
    const s = await read(ctx);
    return s.trips.length ? s.trips.map((t) => `${display(t.title)} [${t.id}] — ${t.archived ? "archived" : "active"}, ${t.entries.length} entries, ${t.zone}`).join("\n") : "No trips yet. Try: trip Japan visit | America/Chicago | 90 | Carry-on only";
  }
  if (["show", "timeline", "check"].includes(verb)) {
    const tokens = args.split(/\s+/);
    if (tokens.length !== 1 && !(verb === "show" && tokens.length === 2 && tokens[1] === "brief")) throw new InputError(`Use ${verb} <trip-id>${verb === "show" ? " [brief]" : ""}.`);
    const trip = find(await read(ctx), tokens[0]);
    if (verb === "timeline") return `${overview(trip)}\n\n${timeline(trip, zone(ctx.timezone))}`;
    if (verb === "check") return `${display(trip.title)} — itinerary checks\n${checkReport(trip)}`;
    return tokens[1] === "brief" ? brief(trip, ctx) : `${overview(trip)}\n\n${timeline(trip, zone(ctx.timezone))}\n\n${packing(trip)}`;
  }
  // Time and all random IDs are computed before update callbacks, which may retry.
  const now = ctx.now.toISOString();
  if (verb === "trip") {
    if (args.startsWith("delete ")) {
      const tokens = args.split(/\s+/);
      if (tokens.length !== 3 || tokens[2] !== "confirm") throw new InputError("Use trip delete <trip-id> confirm to permanently delete this trip and its entries/packing list.");
      const tripId = id(tokens[1]);
      return mutate(ctx, (s) => {
        find(s, tripId);
        s.trips = s.trips.filter((t) => t.id !== tripId);
        return `Deleted trip ${tripId} and its itinerary/packing list.`;
      });
    }
    if (args.startsWith("constraints ")) {
      const [tripId, rawMin, rawConstraints] = fields(args.slice("constraints ".length), 3);
      id(tripId);
      const minimum = transfer(rawMin), constraints = clean(rawConstraints === "-" ? "" : rawConstraints, LIMIT.constraints, "Constraints", true);
      return mutate(ctx, (s) => {
        const trip = find(s, tripId, true);
        trip.minTransfer = minimum;
        trip.constraints = constraints;
        trip.updatedAt = now;
        return `Updated constraints for ${display(trip.title)}. Transfer minimum: ${minimum} min. Run check ${trip.id}.`;
      });
    }
    if (args.startsWith("remove-entry ")) {
      const [tripId, entryId] = fields(args.slice("remove-entry ".length), 2);
      id(tripId); id(entryId);
      return mutate(ctx, (s) => {
        const trip = find(s, tripId, true);
        if (!trip.entries.some((e) => e.id === entryId)) throw new InputError("Entry not found in this trip. Use timeline to find its ID.");
        trip.entries = trip.entries.filter((e) => e.id !== entryId);
        trip.updatedAt = now;
        return `Removed entry ${entryId}. Add a replacement with corrected dates if needed.`;
      });
    }
    const p = fields(args, 2, 4);
    const trip: Trip = {
      id: randomUUID(), title: clean(p[0], LIMIT.title, "Trip title"), zone: zone(p[1]),
      minTransfer: p[2] === undefined ? 60 : transfer(p[2]), constraints: clean(p[3] ?? "", LIMIT.constraints, "Constraints", true),
      archived: false, createdAt: now, updatedAt: now, entries: [], packing: [],
    };
    return mutate(ctx, (s) => {
      if (s.trips.length >= LIMIT.trips) throw new InputError("Limit of 10 trips reached (including archived). Use trip delete <trip-id> confirm to make room.");
      s.trips.push(trip);
      return `Created trip ${display(trip.title)} [${trip.id}]. Home timezone: ${trip.zone}; transfer minimum: ${trip.minTransfer} min.\nNext: add-leg ${trip.id} | title | from | to | departure | departure zone | arrival | arrival zone`;
    });
  }
  if (["add-leg", "add-stay", "add-activity"].includes(verb)) {
    const { tripId, entry } = makeEntry(verb, args);
    return mutate(ctx, (s) => {
      const trip = find(s, tripId, true);
      if (trip.entries.length >= LIMIT.entries) throw new InputError("Limit of 40 entries reached. Use trip remove-entry <trip-id> | <entry-id> first.");
      if (trip.entries.some((e) => e.kind === entry.kind && e.title === entry.title && e.from === entry.from && e.to === entry.to && e.start.at === entry.start.at && e.end.at === entry.end.at)) throw new InputError("That itinerary entry is already recorded. Use timeline to inspect it.");
      trip.entries.push(entry);
      trip.updatedAt = now;
      return `Added ${entry.kind} ${entryRef(entry)}.\n${dateLabel(entry.start)} → ${dateLabel(entry.end)}\nRun check ${trip.id} for conflicts and transfer gaps. Nothing booked or verified.`;
    });
  }
  if (verb === "packing") {
    const m = /^(\S+)(?:\s+(add|done|undo|remove)(?:\s+([\s\S]*))?)?$/.exec(args);
    if (!m) throw new InputError("Use packing <trip-id>, packing <trip-id> add | item | item, or packing <trip-id> done|undo|remove <packing-id>.");
    const tripId = id(m[1]), action = m[2];
    if (!action) return packing(find(await read(ctx), tripId));
    const raw = m[3] ?? "";
    const items = action === "add" ? fields(raw.replace(/^\|\s*/, ""), 1, LIMIT.packing).map((label) => ({ id: randomUUID(), label: clean(label, LIMIT.title, "Packing item"), packed: false })) : [];
    const itemId = action === "add" ? "" : id(raw);
    return mutate(ctx, (s) => {
      const trip = find(s, tripId, true);
      if (action === "add") {
        if (trip.packing.length + items.length > LIMIT.packing) throw new InputError("Limit of 40 packing items reached. Remove items before adding more.");
        const labels = new Set(trip.packing.map((p) => p.label.toLowerCase()));
        for (const item of items) {
          if (labels.has(item.label.toLowerCase())) throw new InputError(`Packing item already listed: ${display(item.label)}. Nothing added.`);
          labels.add(item.label.toLowerCase());
        }
        trip.packing.push(...items);
      } else {
        const item = trip.packing.find((p) => p.id === itemId);
        if (!item) throw new InputError("Packing item not found in this trip. Use packing <trip-id> to list IDs.");
        if (action === "remove") trip.packing = trip.packing.filter((p) => p.id !== itemId);
        else item.packed = action === "done";
      }
      trip.updatedAt = now;
      return packing(trip);
    });
  }
  if (verb === "archive") {
    const tokens = args.split(/\s+/);
    if (tokens.length !== 1 && !(tokens.length === 2 && tokens[1] === "undo")) throw new InputError("Use archive <trip-id> [undo]. Archived trips remain readable and count toward the limit.");
    const tripId = id(tokens[0]), archived = tokens.length === 1;
    return mutate(ctx, (s) => {
      const trip = find(s, tripId);
      trip.archived = archived;
      trip.updatedAt = now;
      return `${archived ? "Archived" : "Reopened"} ${display(trip.title)} [${trip.id}].${archived ? " It remains readable; archive <trip-id> undo reopens it. Use trip delete <trip-id> confirm for permanent removal." : ""}`;
    });
  }
  throw new InputError("Unknown travel command. Use help for trip, add-leg, add-stay, add-activity, timeline, check, packing, show, and archive.");
}

export const feature: AgentFeature = {
  id: "travel",
  title: "Travel itinerary assistant",
  description: "Private multi-leg itineraries, timezone and transfer checks, constraints, and packing preparation.",
  help: HELP,
  async execute(command, ctx) {
    try {
      const result = await run(command, ctx);
      return result.length <= 27000 ? result : `${result.slice(0, 26700)}\n[Output shortened. Use timeline, check, or packing separately for focused views.]`;
    } catch (error) {
      if (error instanceof InputError || error instanceof SavedDataError) return error.message;
      return "Travel storage or runtime is unavailable. No external action was taken. Check show before retrying a change; a storage write may have completed.";
    }
  },
};

export default feature;
