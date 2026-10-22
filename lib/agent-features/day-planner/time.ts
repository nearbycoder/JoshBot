/** Explicit civil-time conversion, independent of the server's timezone. */
export class PlannerError extends Error {}

const MINUTE = 60_000;
const DAY = 86_400_000;

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

export function validDate(value: unknown): value is string {
  return calendarDate(value) && Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 2200;
}

export function minuteOfDay(value: unknown, allowEnd = false): number | null {
  if (allowEnd && value === "24:00") return 1440;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

/** Only ISO instants with an explicit offset; Date.parse alone normalizes bad dates. */
export function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  // Absolute instants may cross into an adjacent UTC year at a civil-date limit.
  if (!match || !calendarDate(match[1])) return null;
  const offset = match[5];
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 ||
    (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0))) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString().length === 24 ? result : null;
}

export function iso(value: number): string { return new Date(value).toISOString(); }

export class ZonedTime {
  private readonly formatter: Intl.DateTimeFormat;
  private readonly offsets = new Map<string, number[]>();

  constructor(readonly timezone: string) {
    if (typeof timezone !== "string" || !timezone || timezone.length > 100) {
      throw new PlannerError("A valid timezone must be supplied before planning.");
    }
    try {
      this.formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, calendar: "iso8601", numberingSystem: "latn",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
        minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
    } catch {
      throw new PlannerError("The supplied timezone is invalid. Set a valid IANA timezone and retry.");
    }
  }

  private parts(epoch: number): Record<string, string> {
    return Object.fromEntries(this.formatter.formatToParts(epoch).map(part => [part.type, part.value]));
  }

  date(epoch: number): string {
    const p = this.parts(epoch);
    return `${p.year}-${p.month}-${p.day}`;
  }

  clock(epoch: number): string {
    const p = this.parts(epoch);
    const offsetSeconds = (this.wallEpoch(epoch) - Math.floor(epoch / 1000) * 1000) / 1000;
    const sign = offsetSeconds < 0 ? "-" : "+";
    const offset = Math.abs(offsetSeconds), seconds = offset % 60;
    return `${p.hour}:${p.minute}${p.second === "00" ? "" : `:${p.second}`} UTC${sign}${String(Math.floor(offset / 3600)).padStart(2, "0")}:${String(Math.floor(offset / 60) % 60).padStart(2, "0")}${seconds ? `:${String(seconds).padStart(2, "0")}` : ""}`;
  }

  private wallEpoch(epoch: number): number {
    const p = this.parts(epoch);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  }

  local(date: string, time: string): number {
    const minutes = minuteOfDay(time, true);
    if (!validDate(date) || minutes === null) throw new PlannerError("Use a real YYYY-MM-DD date and HH:mm time.");
    const midnight = Date.parse(`${date}T00:00:00Z`);
    const wall = midnight + minutes * MINUTE;
    // Sample both sides of nearby transitions, including 30-minute and whole-day jumps.
    // Candidate instants must round-trip exactly; there is no implicit DST adjustment.
    let offsets = this.offsets.get(date);
    if (!offsets) {
      const found = new Set<number>();
      for (let delta = -2 * DAY; delta <= 3 * DAY; delta += 6 * 60 * MINUTE) {
        const sample = midnight + delta;
        found.add(this.wallEpoch(sample) - sample);
      }
      offsets = [...found];
      this.offsets.set(date, offsets);
    }
    const candidates = offsets.map(offset => wall - offset).filter(epoch => this.wallEpoch(epoch) === wall);
    if (candidates.length === 0) {
      throw new PlannerError(`${date} ${time} does not exist in ${this.timezone} because of a clock change. Choose another local time; a deadline may instead use an explicit ISO offset.`);
    }
    if (candidates.length !== 1) {
      throw new PlannerError(`${date} ${time} is ambiguous in ${this.timezone} because of a clock change. Choose an unambiguous working/break boundary; for deadlines, specify an offset such as -05:00 or -06:00.`);
    }
    return candidates[0];
  }

  deadline(value: string): string {
    const absolute = instant(value);
    if (absolute !== null) return iso(absolute);
    const local = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (local && validDate(local[1])) return iso(this.local(local[1], local[2]));
    throw new PlannerError("Deadline must be YYYY-MM-DDTHH:mm in your timezone, or an ISO timestamp with Z or an explicit offset (for example 2026-11-01T01:30-05:00).");
  }
}
