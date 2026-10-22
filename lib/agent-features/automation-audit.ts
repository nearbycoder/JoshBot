import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";

const KEY = "audit";
const MAX_SNAPSHOTS = 8;
const MAX_SOURCES = 80;
const MAX_SUGGESTIONS = 160;
const MAX_DISMISSALS = 100;
// Admission leaves 29 KB for dismissals/lifecycle changes below the parent's 512 KB limit.
const REVIEW_BYTES = 450_000;
const STATE_BYTES = 479_000;
const DAY = 86_400_000;
const GRACE = 15 * 60_000;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RULES = ["overdue", "reported-failure", "stale", "unclear-purpose", "missing-timing", "metadata", "duplicate"] as const;
type Rule = typeof RULES[number];
type Kind = "reminder" | "monitor" | "digest";
type Status = "active" | "paused" | "disabled" | "completed" | "cancelled" | "unknown";
type Outcome = "success" | "failed" | "unknown";
type Source = {
  id: string; kind: Kind; title: string; purpose: string; schedule: string;
  timezone: string | null; destination: string; status: Status;
  nextRunAt: string | null; lastRunAt: string | null; updatedAt: string | null;
  outcome: Outcome; issues: string[];
};
type Suggestion = { id: string; rule: Rule; sourceIds: string[]; evidence: string; action: string };
type Snapshot = {
  id: string; at: string; timezone: string; sources: Source[]; suggestions: Suggestion[];
  skipped: number; omitted: number; omittedSuggestions: number;
};
type State = { version: 1; generation: string; snapshots: Snapshot[]; dismissals: { id: string; at: string }[] };

const HELP = `Personal automation review (private)
/nobo-help agent automation-audit review
history | show [snapshot-id|latest]
inspect <source-id> [snapshot-id|latest]
compare [older-snapshot-id newer-snapshot-id]
dismiss <suggestion-id>
clear confirm
Example: /nobo-help agent automation-audit inspect reminder:abc123
Review reads your permitted reminder, monitor and digest metadata. Other commands use saved snapshots. Suggestions explain evidence; they never edit or run jobs. Unknown run data is not a failure. Retains up to 8 reviews within a 450,000-byte UTF-8 admission budget and 100 dismissals; oldest reviews expire as needed. Space is reserved for later dismissals. clear confirm erases this feature's history and dismissals.`;

function empty(generation = "initial"): State {
  return { version: 1, generation, snapshots: [], dismissals: [] };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

function zone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}

// Reject local timestamps, impossible dates, and parser rollover instead of using server time.
function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, y, m, d, h, min, sec, offset] = parts;
  if (+y < 1000 || +m < 1 || +m > 12 || +d < 1 || +d > new Date(Date.UTC(+y, +m, 0)).getUTCDate()
    || +h > 23 || +min > 59 || +sec > 59) return null;
  if (offset !== "Z" && (+offset.slice(1, 3) > 14 || +offset.slice(4) > 59 || (+offset.slice(1, 3) === 14 && +offset.slice(4) !== 0))) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const normalized = new Date(ms).toISOString();
  return /^[1-9]\d{3}-/.test(normalized) ? normalized : null;
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && text(value, max) === value;
}

function validDate(value: unknown): boolean {
  return value === null || (typeof value === "string" && instant(value) === value);
}

function validSource(value: unknown): value is Source {
  if (!object(value)) return false;
  return typeof value.id === "string" && SOURCE_ID.test(value.id)
    && typeof value.kind === "string" && ["reminder", "monitor", "digest"].includes(value.kind)
    && bounded(value.title, 160) && bounded(value.purpose, 500) && bounded(value.schedule, 160)
    && (value.timezone === null || zone(value.timezone)) && bounded(value.destination, 120)
    && typeof value.status === "string" && ["active", "paused", "disabled", "completed", "cancelled", "unknown"].includes(value.status)
    && typeof value.outcome === "string" && ["success", "failed", "unknown"].includes(value.outcome)
    && validDate(value.nextRunAt) && validDate(value.lastRunAt) && validDate(value.updatedAt)
    && Array.isArray(value.issues) && value.issues.length <= 12 && value.issues.every(v => bounded(v, 180));
}

class InvalidState extends Error {}
class InvalidReview extends Error {}
class QuotaExceeded extends Error {}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function withinQuota(state: State): State {
  if (bytes(state) > STATE_BYTES) throw new QuotaExceeded("Audit storage exceeds its 479,000-byte UTF-8 limit. Use clear confirm to delete saved reviews and dismissals; existing jobs are unchanged.");
  return state;
}

function admitReview(state: State): State {
  let next = state;
  while (bytes(next) > REVIEW_BYTES && next.snapshots.length > 1) {
    next = { ...next, snapshots: next.snapshots.slice(0, -1) };
  }
  if (bytes(next) > REVIEW_BYTES) throw new QuotaExceeded("This review exceeds the 450,000-byte UTF-8 admission budget. Saved history and dismissals are unchanged. Ask the context adapter to return fewer or shorter automation records. clear confirm deletes saved audit data, but cannot make this single review smaller.");
  return next;
}

function storageNotice(state: State): string {
  return `Storage: ${bytes(state).toLocaleString("en-US")} UTF-8 bytes. New reviews fit within 450,000 bytes, reserving space for dismissals below the 479,000-byte state limit. Oldest reviews expire as needed; clear confirm deletes all audit history and dismissals.`;
}

function validateSnapshot(s: unknown): asserts s is Snapshot {
  if (!object(s) || typeof s.id !== "string" || !/^audit-[a-f0-9-]{36}$/.test(s.id)
    || typeof s.at !== "string" || instant(s.at) !== s.at || !zone(s.timezone)
    || !Array.isArray(s.sources) || s.sources.length > MAX_SOURCES || !s.sources.every(validSource)
    || new Set(s.sources.map(v => v.id)).size !== s.sources.length
    || !Array.isArray(s.suggestions) || s.suggestions.length > MAX_SUGGESTIONS
    || ![s.skipped, s.omitted, s.omittedSuggestions].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) throw new InvalidState();
  const ids = new Set(s.sources.map(v => v.id));
  for (const suggestion of s.suggestions) {
    if (!object(suggestion) || typeof suggestion.id !== "string" || !/^s-[a-f0-9]{20}$/.test(suggestion.id)
      || !RULES.includes(suggestion.rule as Rule) || !bounded(suggestion.evidence, 1200) || !bounded(suggestion.action, 400)
      || !Array.isArray(suggestion.sourceIds) || suggestion.sourceIds.length < 1 || suggestion.sourceIds.length > 2
      || !suggestion.sourceIds.every(id => typeof id === "string" && ids.has(id))
      || new Set(suggestion.sourceIds).size !== suggestion.sourceIds.length) throw new InvalidState();
  }
  if (new Set(s.suggestions.map(v => v.id)).size !== s.suggestions.length) throw new InvalidState();
}

function parseState(value: unknown): State {
  if (value === null) return empty();
  if (!object(value) || value.version !== 1 || !bounded(value.generation, 50) || !value.generation
    || !Array.isArray(value.snapshots) || value.snapshots.length > MAX_SNAPSHOTS
    || !Array.isArray(value.dismissals) || value.dismissals.length > MAX_DISMISSALS) throw new InvalidState();
  for (const snapshot of value.snapshots) validateSnapshot(snapshot);
  if (new Set(value.snapshots.map(v => v.id)).size !== value.snapshots.length) throw new InvalidState();
  for (const dismissal of value.dismissals) {
    if (!object(dismissal) || typeof dismissal.id !== "string" || !/^s-[a-f0-9]{20}$/.test(dismissal.id)
      || typeof dismissal.at !== "string" || instant(dismissal.at) !== dismissal.at) throw new InvalidState();
  }
  if (new Set(value.dismissals.map(d => d.id)).size !== value.dismissals.length) throw new InvalidState();
  // Copy only allowlisted properties, never retaining arbitrary persisted data.
  return withinQuota({
    version: 1, generation: value.generation,
    snapshots: (value.snapshots as Snapshot[]).map(s => ({
      id: s.id, at: s.at, timezone: s.timezone, skipped: s.skipped, omitted: s.omitted, omittedSuggestions: s.omittedSuggestions,
      sources: s.sources.map(r => ({ id: r.id, kind: r.kind, title: r.title, purpose: r.purpose, schedule: r.schedule,
        timezone: r.timezone, destination: r.destination, status: r.status, nextRunAt: r.nextRunAt,
        lastRunAt: r.lastRunAt, updatedAt: r.updatedAt, outcome: r.outcome, issues: [...r.issues] })),
      suggestions: s.suggestions.map(v => ({ id: v.id, rule: v.rule, sourceIds: [...v.sourceIds], evidence: v.evidence, action: v.action })),
    })).sort((a, b) => b.at.localeCompare(a.at)),
    dismissals: (value.dismissals as State["dismissals"]).map(d => ({ id: d.id, at: d.at })),
  });
}

function normalize(raw: unknown, now: number): Source | null {
  if (!object(raw) || typeof raw.id !== "string" || !SOURCE_ID.test(raw.id)
    || typeof raw.kind !== "string" || !["reminder", "monitor", "digest"].includes(raw.kind)
    || typeof raw.title !== "string" || typeof raw.text !== "string") return null;
  const m = object(raw.metadata) ? raw.metadata : {};
  const issues: string[] = [];
  const readText = (value: unknown, name: string, max: number): string => {
    if (value != null && typeof value !== "string") issues.push(`${name} is invalid; treated as unknown.`);
    if (typeof value === "string" && value.length > max) issues.push(`${name} was shortened to ${max} characters.`);
    return text(value, max);
  };
  const readDate = (value: unknown, name: string): string | null => {
    if (value == null || value === "") return null;
    const parsed = instant(value);
    if (!parsed) issues.push(`${name} is invalid; an ISO timestamp with an explicit offset is required.`);
    return parsed;
  };
  const nextRunAt = readDate(m.nextRunAt ?? raw.dueAt, "nextRunAt/dueAt");
  let lastRunAt = readDate(m.lastRunAt, "lastRunAt");
  let updatedAt = readDate(raw.updatedAt, "updatedAt");
  if (lastRunAt && Date.parse(lastRunAt) > now + GRACE) {
    issues.push("lastRunAt is in the future; run timing is unknown."); lastRunAt = null;
  }
  if (updatedAt && Date.parse(updatedAt) > now + GRACE) {
    issues.push("updatedAt is in the future; record age is unknown."); updatedAt = null;
  }
  const statuses: string[] = ["active", "paused", "disabled", "completed", "cancelled", "unknown"];
  const status = typeof raw.status === "string" && statuses.includes(raw.status) ? raw.status as Status : "unknown";
  if (raw.status != null && status === "unknown" && raw.status !== "unknown") issues.push("status is unrecognized; enabled state is unknown.");
  const outcomes: string[] = ["success", "failed", "unknown"];
  const outcome = typeof m.lastRunStatus === "string" && outcomes.includes(m.lastRunStatus) ? m.lastRunStatus as Outcome : "unknown";
  if (m.lastRunStatus != null && outcome === "unknown" && m.lastRunStatus !== "unknown") issues.push("lastRunStatus is unrecognized; outcome is unknown.");
  const timezone = zone(m.timezone) ? m.timezone : null;
  if (m.timezone != null && !timezone) issues.push("Schedule timezone is invalid; timezone is unknown.");
  const purpose = readText(m.purpose, "purpose", 500) || text(raw.text, 500) || text(raw.title, 500);
  const schedule = readText(m.schedule, "schedule", 160);
  const destination = readText(m.destination, "destination", 120);
  return { id: raw.id, kind: raw.kind as Kind, title: text(raw.title, 160), purpose, schedule, timezone, destination,
    status, nextRunAt, lastRunAt, updatedAt, outcome, issues: issues.slice(0, 12) };
}

function active(source: Source): boolean { return source.status === "active" || source.status === "unknown"; }
function folded(value: string): string { return value.toLowerCase().replace(/\s+/g, " ").trim(); }
function unclear(source: Source): boolean {
  return source.purpose.length < 8 || /^(?:(?:my|daily|weekly) )?(?:reminder|monitor|digest|task|test|update|updates|check|news)(?: \d+)?[.!]?$/.test(folded(source.purpose));
}

function suggestion(rule: Rule, sources: Source[], evidence: string, action: string, identity: unknown): Suggestion {
  const sourceIds = sources.map(s => s.id).sort();
  const id = `s-${createHash("sha256").update(JSON.stringify([rule, sourceIds, identity])).digest("hex").slice(0, 20)}`;
  return { id, rule, sourceIds, evidence, action };
}

function audit(sources: Source[], now: number): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const r of sources) {
    if (active(r) && r.nextRunAt && Date.parse(r.nextRunAt) < now - GRACE) {
      suggestions.push(suggestion("overdue", [r], `Listed next occurrence ${r.nextRunAt} is over 15 minutes past due; status is ${r.status}. This does not prove a failed run.`,
        "Check the original job's enabled state and execution record; decide whether its next occurrence needs updating there.", [r.nextRunAt, r.status]));
    }
    if (r.outcome === "failed") {
      suggestions.push(suggestion("reported-failure", [r], `Metadata explicitly reports the last run as failed (${r.lastRunAt ?? "time unknown"}); current status is ${r.status}.`,
        "Inspect that run in the original tool before deciding to retry or change the job.", [r.lastRunAt, r.outcome, r.status]));
    }
    if (r.updatedAt && Date.parse(r.updatedAt) <= now - 90 * DAY) {
      suggestions.push(suggestion("stale", [r], `The record was last edited ${r.updatedAt}, at least 90 days ago. Record age does not indicate whether it has run.`,
        "Confirm this automation still serves your current priorities; consider updating its purpose or retiring it in the original tool.", [r.updatedAt, r.purpose]));
    }
    if (unclear(r)) {
      suggestions.push(suggestion("unclear-purpose", [r], `Purpose is missing, shorter than 8 characters, or a generic label: ${r.purpose || "(empty)"}.`,
        "Give the original job a specific purpose: what it watches or reminds you about, and what action the result supports.", r.purpose));
    }
    if (active(r) && !r.nextRunAt) {
      suggestions.push(suggestion("missing-timing", [r], "No valid next occurrence was supplied. Upcoming and overdue timing cannot be checked.",
        "Check the original schedule or ask for its next-occurrence metadata to be included in personal context.", [r.status, r.schedule]));
    }
    if (r.issues.length) {
      suggestions.push(suggestion("metadata", [r], r.issues.join(" "), "Verify these fields in the source or its context adapter before relying on them.", r.issues));
    }
  }
  for (let a = 0; a < sources.length; a++) {
    for (let b = a + 1; b < sources.length; b++) {
      const x = sources[a], y = sources[b];
      if (!active(x) || !active(y) || unclear(x) || unclear(y) || x.kind !== y.kind
        || folded(x.purpose) !== folded(y.purpose) || !x.schedule || folded(x.schedule) !== folded(y.schedule)
        || (x.destination && y.destination && x.destination !== y.destination)) continue;
      const sameZone = x.timezone && x.timezone === y.timezone;
      const sameOccurrence = x.nextRunAt && x.nextRunAt === y.nextRunAt;
      if (!sameZone && !sameOccurrence) continue;
      const evidence = `Both ${x.kind} records have the same normalized purpose and schedule label (${x.schedule}); ${sameZone ? `schedule timezone matches (${x.timezone})` : `next occurrence matches (${x.nextRunAt}), but schedule timezones are not confirmed equal`}. ${x.destination && y.destination ? "Destinations match." : "At least one destination is unknown."} This is a duplicate candidate, not proof.`;
      suggestions.push(suggestion("duplicate", [x, y], evidence,
        "Compare both source IDs, destinations and recurrence details; keep both if they serve distinct needs, or consolidate in the original tool.",
        [folded(x.purpose), folded(x.schedule), x.timezone, y.timezone, x.destination, y.destination, sameZone ? null : x.nextRunAt]));
    }
  }
  return suggestions.sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule) || a.id.localeCompare(b.id));
}

function when(value: string | null, timezone: string): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).format(new Date(value));
}

function chosen(state: State, id = "latest"): Snapshot | undefined {
  return id === "latest" ? state.snapshots[0] : state.snapshots.find(s => s.id === id);
}

function coverage(s: Snapshot): string {
  return `Coverage: ${s.sources.length} sources; ${s.skipped} invalid/ambiguous entries skipped; ${s.omitted} entries beyond the input cap; ${s.omittedSuggestions} suggestions beyond the saved cap. This is permitted context, not a production inventory.`;
}

function renderSuggestion(s: Suggestion, dismissed: Set<string>): string {
  return `${s.id} [${s.rule}${dismissed.has(s.id) ? "; dismissed" : ""}] sources: ${s.sourceIds.join(", ")}\nEvidence: ${s.evidence}\nRecommendation: ${s.action}`;
}

function renderSnapshot(s: Snapshot, state: State, full: boolean): string[] {
  const dismissed = new Set(state.dismissals.map(d => d.id));
  const open = s.suggestions.filter(v => !dismissed.has(v.id));
  const upcoming = s.sources.filter(r => active(r) && r.nextRunAt && Date.parse(r.nextRunAt) >= Date.parse(s.at)
    && Date.parse(r.nextRunAt) <= Date.parse(s.at) + 7 * DAY).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  const recent = s.sources.filter(r => active(r) && r.nextRunAt && Date.parse(r.nextRunAt) < Date.parse(s.at)
    && Date.parse(r.nextRunAt) >= Date.parse(s.at) - GRACE);
  const visible = full ? s.suggestions : open.slice(0, 12);
  return [
    `Personal automation review ${s.id}`, `Captured ${when(s.at, s.timezone)} (${s.timezone}). Read-only snapshot.`, storageNotice(state), coverage(s),
    `Run outcomes: ${s.sources.filter(r => r.outcome === "failed").length} reported failed; ${s.sources.filter(r => r.outcome === "success").length} reported successful; ${s.sources.filter(r => r.outcome === "unknown").length} unknown. Unknown is not a failure.`,
    `Upcoming: next known occurrence within 7 days (${upcoming.length}; ${recent.length} recently due within the 15-minute grace period). Recurrences are not expanded.`,
    ...upcoming.slice(0, full ? MAX_SOURCES : 12).map(r => `${r.id} — ${r.title || r.kind}: ${when(r.nextRunAt, s.timezone)}; enabled state ${r.status}`),
    ...(upcoming.length ? [] : ["No upcoming occurrence supplied in this window. Inspect a source for later or unknown timing."]),
    `Recommendations: ${open.length} open; ${s.suggestions.length - open.length} dismissed.`,
    ...visible.map(v => renderSuggestion(v, dismissed)),
    ...(open.length > 12 && !full ? [`Showing 12 open recommendations; show ${s.id} lists all saved suggestions, including dismissed ones.`] : []),
    ...(s.sources.length ? [`Source IDs: ${s.sources.map(r => r.id).join(", ")}`] : ["No eligible automations were returned. Create a reminder, monitor or digest in the existing tool, or check that the parent context adapter supplies your owned metadata."]),
    "Use inspect <source-id> for saved evidence, compare for changes, or dismiss <suggestion-id> to hide a recommendation. No jobs were changed.",
  ];
}

function inspect(s: Snapshot, r: Source, state: State): string[] {
  const dismissed = new Set(state.dismissals.map(d => d.id));
  return [`${r.id} — ${r.title || r.kind} (${r.kind})`, `Snapshot ${s.id}, captured ${when(s.at, s.timezone)} (${s.timezone}).`,
    `Purpose: ${r.purpose || "unknown"}`, `Status: ${r.status}; schedule: ${r.schedule || "unknown"}; schedule timezone: ${r.timezone ?? "unknown"}`,
    `Destination: ${r.destination || "unknown"}`, `Next occurrence: ${when(r.nextRunAt, s.timezone)}`,
    `Last reported run: ${when(r.lastRunAt, s.timezone)}; outcome: ${r.outcome}${r.outcome === "unknown" ? " (not a failure)" : ""}`,
    `Last record edit: ${when(r.updatedAt, s.timezone)} (not evidence of execution).`,
    ...r.issues.map(issue => `Metadata warning: ${issue}`),
    ...s.suggestions.filter(v => v.sourceIds.includes(r.id)).map(v => renderSuggestion(v, dismissed)),
    "This is saved evidence. Run review to refresh; use the original tool for any job changes."];
}

const COMPARED_FIELDS = ["title", "purpose", "schedule", "timezone", "destination", "status", "nextRunAt", "lastRunAt", "updatedAt", "outcome"] as const;
function compare(old: Snapshot, recent: Snapshot, state: State): string[] {
  const before = new Map(old.sources.map(r => [r.id, r]));
  const after = new Map(recent.sources.map(r => [r.id, r]));
  const lines: string[] = [];
  for (const r of recent.sources) {
    const previous = before.get(r.id);
    if (!previous) { lines.push(`Newly observed: ${r.id} — ${r.title}`); continue; }
    const changes = COMPARED_FIELDS.filter(key => previous[key] !== r[key]);
    if (previous.kind !== r.kind) lines.push(`Changed ${r.id}: kind ${previous.kind} → ${r.kind}`);
    for (const field of changes) lines.push(`Changed ${r.id}: ${field}: ${previous[field] ?? "unknown"} → ${r[field] ?? "unknown"}`);
    if (JSON.stringify(previous.issues) !== JSON.stringify(r.issues)) lines.push(`Changed ${r.id}: metadata warnings: ${previous.issues.join(" ") || "none"} → ${r.issues.join(" ") || "none"}`);
  }
  for (const r of old.sources) if (!after.has(r.id)) lines.push(`No longer observed: ${r.id} — ${r.title} (not proof it was deleted).`);
  const oldIds = new Set(old.suggestions.map(s => s.id)), newIds = new Set(recent.suggestions.map(s => s.id));
  const dismissed = new Set(state.dismissals.map(d => d.id));
  const added = recent.suggestions.filter(s => !oldIds.has(s.id)), gone = old.suggestions.filter(s => !newIds.has(s.id));
  return [`Compare ${old.id} → ${recent.id}`, `Captured ${old.at} → ${recent.at}; timestamps below use explicit UTC offsets.`,
    `Earlier ${coverage(old)}`, `Later ${coverage(recent)}`,
    ...(lines.length ? lines : ["No source metadata changes observed."]),
    `Suggestion changes: ${added.length} newly observed; ${gone.length} no longer observed.`,
    ...added.map(s => `New: ${renderSuggestion(s, dismissed)}`),
    ...gone.map(s => `No longer observed: ${s.id} [${s.rule}] sources: ${s.sourceIds.join(", ")}.`),
    "A missing source or suggestion can reflect changed metadata, context coverage, or retention caps; it does not prove resolution. Dismissals only affect this review workspace."];
}

function output(lines: string[]): string {
  // Escape Slack mentions/links in untrusted labels; bound every response, including expanded history.
  const escaped = lines.map(line => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  let result = "";
  for (const line of escaped) {
    if (result.length + line.length + 1 > 26_500) return `${result}\nOutput shortened. Use inspect <source-id> with the snapshot ID for individual evidence.`;
    result += `${result ? "\n" : ""}${line}`;
  }
  return result;
}

async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  if (typeof command !== "string" || command.length > 512) return "Command must be text, at most 512 characters. Use help for syntax.";
  const [verb = "help", ...args] = command.trim().split(/\s+/).filter(Boolean);
  if (verb === "help" && !args.length) return output([HELP]);
  const expected: Record<string, number[]> = { review: [0], history: [0], show: [0, 1], inspect: [1, 2], compare: [0, 2], dismiss: [1], clear: [1] };
  if (!Object.hasOwn(expected, verb) || !expected[verb].includes(args.length)) return output(["Unknown command or invalid arguments.", HELP]);
  if (verb === "clear" && args[0] !== "confirm") return "Use clear confirm to erase only audit snapshots and dismissals. Existing jobs are unchanged.";
  if (args.some(arg => !SOURCE_ID.test(arg))) return "Invalid ID. Copy an exact source, snapshot, or suggestion ID from review/history.";
  if ((verb === "review" || verb === "dismiss") && (!Number.isFinite(ctx.now.getTime()) || !zone(ctx.timezone))) return "A valid current time and IANA timezone must be supplied by the runtime; no server-local fallback is used.";
  try {
    if (verb === "clear") {
      const reset = empty(randomUUID());
      await ctx.store.update<unknown, void>(KEY, empty(), () => ({ value: reset, result: undefined }));
      return "Cleared automation review snapshots and dismissals. Existing jobs are unchanged.";
    }
    const state = parseState(await ctx.store.read<unknown>(KEY));
    if (verb === "review") {
      const id = `audit-${randomUUID()}`, now = ctx.now.getTime(), at = new Date(now).toISOString(), timezone = ctx.timezone;
      if (ctx.signal?.aborted) return "Review cancelled; saved history is unchanged.";
      let raw: unknown;
      try { raw = await ctx.services.readContext(["reminder", "monitor", "digest"]); }
      catch { return "Could not read your automation metadata. Saved history and dismissals are unchanged; try review again later."; }
      if (!Array.isArray(raw)) return "Automation context was invalid. Saved history is unchanged; ask for the context adapter to be checked.";
      if (ctx.signal?.aborted) return "Review cancelled; saved history is unchanged.";
      // Ambiguous IDs are excluded completely; never silently choose one job over another.
      const candidates = raw.slice(0, MAX_SOURCES).map(r => normalize(r, now));
      const counts = new Map<string, number>();
      for (const r of candidates) if (r) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
      const sources = candidates.filter((r): r is Source => r !== null && counts.get(r.id) === 1).sort((a, b) => a.id.localeCompare(b.id));
      const allSuggestions = audit(sources, now);
      const snapshot: Snapshot = { id, at, timezone, sources, suggestions: allSuggestions.slice(0, MAX_SUGGESTIONS),
        skipped: candidates.length - sources.length, omitted: Math.max(0, raw.length - MAX_SOURCES), omittedSuggestions: Math.max(0, allSuggestions.length - MAX_SUGGESTIONS) };
      // New evidence must satisfy the exact schema used when reading saved history.
      try { validateSnapshot(snapshot); }
      catch (error) { if (error instanceof InvalidState) throw new InvalidReview(); throw error; }
      const saved = await ctx.store.update<unknown, { state: State; removed: number } | null>(KEY, empty(), current => {
        const latest = parseState(current);
        if (latest.generation !== state.generation || (latest.snapshots[0] && latest.snapshots[0].at > at)) return { value: latest, result: null };
        const next = admitReview({ ...latest, snapshots: [snapshot, ...latest.snapshots].slice(0, MAX_SNAPSHOTS) });
        return { value: next, result: { state: next, removed: latest.snapshots.length + 1 - next.snapshots.length } };
      });
      return saved ? output([
        ...(saved.removed ? [`Retention removed ${saved.removed} oldest saved review(s) to stay within the history count/UTF-8 quota.`] : []),
        ...renderSnapshot(snapshot, saved.state, false),
      ]) : "This review was superseded by a newer review or a history clear. It was not saved; run review again for fresh evidence.";
    }
    if (verb === "history") return output(state.snapshots.length ? ["Saved automation reviews (newest first):", storageNotice(state), ...state.snapshots.map(s => `${s.id} — ${when(s.at, s.timezone)} (${s.timezone}); ${s.sources.length} sources; ${s.suggestions.length} saved suggestions.`)] : ["No saved reviews. Run review to read your permitted automation metadata."]);
    if (verb === "dismiss") {
      const at = ctx.now.toISOString();
      return await ctx.store.update<unknown, string>(KEY, empty(), current => {
        const latest = parseState(current);
        if (!latest.snapshots.some(s => s.suggestions.some(v => v.id === args[0]))) return { value: latest, result: "Suggestion not found in retained history. Copy a suggestion ID from review or show." };
        if (latest.dismissals.some(d => d.id === args[0])) return { value: latest, result: `Suggestion ${args[0]} is already dismissed.` };
        return { value: withinQuota({ ...latest, dismissals: [...latest.dismissals, { id: args[0], at }].slice(-MAX_DISMISSALS) }),
          result: `Dismissed ${args[0]} in this review workspace. Jobs are unchanged. Materially changed evidence may create a new suggestion; show includes dismissed evidence.` };
      });
    }
    if (verb === "compare") {
      const older = args.length ? chosen(state, args[0]) : state.snapshots[1];
      const newer = args.length ? chosen(state, args[1]) : state.snapshots[0];
      if (!older || !newer) return "Compare needs two retained snapshots. Run review twice, then compare; use history for exact IDs.";
      if (older.id === newer.id || older.at > newer.at) return "Choose distinct snapshots in older-then-newer order. Use history to see their dates.";
      return output(compare(older, newer, state));
    }
    const snapshot = chosen(state, verb === "inspect" ? args[1] : args[0]);
    if (!snapshot) return "Saved snapshot not found. Run review first, or use history for retained snapshot IDs.";
    if (verb === "inspect") {
      const source = snapshot.sources.find(r => r.id === args[0]);
      return source ? output(inspect(snapshot, source, state)) : "Source not found in that snapshot. Copy a source ID from show; run review to refresh permitted context.";
    }
    return output(renderSnapshot(snapshot, state, true));
  } catch (error) {
    if (error instanceof QuotaExceeded) return error.message;
    if (error instanceof InvalidReview) return "New review data could not be validated; saved history and dismissals were left unchanged. Check the supplied metadata and capture time, then retry review.";
    return error instanceof InvalidState
      ? "Saved audit data could not be validated and was left unchanged. Use clear confirm to explicitly reset audit history and dismissals; jobs are unaffected."
      : "Could not load or save the automation review. Try again later; existing jobs were not changed.";
  }
}

export const feature: AgentFeature = {
  id: "automation-audit",
  title: "Personal automation review",
  description: "Privately review automation timing, purpose, duplicate candidates and changes over time, with source evidence.",
  help: HELP,
  execute,
};

export default feature;
