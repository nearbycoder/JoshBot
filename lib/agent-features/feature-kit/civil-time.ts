/** Civil labels never become caller-local midnight instants. No scheduling/DST guesses. */
const DAY = 86_400_000;

export function civilDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a real YYYY-MM-DD civil date (years 0000–9999).");
  // UTC is only an arithmetic coordinate; the resulting epoch is never exposed as
  // an event instant. Round-trip validation follows the existing planner time helper.
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) throw new Error("Use a real YYYY-MM-DD civil date.");
  return value;
}
export function addCivilDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days) || Math.abs(days) > 3_652_425) throw new Error("Use a bounded whole number of civil days.");
  const result = new Date(Date.parse(`${civilDate(value)}T00:00:00.000Z`) + days * DAY).toISOString();
  if (result.length !== 24) throw new Error("Civil-date arithmetic is outside years 0000–9999.");
  return civilDate(result.slice(0, 10));
}
export function compareCivilDates(a: string, b: string): -1 | 0 | 1 {
  const first = civilDate(a), second = civilDate(b);
  return first < second ? -1 : first > second ? 1 : 0;
}
export function civilDaysBetween(start: string, end: string): number {
  return (Date.parse(`${civilDate(end)}T00:00:00Z`) - Date.parse(`${civilDate(start)}T00:00:00Z`)) / DAY;
}

/** Same strict explicit-offset grammar as day-planner/time; no feature import. */
export function normalizeInstant(value: unknown): string {
  if (typeof value !== "string" || value.length > 29) throw new Error("Use an ISO instant with Z or an explicit offset.");
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("Use an ISO instant with Z or an explicit offset; no local times or leap seconds.");
  civilDate(match[1]);
  const offset = match[2];
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 ||
      (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0) || offset === "-00:00")) throw new Error("Invalid or unknown instant offset.");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("Invalid instant.");
  const result = new Date(epoch).toISOString();
  if (result.length !== 24) throw new Error("Instant is outside years 0000–9999.");
  return result;
}

export function dateInZone(now: Date, zone: string): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof zone !== "string" || zone.length > 100 ||
      !/^(?:UTC|[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+)$/.test(zone)) throw new Error("Supply the invocation's valid now and IANA timezone.");
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", era: "short" });
  } catch { throw new Error("Supply a valid IANA timezone."); }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  const year = parts.era === "BC" || parts.era === "BCE" ? 1 - Number(parts.year) : Number(parts.year);
  return civilDate(`${String(year).padStart(4, "0")}-${parts.month}-${parts.day}`);
}

export function civilRange(start: string, endExclusive: string): { start: string; endExclusive: string } {
  if (compareCivilDates(start, endExclusive) >= 0) throw new Error("An all-day range needs an exclusive end after its start.");
  return { start, endExclusive };
}
export function instantRange(start: string, end?: string): { start: string; end: string; point: boolean } {
  const first = normalizeInstant(start), last = end === undefined ? first : normalizeInstant(end);
  if (last < first) throw new Error("Event end cannot precede its start.");
  return { start: first, end: last, point: first === last };
}
