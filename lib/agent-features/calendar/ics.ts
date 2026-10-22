import { createHash } from "node:crypto";
import { CalendarError, date, localInstant, nextDate, timezone } from "./time.js";

export const MAX_EVENTS = 100;
export const MAX_ICS_BYTES = 65_536;

type EventBase = {
  id: string;
  uid: string;
  title: string;
  location: string;
  busy: boolean;
  updatedAt: string;
};

export type CalendarEvent = EventBase & (
  | { allDay: true; startDate: string; endDate: string }
  | { allDay: false; startAt: string; endAt: string; timezone: string }
);

type Property = { name: string; params: Map<string, string>; value: string };

export function eventId(uid: string): string {
  return `cal_${createHash("sha256").update(uid).digest("hex").slice(0, 24)}`;
}

function splitOutsideQuotes(value: string, delimiter: string): string[] {
  let quoted = false;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"') quoted = !quoted;
    if (!quoted && value[i] === delimiter) {
      result.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) throw new CalendarError("Unclosed quoted ICS parameter.");
  return [...result, value.slice(start)];
}

function property(line: string): Property {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (!quoted && line[i] === ":") { colon = i; break; }
  }
  if (colon < 1) throw new CalendarError("Malformed ICS content line (expected PROPERTY:value).");
  const [rawName, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
  const name = rawName.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) throw new CalendarError("Invalid ICS property name.");
  const params = new Map<string, string>();
  for (const parameter of rawParams) {
    const equal = parameter.indexOf("=");
    const key = parameter.slice(0, equal).toUpperCase();
    let value = parameter.slice(equal + 1);
    if (equal < 1 || !/^[A-Z0-9-]+$/.test(key) || !value || params.has(key)) {
      throw new CalendarError(`Invalid or duplicate parameter on ${name}.`);
    }
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.includes('"')) throw new CalendarError(`Invalid parameter on ${name}.`);
    params.set(key, value);
  }
  return { name, params, value: line.slice(colon + 1) };
}

function parameters(prop: Property, allowed: string[]): void {
  for (const key of prop.params.keys()) {
    if (!allowed.includes(key)) throw new CalendarError(`Unsupported ${key} parameter on ${prop.name}.`);
  }
}

function textValue(prop: Property, limit: number, multiline = true): string {
  parameters(prop, prop.name === "UID" ? ["VALUE"] : ["VALUE", "LANGUAGE"]);
  if (prop.params.has("VALUE") && prop.params.get("VALUE")!.toUpperCase() !== "TEXT") {
    throw new CalendarError(`${prop.name} must use TEXT values.`);
  }
  let value = "";
  for (let i = 0; i < prop.value.length; i++) {
    const char = prop.value[i];
    if (char !== "\\") { value += char; continue; }
    const escaped = prop.value[++i];
    if (escaped === "n" || escaped === "N") value += "\n";
    else if (escaped === "\\" || escaped === "," || escaped === ";") value += escaped;
    else throw new CalendarError(`Unsupported text escape in ${prop.name}.`);
  }
  if (value.length > limit || (!multiline && /[\r\n\t]/.test(value))) {
    throw new CalendarError(`${prop.name} must fit ${limit} characters${multiline ? "" : " on one line"}.`);
  }
  return multiline ? value.replace(/\s+/g, " ").trim() : value;
}

type ParsedTime = { allDay: true; day: string } | { allDay: false; at: string; zone: string };

function parseTime(prop: Property, fallbackZone: string): ParsedTime {
  parameters(prop, ["VALUE", "TZID"]);
  const type = (prop.params.get("VALUE") ?? "DATE-TIME").toUpperCase();
  const raw = prop.value;
  if (type === "DATE") {
    if (prop.params.has("TZID") || !/^\d{8}$/.test(raw)) {
      throw new CalendarError(`${prop.name} DATE must be YYYYMMDD without TZID.`);
    }
    return { allDay: true, day: date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`) };
  }
  if (type !== "DATE-TIME" || !/^\d{8}T\d{6}Z?$/.test(raw)) {
    throw new CalendarError(`${prop.name} must be YYYYMMDDTHHMMSS[Z], or VALUE=DATE:YYYYMMDD. Offsets and leap seconds are unsupported.`);
  }
  if (raw.endsWith("Z") && prop.params.has("TZID")) {
    throw new CalendarError(`${prop.name} cannot combine UTC Z with TZID.`);
  }
  const zone = raw.endsWith("Z") ? "UTC" : timezone(prop.params.get("TZID") ?? fallbackZone);
  const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const clock = `${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}`;
  const at = new Date(localInstant(day, clock, zone)).toISOString();
  date(at.slice(0, 10));
  return { allDay: false, at, zone };
}

const IGNORED_EVENT_METADATA = new Set([
  "DTSTAMP", "CREATED", "LAST-MODIFIED", "SEQUENCE", "DESCRIPTION", "ATTENDEE", "ORGANIZER",
  "URL", "CLASS", "CATEGORIES", "COMMENT", "CONTACT", "GEO", "PRIORITY", "RESOURCES", "RELATED-TO", "ATTACH",
]);
const RECURRENCE = new Set(["RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID"]);

function parseEvent(props: Property[], zone: string, updatedAt: string): CalendarEvent {
  const fields = new Map<string, Property>();
  for (const prop of props) {
    if (RECURRENCE.has(prop.name)) throw new CalendarError(`${prop.name}: recurrence is unsupported. Paste individual, non-recurring VEVENTs instead.`);
    if (prop.name === "DURATION") throw new CalendarError("DURATION is unsupported. Supply DTEND instead.");
    if (IGNORED_EVENT_METADATA.has(prop.name)) continue;
    if (!["UID", "DTSTART", "DTEND", "SUMMARY", "LOCATION", "TRANSP", "STATUS"].includes(prop.name)) {
      throw new CalendarError(`Unsupported VEVENT property ${prop.name}. No events were staged.`);
    }
    if (fields.has(prop.name)) throw new CalendarError(`Duplicate ${prop.name} in VEVENT.`);
    fields.set(prop.name, prop);
  }
  const uidProperty = fields.get("UID");
  const startProperty = fields.get("DTSTART");
  if (!uidProperty || !startProperty) throw new CalendarError("Each VEVENT needs exactly one UID and DTSTART.");
  const uid = textValue(uidProperty, 512, false);
  if (!uid.trim()) throw new CalendarError("VEVENT UID cannot be empty.");
  const status = fields.get("STATUS");
  if (status) {
    parameters(status, []);
    if (!["CONFIRMED", "TENTATIVE"].includes(status.value.toUpperCase())) {
      throw new CalendarError("Only CONFIRMED/TENTATIVE events are supported. Remove cancelled events explicitly with remove <id> confirm.");
    }
  }
  const transparency = fields.get("TRANSP");
  if (transparency) {
    parameters(transparency, []);
    if (!["OPAQUE", "TRANSPARENT"].includes(transparency.value.toUpperCase())) {
      throw new CalendarError("TRANSP must be OPAQUE or TRANSPARENT.");
    }
  }
  const base: EventBase = {
    id: eventId(uid), uid,
    title: fields.has("SUMMARY") ? textValue(fields.get("SUMMARY")!, 160) || "Untitled event" : "Untitled event",
    location: fields.has("LOCATION") ? textValue(fields.get("LOCATION")!, 160) : "",
    busy: transparency?.value.toUpperCase() !== "TRANSPARENT", updatedAt,
  };
  const start = parseTime(startProperty, zone);
  const end = fields.has("DTEND") ? parseTime(fields.get("DTEND")!, zone) : undefined;
  if (start.allDay) {
    if (end && !end.allDay) throw new CalendarError("DTSTART and DTEND must both be dates or both be date-times.");
    const endDate = end?.allDay ? end.day : nextDate(start.day);
    if (endDate <= start.day) throw new CalendarError("DTEND is exclusive and must be after DTSTART.");
    return { ...base, allDay: true, startDate: start.day, endDate };
  }
  if (end?.allDay) throw new CalendarError("DTSTART and DTEND must both be dates or both be date-times.");
  const endAt = end && !end.allDay ? end.at : start.at;
  if (end && endAt <= start.at) throw new CalendarError("DTEND must be after DTSTART.");
  return { ...base, allDay: false, startAt: start.at, endAt, timezone: start.zone };
}

/** Pasted data only. Does not dereference URLs, attachments, or timezone identifiers. */
export function parseCalendar(raw: string, suppliedZone: string, updatedAt: string): CalendarEvent[] {
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_ICS_BYTES) {
    throw new CalendarError(`Paste ICS text, at most ${MAX_ICS_BYTES} UTF-8 bytes; URLs are not fetched.`);
  }
  const zone = timezone(suppliedZone);
  raw = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw)) throw new CalendarError("ICS contains unsupported control characters or bare carriage returns.");
  const physical = raw.split("\n");
  if (physical.length > 2_000) throw new CalendarError("ICS exceeds the 2,000-line limit.");
  while (physical[0] === "") physical.shift();
  while (physical.at(-1) === "") physical.pop();
  const lines: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line)) {
      if (!lines.length) throw new CalendarError("ICS cannot begin with a folded continuation.");
      lines[lines.length - 1] += line.slice(1);
    } else lines.push(line);
    if (lines.at(-1)!.length > 8_192) throw new CalendarError("An unfolded ICS line exceeds 8,192 characters.");
  }
  if (lines[0]?.toUpperCase() !== "BEGIN:VCALENDAR" || lines.at(-1)?.toUpperCase() !== "END:VCALENDAR") {
    throw new CalendarError("Paste a complete BEGIN:VCALENDAR … END:VCALENDAR document (not a URL or code fence).");
  }
  let event: Property[] | null = null;
  const events: CalendarEvent[] = [];
  const uids = new Set<string>();
  const calendarFields = new Set<string>();
  for (const line of lines.slice(1, -1)) {
    const prop = property(line);
    if (prop.name === "BEGIN") {
      parameters(prop, []);
      if (prop.value.toUpperCase() !== "VEVENT" || event) {
        throw new CalendarError("Only flat VEVENT components are supported; VTIMEZONE, VALARM, and other nested components are rejected. Export UTC or IANA TZID events without embedded timezone definitions.");
      }
      event = [];
    } else if (prop.name === "END") {
      parameters(prop, []);
      if (prop.value.toUpperCase() !== "VEVENT" || !event) throw new CalendarError("Mismatched ICS component END.");
      const parsed = parseEvent(event, zone, updatedAt);
      if (uids.has(parsed.uid)) throw new CalendarError("Duplicate UID in this import. Supply only one non-recurring event per UID.");
      uids.add(parsed.uid);
      events.push(parsed);
      if (events.length > MAX_EVENTS) throw new CalendarError(`Import at most ${MAX_EVENTS} events at a time.`);
      event = null;
    } else if (event) event.push(prop);
    else {
      parameters(prop, []);
      if (calendarFields.has(prop.name)) throw new CalendarError(`Duplicate calendar property ${prop.name}.`);
      calendarFields.add(prop.name);
      if (prop.name === "VERSION" && prop.value === "2.0") continue;
      if (prop.name === "CALSCALE" && prop.value.toUpperCase() === "GREGORIAN") continue;
      if (prop.name === "METHOD" && prop.value.toUpperCase() === "PUBLISH") continue;
      if (["PRODID", "X-WR-CALNAME", "X-WR-CALDESC"].includes(prop.name)) continue;
      throw new CalendarError(`Unsupported calendar property/value ${prop.name}. Only VERSION:2.0, Gregorian calendars, and absent/PUBLISH METHOD are supported; X-WR-TIMEZONE is not used as a timezone override.`);
    }
  }
  if (event) throw new CalendarError("VEVENT is missing END:VEVENT.");
  if (!calendarFields.has("VERSION")) throw new CalendarError("VCALENDAR requires VERSION:2.0.");
  if (!events.length) throw new CalendarError("No VEVENTs found. Paste at least one event to preview.");
  return events;
}
