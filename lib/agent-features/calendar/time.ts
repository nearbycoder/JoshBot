/** Strict wall-clock conversion: never use the process's local timezone. */
export class CalendarError extends Error {}

const DAY = 86_400_000;

export function timezone(value: string): string {
  if (typeof value !== "string" || value.length > 100 ||
      !/^(?:UTC|[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+)$/.test(value)) {
    throw new CalendarError("Use UTC or a supported IANA timezone such as America/Chicago.");
  }
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new CalendarError("Unknown IANA timezone. Use UTC or a zone such as America/Chicago.");
  }
}

export function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1970-01-01" || value > "2100-12-31") {
    throw new CalendarError("Use a real YYYY-MM-DD date between 1970 and 2100.");
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw new CalendarError("Use a real YYYY-MM-DD calendar date.");
  }
  return value;
}

export function nextDate(value: string): string {
  return date(new Date(Date.parse(`${date(value)}T00:00:00Z`) + DAY).toISOString().slice(0, 10));
}

function formatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

function wallAt(milliseconds: number, format: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(format.formatToParts(milliseconds).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Reject gaps and folds; callers can disambiguate an event by importing UTC. */
export function localInstant(day: string, clock: string, zone: string): number {
  date(day);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(clock)) {
    throw new CalendarError("Invalid time; use hours 00–23, minutes/seconds 00–59 (no leap seconds).");
  }
  const wall = `${day}T${clock}`;
  const naive = Date.parse(`${wall}Z`);
  const format = formatter(timezone(zone));
  const offsets = new Set<number>();
  // Sample both sides of nearby timezone transitions, including 24-hour date jumps.
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = naive + hours * 3_600_000;
    offsets.add(Date.parse(`${wallAt(probe, format)}Z`) - probe);
  }
  const matches = [...offsets].map(offset => naive - offset)
    .filter(candidate => wallAt(candidate, format) === wall);
  if (matches.length !== 1) {
    throw new CalendarError(`${wall} in ${zone} is ${matches.length ? "ambiguous" : "nonexistent"} because of a timezone transition. Use explicit UTC event times or another date/time; no time was guessed.`);
  }
  return matches[0];
}

export function dayBounds(day: string, zone: string): { start: number; end: number } {
  return { start: localInstant(day, "00:00:00", zone), end: localInstant(nextDate(day), "00:00:00", zone) };
}

/** Include the offset so two occurrences of a DST fall-back hour remain distinct. */
export function displayInstant(milliseconds: number, zone: string): string {
  const wall = wallAt(milliseconds, formatter(zone));
  const offset = Math.round((Date.parse(`${wall}Z`) - milliseconds) / 1000);
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(absolute % 3600 / 60)).padStart(2, "0");
  const seconds = absolute % 60;
  return `${wall.replace("T", " ")} ${offset < 0 ? "-" : "+"}${hours}:${minutes}${seconds ? `:${String(seconds).padStart(2, "0")}` : ""}`;
}
