import { readBoundedContext } from "./bounded-context.js";
import { contextCapacityMessage } from "./budgets.js";
import type { AgentFeature, AgentFeatureContext } from "./types.js";

const CAPACITY_RECOVERY = "No brief was produced and settings are unchanged. Narrow with /nobo-help agent morning-brief settings sources notes, then /nobo-help agent morning-brief brief. Choose other categories separately; if one category is too large, reduce its records in the original tool.";

const KINDS = ["reminder", "follow-up", "goal", "note", "event"] as const;
type Kind = (typeof KINDS)[number];
type Settings = { version: 1; focus: string; sources: Kind[] };
type Bucket = "Overdue" | "Today" | "Later" | "Undated";
type SourceDate = { day: string; instant?: number };
type Source = {
  id: string;
  kind: Kind;
  title: string;
  text: string;
  closed: boolean;
  updated: number;
  start?: SourceDate;
  end?: SourceDate;
  invalidDate: boolean;
};
type Candidate = Source & { bucket: Bucket; matchesFocus: boolean; elapsed: boolean };
const KEY = "settings";
const MAX_CONTEXT = 500;
const MAX_FOCUS = 160;
// Preferences never accumulate records. Leave ample room below the shared 480 KB budget.
const MAX_SETTINGS_BYTES = 2_048;
const LABELS: Record<Kind, string> = {
  reminder: "Reminders", "follow-up": "Follow-ups", goal: "Goals", note: "Notes", event: "Imported events",
};
const ALIASES: Record<string, Kind> = {
  reminder: "reminder", reminders: "reminder", "follow-up": "follow-up", "follow-ups": "follow-up",
  goal: "goal", goals: "goal", note: "note", notes: "note", event: "event", events: "event",
};
const CLOSED = new Set(["done", "complete", "completed", "closed", "cancelled", "canceled", "archived", "deleted", "resolved", "paused", "disabled", "inactive", "reached"]);
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const HELP = `Personal morning briefing — private, on demand
brief [focus] — rank up to five personal priorities and show today's imported events
show / settings / settings show — show saved preferences
settings focus <text> — save a focus (up to 160 characters)
settings focus clear — remove the saved focus
settings sources <comma-separated categories> — choose reminders, follow-ups, goals, notes, events
settings sources all — restore all five categories
settings reset confirm — erase saved preferences and restore defaults

Examples:
/nobo-help agent morning-brief brief launch preparation
/nobo-help agent morning-brief settings sources reminders,follow-ups,goals,events

Focus helps rank items within urgency groups; it does not hide other commitments.
Dates use your supplied timezone. Later means the next seven calendar days.
Preference storage is limited to 2048 UTF-8 bytes. Use show for usage and settings reset confirm to erase preferences.
Briefs use only returned personal sources, cite their IDs, and are not saved. No model, channel triage, live calendar lookup, or scheduled delivery.`;

class InputError extends Error {}
class SettingsError extends Error {}

function defaults(): Settings {
  return { version: 1, focus: "", sources: [...KINDS] };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && KINDS.some((kind) => kind === value);
}

function validFocus(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_FOCUS && value.trim() === value && !CONTROLS.test(value);
}

function settingsBytes(settings: Settings): number {
  return Buffer.byteLength(JSON.stringify(settings), "utf8");
}

function checkSettingsBudget(settings: Settings): void {
  if (settingsBytes(settings) > MAX_SETTINGS_BYTES) {
    throw new InputError("Morning-brief preferences exceed the 2048-byte storage budget. Use a shorter focus, settings focus clear, or settings reset confirm to erase preferences.");
  }
}

function settingsFrom(value: unknown): Settings {
  if (!object(value) || value.version !== 1 || !validFocus(value.focus) ||
      Object.keys(value).some((key) => !["version", "focus", "sources"].includes(key)) ||
      !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > KINDS.length ||
      !value.sources.every(isKind) || new Set(value.sources).size !== value.sources.length) {
    throw new SettingsError();
  }
  const sources = value.sources;
  const settings: Settings = { version: 1, focus: value.focus, sources: KINDS.filter((kind) => sources.includes(kind)) };
  checkSettingsBudget(settings);
  return settings;
}

/** Flatten and escape source text so Slack links/mentions and injected markup stay inert. */
function display(value: string, limit: number): string {
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/[`*_~]/gu, "").replace(/\s+/gu, " ").trim();
  const short = flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
  return short.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function showSettings(settings: Settings): string {
  return `Morning brief settings\nFocus: ${settings.focus ? display(settings.focus, MAX_FOCUS) : "none"}\nSources: ${settings.sources.map((kind) => LABELS[kind]).join(", ")}\nPriorities: at most 5; later: next 7 calendar days; imported agenda: at most 4 events.\nPreference storage: ${settingsBytes(settings)}/${MAX_SETTINGS_BYTES} UTF-8 bytes. Use settings focus clear to remove the focus or settings reset confirm to erase all preferences.\nOnly these preferences are retained.\nRun brief [focus] for a fresh briefing; a one-off focus does not change settings.`;
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000")) return false;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function dateInZone(instant: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(instant);
  return ["year", "month", "day"].map((part) => parts.find((entry) => entry.type === part)!.value.padStart(part === "year" ? 4 : 2, "0")).join("-");
}

/** Civil dates stay civil. Timed dates must carry an explicit offset, never server-local time. */
function parseDate(value: unknown, formatter: Intl.DateTimeFormat): SourceDate | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  if (validDay(value)) return { day: value };
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return undefined;
  const offset = match[6];
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 ||
      (offset.slice(1, 3) === "14" && offset.slice(4) !== "00"))) return undefined;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  return { day: dateInZone(instant, formatter), instant };
}

function shiftDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar adapters keep civil dates alongside normalized midnight instants. */
function allDayDates(metadata: Record<string, unknown>, start: SourceDate | undefined,
  end: SourceDate | undefined, callerFormat: Intl.DateTimeFormat): { start: SourceDate; end: SourceDate } | undefined {
  const { startDate, endDate } = metadata;
  if (typeof startDate !== "string" || typeof endDate !== "string" ||
      !validDay(startDate) || !validDay(endDate) || endDate <= startDate) return undefined;
  try {
    // Validate the optional absolute representation in its declared zone, never
    // the server zone. Civil dates still govern display in the caller's day.
    const zone = metadata.timezone ?? callerFormat.resolvedOptions().timeZone;
    if (typeof zone !== "string" || !zone || zone.length > 100) return undefined;
    const normalizedFormat = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const matches = (boundary: SourceDate | undefined, civil: string): boolean => {
      if (!boundary) return true;
      if (boundary.instant === undefined) return boundary.day === civil;
      return dateInZone(boundary.instant, normalizedFormat) === civil && boundary.instant % 1_000 === 0 &&
        normalizedFormat.formatToParts(boundary.instant)
          .filter((part) => ["hour", "minute", "second"].includes(part.type)).every((part) => part.value === "00");
    };
    if (!matches(start, startDate) || !matches(end, endDate)) return undefined;
    return { start: { day: startDate }, end: { day: endDate } };
  } catch { return undefined; }
}

function sourceFrom(value: unknown, formatter: Intl.DateTimeFormat): Source | undefined {
  if (!object(value) || !isKind(value.kind) || typeof value.id !== "string" || !value.id || value.id.length > 160 ||
      /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>\[\]&`]/u.test(value.id) ||
      typeof value.title !== "string" || !value.title.trim() || typeof value.text !== "string" ||
      (value.status !== undefined && (typeof value.status !== "string" || value.status.length > 80))) return undefined;
  const metadata = object(value.metadata) ? value.metadata : {};
  const rawStart = value.dueAt ?? (value.kind === "event" ? metadata.startAt : undefined);
  const rawEnd = value.kind === "event" ? metadata.endAt : undefined;
  let start = parseDate(rawStart, formatter);
  let end = parseDate(rawEnd, formatter);
  let invalidDate = (rawStart !== undefined && !start) || (rawEnd !== undefined && !end);
  if (value.kind === "event" && ((rawEnd !== undefined && !start) ||
      (start && end && ((start.instant === undefined) !== (end.instant === undefined) ||
        (start.instant === undefined ? end.day <= start.day : end.instant! < start.instant))))) {
    invalidDate = true;
  }
  if (value.kind === "event" && metadata.allDay === true) {
    if (metadata.startDate !== undefined || metadata.endDate !== undefined) {
      const civil = allDayDates(metadata, start, end, formatter);
      if (civil) { start = civil.start; end = civil.end; }
      else invalidDate = true;
    } else if (start?.instant !== undefined) {
      // Without civil dates, an absolute timestamp alone cannot identify an all-day date.
      invalidDate = true;
    }
  }
  // An invalid event range must not become a confident agenda or overlap claim.
  if (value.kind === "event" && invalidDate) { start = undefined; end = undefined; }
  return {
    id: value.id, kind: value.kind, title: value.title.slice(0, 500), text: value.text.slice(0, 4_000),
    closed: CLOSED.has(typeof value.status === "string" ? value.status.trim().toLowerCase() : ""),
    updated: parseDate(value.updatedAt, formatter)?.instant ?? 0,
    start, end, invalidDate,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceKey(source: Source): string { return `${source.kind}:${source.id}`; }

function focusMatches(source: Source, focus: string): boolean {
  const tokens = focus.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words = new Set(`${source.title} ${source.text}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return tokens.some((token) => words.has(token));
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const order: Record<Bucket, number> = { Overdue: 0, Today: 1, Later: 2, Undated: 3 };
  return order[left.bucket] - order[right.bucket] || Number(right.matchesFocus) - Number(left.matchesFocus) ||
    compareText(left.start?.day ?? "", right.start?.day ?? "") ||
    (left.start?.instant ?? Number.MAX_SAFE_INTEGER) - (right.start?.instant ?? Number.MAX_SAFE_INTEGER) ||
    KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind) || compareText(sourceKey(left), sourceKey(right));
}

function dateLabel(date: SourceDate, timeFormat: Intl.DateTimeFormat): string {
  return date.instant === undefined ? date.day : `${date.day} ${timeFormat.format(date.instant)}`;
}

function citation(source: Source): string { return `[${source.kind} ${source.id}]`; }

function isPointEvent(source: Source): boolean {
  return source.kind === "event" && source.start?.instant !== undefined && source.end?.instant === source.start.instant;
}

function renderBrief(raw: unknown, settings: Settings, focus: string, context: AgentFeatureContext,
  dayFormat: Intl.DateTimeFormat, timeFormat: Intl.DateTimeFormat): string {
  if (!Array.isArray(raw)) return "Personal sources returned an invalid response. No brief was produced; try brief again. Saved settings were not changed.";
  const today = dateInZone(context.now.getTime(), dayFormat);
  const horizon = shiftDay(today, 7);
  const records = new Map<string, Source>();
  let invalid = 0, duplicates = 0, invalidDates = 0, past = 0, distant = 0, closed = 0;
  for (const value of raw.slice(0, MAX_CONTEXT)) {
    // Never surface other categories even if the adapter returns more than requested.
    if (object(value) && isKind(value.kind) && !settings.sources.includes(value.kind)) continue;
    const source = sourceFrom(value, dayFormat);
    if (!source) { invalid++; continue; }
    const key = sourceKey(source);
    const previous = records.get(key);
    if (previous) {
      duplicates++;
      // Newer revisions win; at an equal revision a terminal status wins, then a stable tie-break.
      if (source.updated < previous.updated || (source.updated === previous.updated &&
          (Number(source.closed) < Number(previous.closed) || (source.closed === previous.closed &&
            compareText(JSON.stringify(source), JSON.stringify(previous)) <= 0)))) continue;
    }
    records.set(key, source);
  }
  const candidates: Candidate[] = [];
  for (const source of records.values()) {
    if (source.closed) { closed++; continue; }
    if (source.invalidDate) invalidDates++;
    const point = isPointEvent(source);
    let bucket: Bucket = "Undated";
    if (source.start) {
      const first = source.start.day;
      // A point belongs to its start day, including midnight; only nonempty
      // ranges use an exclusive end to determine the final occupied day.
      const last = source.end && !point ? (source.end.instant === undefined ? shiftDay(source.end.day, -1) : dateInZone(source.end.instant - 1, dayFormat)) : first;
      if (source.kind === "event" && last < today) { past++; continue; }
      if (first > horizon) { distant++; continue; }
      bucket = source.kind === "event" && first <= today && last >= today ? "Today" : first < today ? "Overdue" : first === today ? "Today" : "Later";
    }
    candidates.push({ ...source, bucket, matchesFocus: focusMatches(source, focus),
      elapsed: source.kind === "event" && source.end?.instant !== undefined &&
        (point ? source.start!.instant! < context.now.getTime() : source.end.instant <= context.now.getTime()) });
  }
  const priorities = candidates.filter((source) => !source.elapsed).sort(compareCandidates);
  const counts = (bucket: Bucket) => candidates.filter((source) => source.bucket === bucket).length;
  const lines = [
    `Morning brief — ${today} (${context.timezone})`,
    `Focus: ${focus ? display(focus, MAX_FOCUS) : "none"}`,
    "",
    `Top priorities (${Math.min(5, priorities.length)} of ${priorities.length} eligible items)`,
  ];
  if (!priorities.length) lines.push("No priorities found in the returned sources for this window. This is not a complete view of your day.");
  for (const [index, source] of priorities.slice(0, 5).entries()) {
    const timing = source.start ? `${source.kind === "event" ? "starts" : "due"} ${dateLabel(source.start, timeFormat)}${isPointEvent(source) ? "; point event (no duration)" : ""}` : source.invalidDate ? "date invalid; timing unknown" : "no date provided";
    lines.push(`${index + 1}. ${source.bucket} · ${display(source.title, 110)} — ${timing}${source.matchesFocus ? "; matches focus" : ""} ${citation(source)}`);
    if (source.text.trim()) lines.push(`   Source excerpt: ${display(source.text, 160)}`);
  }
  lines.push("", `Timing: Overdue ${counts("Overdue")} · Today ${counts("Today")} · Later ${counts("Later")} · Undated ${counts("Undated")}.`,
    "Ranked by urgency, then focus match, date/time, source kind and ID. Later = next 7 calendar days; undated items are context, not scheduled commitments.");
  if (focus && !candidates.some((source) => source.matchesFocus)) lines.push("No focus matches in this window. Other commitments are still shown.");
  if (settings.sources.includes("event")) {
    const agenda = candidates.filter((source) => source.kind === "event" && source.bucket === "Today")
      .sort((a, b) => compareText(a.start!.day, b.start!.day) ||
        (a.start!.instant ?? 0) - (b.start!.instant ?? 0) || compareText(sourceKey(a), sourceKey(b)));
    lines.push("", `Today's imported events (${agenda.length}${agenda.length > 4 ? "; first 4 shown" : ""})`);
    if (!agenda.length) lines.push("No dated events returned for today. This does not establish calendar availability.");
    for (const source of agenda.slice(0, 4)) {
      const start = source.start!;
      const point = isPointEvent(source);
      const timing = start.instant === undefined ? `all-day${start.day < today ? `, from ${start.day}` : ""}` : dateLabel(start, timeFormat);
      const end = point ? "; point event (no duration)" : source.end ? ` → ${dateLabel(source.end, timeFormat)}${source.end.instant === undefined ? " (exclusive end)" : ""}` : start.instant !== undefined ? "; end unknown" : "";
      const status = point ? (source.elapsed ? "; time passed" : start.instant === context.now.getTime() ? "; now" : "") :
        source.elapsed ? "; ended" : start.instant !== undefined && start.instant <= context.now.getTime() && source.end?.instant !== undefined ? "; in progress" : "";
      lines.push(`- ${timing}${end}${status} · ${display(source.title, 110)} ${citation(source)}`);
    }
  }
  lines.push("", "Source coverage (returned records only)");
  for (const kind of settings.sources) {
    const total = [...records.values()].filter((source) => source.kind === kind).length;
    const included = candidates.filter((source) => source.kind === kind).length;
    lines.push(`- ${LABELS[kind]}: ${total ? `${total} usable records; ${included} in this window` : "no usable records returned (empty or not connected)"}.`);
  }
  const disabled = KINDS.filter((kind) => !settings.sources.includes(kind));
  if (disabled.length) lines.push(`Not selected: ${disabled.map((kind) => LABELS[kind]).join(", ")}. Use settings sources all to include them.`);
  if (invalidDates) lines.push(`Timing unavailable for ${invalidDates} records with invalid dates; treated as undated.`);
  if (invalid) lines.push(`Skipped ${invalid} malformed or unsupported records.`);
  if (duplicates) lines.push(`Collapsed ${duplicates} duplicate source records by kind and ID.`);
  if (closed || past || distant) lines.push(`Excluded: ${closed} completed/inactive records, ${past} past events, ${distant} items beyond ${horizon}.`);
  if (raw.length > MAX_CONTEXT) lines.push(`Source limit reached: examined the first ${MAX_CONTEXT} of ${raw.length} returned records. This brief is incomplete.`);
  lines.push("Add missing reminders, follow-ups, goals or notes in their source tools; import events with the calendar feature. Imports may be stale. This brief uses no channel history or live calendar access.");
  return lines.join("\n");
}

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  try {
    if (typeof command !== "string" || command.length > 500 || CONTROLS.test(command)) throw new InputError("Use a single-line command of at most 500 characters. Run help for examples.");
    if (!command.trim()) return HELP;
    const [verb = "brief", args = ""] = command.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u)?.slice(1) ?? [];
    const action = verb.toLowerCase();
    if (action === "help" && !args) return HELP;
    if (action === "settings" && args.toLowerCase() === "reset confirm") {
      const next = defaults();
      checkSettingsBudget(next);
      await context.store.update<unknown, null>(KEY, next, () => ({ value: next, result: null }));
      return `Saved preferences erased; defaults restored.\n${showSettings(next)}`;
    }
    if (action === "settings" && args && args.toLowerCase() !== "show") {
      const [setting, value = ""] = args.match(/^(\S+)(?:\s+([\s\S]*))?$/u)!.slice(1);
      let patch: Partial<Pick<Settings, "focus" | "sources">>;
      if (setting.toLowerCase() === "focus") {
        if (!value || !validFocus(value)) throw new InputError("Use settings focus <text> (1–160 characters), or settings focus clear.");
        patch = { focus: value.toLowerCase() === "clear" ? "" : value };
      } else if (setting.toLowerCase() === "sources") {
        const categories = value.toLowerCase().split(",").map((part) => part.trim());
        const sources = value.toLowerCase() === "all" ? [...KINDS] : categories.map((part) => Object.hasOwn(ALIASES, part) ? ALIASES[part] : undefined);
        if (!sources.length || sources.some((kind) => kind === undefined) || new Set(sources).size !== sources.length) {
          throw new InputError("Choose unique comma-separated categories: reminders,follow-ups,goals,notes,events; or use settings sources all.");
        }
        patch = { sources: KINDS.filter((kind) => sources.includes(kind)) };
      } else throw new InputError("Use settings show, settings focus <text>, settings sources <categories>, or settings reset confirm.");
      const saved = await context.store.update<unknown, Settings>(KEY, defaults(), (current) => {
        const next = { ...settingsFrom(current), ...patch };
        checkSettingsBudget(next);
        return { value: next, result: next };
      });
      return showSettings(saved);
    }
    if ((action === "show" && !args) || (action === "settings" && (!args || args.toLowerCase() === "show"))) {
      const stored = await context.store.read<unknown>(KEY);
      return showSettings(stored === null ? defaults() : settingsFrom(stored));
    }
    if (action !== "brief") throw new InputError("Unknown command. Use brief [focus], show, settings, or help.");
    if (!validFocus(args)) throw new InputError("A one-off focus must be at most 160 characters. Use brief [focus].");
    if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) throw new InputError("The supplied current time is invalid; a briefing needs a valid runtime clock.");
    let dayFormat: Intl.DateTimeFormat, timeFormat: Intl.DateTimeFormat;
    try {
      if (typeof context.timezone !== "string" || !context.timezone || context.timezone.length > 100) throw new Error();
      dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: context.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
      timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: context.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" });
    } catch { throw new InputError("Your supplied timezone is invalid. Set a valid IANA timezone in personal preferences before running brief."); }
    const stored = await context.store.read<unknown>(KEY);
    const settings = stored === null ? defaults() : settingsFrom(stored);
    if (context.signal?.aborted) return "Brief cancelled. Saved settings were not changed.";
    let raw: unknown;
    try { raw = await readBoundedContext(context, settings.sources); }
    catch (error) {
      if (context.signal?.aborted) return "Brief cancelled. Saved settings were not changed.";
      return contextCapacityMessage(error, CAPACITY_RECOVERY) ?? "Could not load your personal sources. No brief was produced; try brief again. Missing data does not mean you have a clear day. Saved settings were not changed.";
    }
    if (context.signal?.aborted) return "Brief cancelled. Saved settings were not changed.";
    return renderBrief(raw, settings, args || settings.focus, context, dayFormat, timeFormat);
  } catch (error) {
    if (error instanceof InputError) return error.message;
    if (error instanceof SettingsError) return "Saved morning-brief settings are invalid or use an unsupported version. They were left untouched. Use settings reset confirm to erase them and restore defaults.";
    return "Morning brief could not access its settings or finish this request. Please try again; use show to check saved preferences.";
  }
}

export const feature: AgentFeature = {
  id: "morning-brief",
  title: "Personal morning briefing",
  description: "Rank personal commitments and imported events into a cited, timezone-aware day-ahead brief.",
  help: HELP,
  execute,
};

export default feature;
