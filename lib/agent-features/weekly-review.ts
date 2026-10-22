import { randomUUID } from "node:crypto";
import type { AgentContextKind, AgentFeature, AgentFeatureContext } from "./types.js";

const KEY = "reviews";
const KINDS = ["goal", "habit", "journal", "follow-up", "note"] as const;
type Kind = typeof KINDS[number];
const MAX_HISTORY = 12;
const PER_KIND = 5;
const MAX_FINDINGS = 6;
const SNAPSHOT_BYTE_LIMIT = 400_000;
const STATE_BYTE_LIMIT = 480_000;
const SECTION_KEYS = ["completed", "stalled", "activity", "patterns", "next"] as const;
type Section = typeof SECTION_KEYS[number];
type Finding = { text: string; refs: string[] };
type Source = { ref: string; id: string; kind: Kind; title: string; excerpt: string };
type Review = {
  id: string;
  createdAt: string;
  start: string;
  end: string;
  timezone: string;
  sources: Source[];
  sections: Record<Section, Finding[]>;
  warnings: string[];
  reflection?: { text: string; updatedAt: string };
};
type State = { version: 1; reviews: Review[] };
type RecordData = Omit<Source, "ref"> & {
  updated?: string;
  updatedOrder: string;
  created?: string;
  due?: string;
  completed?: string;
  day?: string;
  status: string;
  days?: string[];
  target?: number;
  current?: number;
  history: { day: string; at: string; value: number }[];
  wins?: string;
  mood?: number;
};
class ReviewError extends Error {}
const emptyState = (): State => ({ version: 1, reviews: [] });
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const snapshotBytes = (state: State) => jsonBytes({ ...state, reviews: state.reviews.map(({ reflection: _reflection, ...snapshot }) => snapshot) });

function checkWriteQuota(state: State, addingReview = false): State {
  // Reserve 80 KB beyond the snapshot budget. Even JSON's worst case of six
  // bytes per reflection character leaves room for all 12 reflections and
  // their lifecycle metadata. Measure the complete serialized value on writes.
  if (jsonBytes(state) >= STATE_BYTE_LIMIT || (addingReview && snapshotBytes(state) >= SNAPSHOT_BYTE_LIMIT)) {
    throw new ReviewError("Weekly-review storage quota reached (400,000 UTF-8 bytes for snapshots; below 480,000 total). No changes were made. Use history, show <id> to copy a review, then delete <id> confirm and retry.");
  }
  return state;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const compact = (s: string, max: number) => s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// Escape Slack markup/mentions, then bound the rendered field as well as its stored value.
const display = (s: string, max: number) => {
  const escaped = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 1)}…`;
};
const isKind = (v: unknown): v is Kind => KINDS.includes(v as Kind);
const sourceId = (v: unknown): v is string => string(v, 128) && /^[^\s<>&\x00-\x1f\x7f]+$/.test(v);
const reviewId = (v: unknown): v is string => typeof v === "string" && /^wr-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);

function validDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.startsWith("0000")) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
}

function validInstant(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const match = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[5] !== "Z" && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(v));
}

function formatter(timezone: string) {
  try {
    if (!timezone || timezone.length > 100) throw new Error();
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw new ReviewError("A valid timezone is required. Set your timezone in NoBo preferences, then retry.");
  }
}

function localDay(date: Date, format: Intl.DateTimeFormat): string {
  const parts = format.formatToParts(date);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

function shiftDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function validateState(value: unknown): State {
  if (value === null) return emptyState();
  const bad = () => { throw new ReviewError("Saved weekly-review data could not be validated. No changes were made; ask the maintainer to inspect this feature's scoped reviews record."); };
  if (!object(value) || value.version !== 1 || !Array.isArray(value.reviews) || value.reviews.length > MAX_HISTORY) return bad();
  const ids = new Set<string>();
  for (const r of value.reviews) {
    if (!object(r) || !reviewId(r.id) || ids.has(r.id) || !validInstant(r.createdAt) || !validDay(r.start) || !validDay(r.end) || shiftDay(r.start, 6) !== r.end || !string(r.timezone, 100)) return bad();
    try { formatter(r.timezone); } catch { return bad(); }
    ids.add(r.id);
    if (!Array.isArray(r.sources) || r.sources.length > KINDS.length * PER_KIND || !object(r.sections) || !Array.isArray(r.warnings) || r.warnings.length > 8 || r.warnings.some((s) => !string(s, 250))) return bad();
    const refs = new Set<string>();
    const origins = new Set<string>();
    for (const s of r.sources) {
      if (!object(s) || typeof s.ref !== "string" || !/^S([1-9]|1\d|2[0-5])$/.test(s.ref) || refs.has(s.ref) || !sourceId(s.id) || !isKind(s.kind) || !string(s.title, 96) || !string(s.excerpt, 200)) return bad();
      const origin = `${s.kind}:${s.id}`;
      if (origins.has(origin)) return bad();
      refs.add(s.ref);
      origins.add(origin);
    }
    for (const key of SECTION_KEYS) {
      const findings = r.sections[key];
      if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return bad();
      for (const f of findings) {
        if (!object(f) || !string(f.text, 260) || !f.text || !Array.isArray(f.refs) || f.refs.length < 1 || f.refs.length > 5 || f.refs.some((ref) => typeof ref !== "string" || !refs.has(ref))) return bad();
      }
    }
    if (r.reflection !== undefined && (!object(r.reflection) || !string(r.reflection.text, 1000) || !r.reflection.text.trim() || !validInstant(r.reflection.updatedAt))) return bad();
  }
  // Reject extra fields too, rather than preserving arbitrarily large unknown JSON.
  const allowed = (obj: Record<string, unknown>, keys: string[]) => Object.keys(obj).every((key) => keys.includes(key));
  if (!allowed(value, ["version", "reviews"])) return bad();
  for (const r of value.reviews as Record<string, unknown>[]) {
    if (!allowed(r, ["id", "createdAt", "start", "end", "timezone", "sources", "sections", "warnings", "reflection"]) || !allowed(r.sections as Record<string, unknown>, [...SECTION_KEYS])) return bad();
    for (const s of r.sources as Record<string, unknown>[]) if (!allowed(s, ["ref", "id", "kind", "title", "excerpt"])) return bad();
    for (const findings of Object.values(r.sections as Record<string, Record<string, unknown>[]>)) for (const f of findings) if (!allowed(f, ["text", "refs"])) return bad();
    if (r.reflection && !allowed(r.reflection as Record<string, unknown>, ["text", "updatedAt"])) return bad();
  }
  return value as State;
}

function normalize(raw: unknown[], format: Intl.DateTimeFormat): { rows: RecordData[]; ignored: number } {
  const rows: RecordData[] = [];
  let ignored = Math.max(0, raw.length - 1000);
  const seen = new Set<string>();
  const day = (v: unknown) => validDay(v) ? v : validInstant(v) ? localDay(new Date(v), format) : undefined;
  const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000_000 ? v : undefined;
  for (const item of raw.slice(0, 1000)) {
    if (!object(item) || !isKind(item.kind)) { ignored++; continue; }
    if (!sourceId(item.id) || !string(item.title, 10_000) || !string(item.text, 100_000) || (item.status !== undefined && !string(item.status, 100)) || (item.metadata !== undefined && !object(item.metadata))) { ignored++; continue; }
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) { ignored++; continue; }
    seen.add(key);
    const m = object(item.metadata) ? item.metadata : {};
    const dates = [item.updatedAt, item.dueAt, m.createdAt, m.completedAt, m.day];
    if (dates.some((v) => v !== undefined && !day(v))) { ignored++; continue; }
    const row: RecordData = {
      id: item.id, kind: item.kind, title: compact(item.title, 96) || "Untitled",
      excerpt: compact(item.text, 200), status: (item.status ?? "").trim().toLowerCase(),
      updated: day(item.updatedAt), created: day(m.createdAt), due: day(item.dueAt),
      updatedOrder: validInstant(item.updatedAt) ? new Date(item.updatedAt).toISOString() : day(item.updatedAt) ?? "",
      completed: day(m.completedAt), day: day(m.day), history: [],
      target: numeric(m.target), current: numeric(m.current),
    };
    if (item.kind === "habit") {
      if (m.days !== undefined) {
        if (!Array.isArray(m.days) || m.days.length > 366 || m.days.some((d) => !validDay(d))) { ignored++; continue; }
        row.days = [...new Set(m.days as string[])].sort();
      }
      if (!row.target || !Number.isInteger(row.target) || row.target > 7) row.target = undefined;
    }
    if (item.kind === "goal" && m.history !== undefined) {
      if (!Array.isArray(m.history) || m.history.length > 366) { ignored++; continue; }
      for (const h of m.history) {
        if (!object(h) || !day(h.at) || numeric(h.value) === undefined) { ignored++; continue; }
        const at = validInstant(h.at) ? new Date(h.at).toISOString() : `${h.at}T00:00:00.000Z`;
        row.history.push({ day: day(h.at)!, at, value: h.value as number });
      }
      row.history.sort((a, b) => a.at.localeCompare(b.at));
    }
    if (item.kind === "journal") {
      row.day ??= row.updated;
      if (typeof m.wins === "string") row.wins = compact(m.wins, 150) || undefined;
      if (typeof m.mood === "number" && Number.isInteger(m.mood) && m.mood >= 1 && m.mood <= 5) row.mood = m.mood;
    }
    rows.push(row);
  }
  return { rows, ignored };
}

const DONE = new Set(["done", "completed", "complete", "achieved", "reached"]);
const OPEN = new Set(["open", "active", "in-progress", "in_progress", "pending", "todo", "blocked", "stalled"]);
const INACTIVE = new Set(["archived", "cancelled", "canceled", "deleted", "paused"]);
function openCommitment(row: RecordData) {
  if (row.kind !== "goal" && row.kind !== "follow-up") return false;
  if (row.status) return OPEN.has(row.status);
  return row.kind === "goal" && row.target !== undefined && row.current !== undefined && row.current < row.target;
}

function synthesize(rows: RecordData[], start: string, end: string) {
  const inside = (day?: string) => !!day && day >= start && day <= end;
  const lastUpdate = (r: RecordData) => [r.updated ?? "", ...r.history.filter((h) => h.day <= end).map((h) => h.day)].sort().at(-1)!;
  const completed = (r: RecordData) => (r.kind === "goal" || r.kind === "follow-up") && DONE.has(r.status) && inside(r.completed);
  const stalled = (r: RecordData) => openCommitment(r) && !!r.updated && r.updated <= end && ((!!r.due && r.due < end) || lastUpdate(r) < start || r.status === "blocked" || r.status === "stalled");
  const eligible = (r: RecordData) => {
    if (INACTIVE.has(r.status)) return false;
    if (r.kind === "journal") return inside(r.day);
    if (r.kind === "habit") return r.days?.some((d) => inside(d)) || (r.days !== undefined && (r.created ?? r.updated ?? "9999-12-31") <= end) || inside(r.updated);
    return completed(r) || stalled(r) || inside(r.updated) || r.history.some((h) => inside(h.day));
  };
  const rank = (r: RecordData) => completed(r) ? 0 : stalled(r) ? 1 : 2;
  const candidates = rows.filter(eligible).sort((a, b) => rank(a) - rank(b) || (b.day ?? b.updated ?? "").localeCompare(a.day ?? a.updated ?? "") || b.updatedOrder.localeCompare(a.updatedOrder) || a.id.localeCompare(b.id));
  const selected = KINDS.flatMap((kind) => candidates.filter((row) => row.kind === kind).slice(0, PER_KIND));
  const sources: Source[] = selected.map((r, i) => ({ ref: `S${i + 1}`, id: r.id, kind: r.kind, title: r.title, excerpt: r.excerpt }));
  const sections: Record<Section, Finding[]> = { completed: [], stalled: [], activity: [], patterns: [], next: [] };
  const add = (section: Section, text: string, refs: string[]) => {
    if (sections[section].length < MAX_FINDINGS) sections[section].push({ text: compact(text, 260), refs: refs.slice(0, 5) });
  };
  const moods = new Map<string, { mood: number; ref: string }>();
  const themes = new Map<string, { refs: string[]; kinds: Set<Kind> }>();
  const stopwords = new Set("about after again before being could every first from have into just like more next note notes only other over personal review should some source task tasks than that their them then there these they this through time today week weekly were what when which while will with work would your wins lessons".split(" "));
  for (let i = 0; i < selected.length; i++) {
    const r = selected[i], ref = sources[i].ref;
    if (completed(r)) add("completed", `${r.title}: recorded completed ${r.completed}.`, [ref]);
    if (r.kind === "journal" && r.wins) add("completed", `${r.day} journal-reported win: “${r.wins}”`, [ref]);
    if (stalled(r)) {
      const reason = r.due && r.due < end ? `still open; due ${r.due}` : r.status === "blocked" || r.status === "stalled" ? `marked ${r.status}` : `no recorded update in this window; last update ${lastUpdate(r)}`;
      add("stalled", `${r.title}: ${reason}. This flags a commitment to check, not proof that no work happened.`, [ref]);
      add("next", `Consider one small next action for “${r.title}”, or explicitly revise its scope/date.`, [ref]);
    }
    if (r.kind === "habit" && r.days) {
      const days = r.days.filter((d) => inside(d));
      add("patterns", `${r.title}: ${days.length} distinct recorded check-in day(s)${r.target ? ` / ${r.target} current weekly target` : ""}; ${days.length ? days.join(", ") : "none recorded"}. Missing records do not establish missed habits.`, [ref]);
      if (r.target && days.length < r.target) add("next", `Consider choosing ${r.target} realistic check-in dates next week for “${r.title}”; this window has ${days.length} recorded.`, [ref]);
    }
    const progress = r.history.filter((h) => inside(h.day));
    if (progress.length) {
      const last = progress[progress.length - 1];
      add("activity", `${r.title}: latest recorded progress ${last.value}${r.target ? ` / ${r.target} current target` : ""} on ${last.day} (${progress.length} check-in(s) in this window).`, [ref]);
      if (!stalled(r) && !completed(r)) add("next", `Consider defining the next measurable checkpoint for “${r.title}” from its recorded progress.`, [ref]);
    }
    if ((r.kind === "journal" && inside(r.day)) || (inside(r.updated) && !completed(r) && !progress.length && !(r.kind === "habit" && r.days))) {
      const status = DONE.has(r.status) && !r.completed ? "; currently marked complete, completion date unavailable" : "";
      add("activity", `${r.title} (${r.kind}, ${r.kind === "journal" ? r.day : r.updated})${status}: “${r.excerpt || "No excerpt supplied"}”`, [ref]);
    }
    if (r.kind === "journal" && r.day && r.mood !== undefined && !moods.has(r.day)) moods.set(r.day, { mood: r.mood, ref });
    const words = new Set(`${r.title} ${r.excerpt}`.toLowerCase().match(/[a-z]{4,24}/g) ?? []);
    for (const word of words) {
      if (stopwords.has(word)) continue;
      const theme = themes.get(word) ?? { refs: [], kinds: new Set<Kind>() };
      // Put one reference from each kind first, so a capped citation list still
      // supports every category named by the cross-source observation.
      if (theme.kinds.has(r.kind)) theme.refs.push(ref);
      else theme.refs.unshift(ref);
      theme.kinds.add(r.kind); themes.set(word, theme);
    }
  }
  if (moods.size) {
    const values = [...moods.values()];
    // Reserve space for cross-source observations even when five habits were selected.
    if (sections.patterns.length >= 4) sections.patterns = sections.patterns.slice(0, 3);
    add("patterns", `Journal mood: ${(values.reduce((sum, v) => sum + v.mood, 0) / values.length).toFixed(1)}/5 across ${values.length} recorded day(s). This describes recorded days only.`, values.map((v) => v.ref));
  }
  const repeated = [...themes].filter(([, t]) => t.kinds.size >= 2).sort((a, b) => b[1].refs.length - a[1].refs.length || a[0].localeCompare(b[0])).slice(0, 2);
  for (const [word, theme] of repeated) {
    add("patterns", `Repeated topic “${word}” appears across ${[...theme.kinds].join(", ")}. This is word overlap, not a causal conclusion.`, theme.refs);
    add("next", `Consider turning the repeated topic “${word}” into one concrete next-week priority.`, theme.refs);
  }
  if (!sections.next.length && sources.length) add("next", "Consider choosing one recorded win, lesson or commitment to carry into next week; add your own reflection with reflect.", [sources[0].ref]);
  return { sources, sections, omitted: candidates.length - selected.length };
}

function render(review: Review): string {
  const labels: Record<Section, string> = { completed: "Completed work / reported wins", stalled: "Stalled commitments to check", activity: "Other recorded activity", patterns: "Patterns in the selected sources", next: "Next-week suggestions (not actions taken)" };
  const empty: Record<Section, string> = { completed: "No explicitly dated completions or journal wins found.", stalled: "No open overdue, blocked or inactive commitments found in the selected records.", activity: "No other dated activity found.", patterns: "Not enough dated or repeated evidence to identify a pattern.", next: "Add dated goals, habit check-ins, journal entries, follow-ups or notes, then run review again." };
  const lines = [`Weekly personal review ${review.start} – ${review.end} (${review.timezone})`, `ID: ${review.id}`, `Saved: ${review.createdAt}`, `Coverage: ${KINDS.map((k) => `${k} ${review.sources.filter((s) => s.kind === k).length}`).join(" · ")}`];
  if (!review.sources.length) lines.push("No eligible source records for this week. An empty review is saved so you can still reflect.");
  lines.push(...review.warnings.map((w) => `Note: ${display(w, 320)}`));
  for (const key of SECTION_KEYS) {
    lines.push("", labels[key]);
    lines.push(...(review.sections[key].length ? review.sections[key].map((f) => `- ${display(f.text, 360)} [${f.refs.join(", ")}]`) : [empty[key]]));
  }
  lines.push("", "Source snapshots (quoted data; IDs refer to the original records)");
  lines.push(...review.sources.map((s) => `[${s.ref}] ${s.kind} ${s.id} · ${display(s.title, 100)}${s.excerpt ? ` — “${display(s.excerpt, 160)}”` : ""}`));
  if (!review.sources.length) lines.push("No sources available for this window.");
  lines.push("", "Your reflection", review.reflection ? `${display(review.reflection.text, 1200)}\nUpdated: ${review.reflection.updatedAt}` : `Not added. Use reflect ${review.id} | What helped, what got in the way, and one change for next week.`);
  return lines.join("\n");
}

function findReview(state: State, id: string): Review {
  if (id !== "latest" && !reviewId(id)) throw new ReviewError("Use the full wr-… review ID from history, or latest.");
  const review = id === "latest" ? state.reviews[0] : state.reviews.find((r) => r.id === id);
  if (!review) throw new ReviewError("Review not found. Run history to see retained IDs, or review to create one. Only the latest 12 snapshots are kept.");
  return review;
}

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  try {
    if (typeof command !== "string" || command.length > 1400) throw new ReviewError("Command is too long. Reflections may contain up to 1000 characters.");
    const [, verb = "help", args = ""] = command.trim().match(/^(\S+)?(?:\s+([\s\S]*))?$/) ?? [];
    if (verb === "help" && !args) return feature.help;
    if (context.signal?.aborted) throw new ReviewError("Weekly review cancelled; no changes made.");
    if (verb === "review") {
      const format = formatter(context.timezone);
      if (!Number.isFinite(context.now.getTime())) throw new ReviewError("A valid current time is required to make a review.");
      const today = localDay(context.now, format), end = args || today;
      if (!validDay(end)) throw new ReviewError("Use review [YYYY-MM-DD] with a real calendar date, such as review 2026-10-22.");
      if (end > today) throw new ReviewError(`The review end date cannot be in the future. Today is ${today} in ${context.timezone}.`);
      const start = shiftDay(end, -6);
      if (!validDay(start)) throw new ReviewError("Choose an end date on or after 0001-01-07.");
      // Validate storage before a provider read, and revalidate inside the atomic transform.
      validateState(await context.store.read<unknown>(KEY));
      let raw: unknown;
      try { raw = await context.services.readContext([...KINDS] as AgentContextKind[]); }
      catch { throw new ReviewError("Could not read your personal sources. No review was saved; your existing reviews and reflections are unchanged. Retry review later."); }
      if (!Array.isArray(raw)) throw new ReviewError("Personal sources returned an invalid response. No review was saved; retry later.");
      if (context.signal?.aborted) throw new ReviewError("Weekly review cancelled; no review saved.");
      const { rows, ignored } = normalize(raw, format);
      const { sources, sections, omitted } = synthesize(rows, start, end);
      const warnings = ["Uses currently available records, not a historical audit. Late edits/backfills can appear; missing records do not prove inactivity.", "Up to five sources per category and six findings per section are shown. Source excerpts are shortened."];
      if (end === today) warnings.push("The end date is today; this local day is still in progress.");
      if (ignored) warnings.push(`${ignored} invalid, duplicate, unsupported or over-limit source records/fields were ignored (at most 1000 records scanned).`);
      if (omitted) warnings.push(`${omitted} additional eligible sources were omitted by the five-per-category limit.`);
      const missing = KINDS.filter((kind) => !sources.some((s) => s.kind === kind));
      if (missing.length) warnings.push(`No eligible sources supplied/selected for: ${missing.join(", ")}.`);
      const review: Review = { id: `wr-${randomUUID()}`, createdAt: context.now.toISOString(), start, end, timezone: context.timezone, sources, sections, warnings };
      const saved = await context.store.update<unknown, boolean>(KEY, emptyState(), (current) => {
        const state = validateState(current);
        const reviews = [...state.reviews, review].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, MAX_HISTORY);
        return { value: checkWriteQuota({ version: 1, reviews }, true), result: reviews.some((r) => r.id === review.id) };
      });
      return saved ? render(review) : "This review fell outside the latest 12 snapshots because newer reviews finished first. Run review again to save a current snapshot.";
    }
    if (verb === "history" && !args) {
      const state = validateState(await context.store.read<unknown>(KEY));
      if (!state.reviews.length) return "No weekly reviews yet. Use review, or review 2026-10-22, to synthesize seven days of your personal sources.";
      return `Weekly review history (up to ${MAX_HISTORY} snapshots retained)\n${state.reviews.map((r) => `${r.id} · ${r.start} – ${r.end} · ${r.timezone} · ${r.sources.length} sources${r.reflection ? " · reflection added" : ""}`).join("\n")}\nStorage: ${jsonBytes(state)} / 480,000 UTF-8 bytes; snapshots: ${snapshotBytes(state)} / 400,000 bytes. Remaining budget is reserved for reflections and lifecycle changes.\nUse show <id> or show latest. To free space, copy a review with show, then delete <id> confirm.`;
    }
    if (verb === "show") return render(findReview(validateState(await context.store.read<unknown>(KEY)), args || "latest"));
    if (verb === "reflect") {
      const split = args.indexOf("|");
      if (split < 0) throw new ReviewError("Use reflect <review-id|latest> | A short reflection (1–1000 characters).");
      const id = args.slice(0, split).trim(), text = args.slice(split + 1).trim();
      if (!text || text.length > 1000) throw new ReviewError("Reflection must contain 1–1000 characters.");
      if (!Number.isFinite(context.now.getTime())) throw new ReviewError("A valid current time is required to save a reflection.");
      const updatedAt = context.now.toISOString();
      // Resolve 'latest' once: a concurrent new review must not steal this reflection.
      const target = findReview(validateState(await context.store.read<unknown>(KEY)), id).id;
      return await context.store.update<unknown, string>(KEY, emptyState(), (current) => {
        const state = validateState(current), review = findReview(state, target);
        if (review.reflection && review.reflection.updatedAt > updatedAt) return { value: state, result: "A newer reflection is already saved. Use show to read it before editing again." };
        const value = checkWriteQuota({ version: 1, reviews: state.reviews.map((r) => r.id === target ? { ...r, reflection: { text, updatedAt } } : r) });
        return { value, result: `Reflection saved for ${target}. Use show ${target} to read the review and reflection together.` };
      });
    }
    if (verb === "delete") {
      const match = args.match(/^(\S+) confirm$/);
      if (!match || !reviewId(match[1])) throw new ReviewError("Use delete <full-review-id> confirm. This removes that snapshot and its reflection.");
      return await context.store.update<unknown, string>(KEY, emptyState(), (current) => {
        const state = validateState(current), review = findReview(state, match[1]);
        return { value: checkWriteQuota({ version: 1, reviews: state.reviews.filter((r) => r.id !== review.id) }), result: `Deleted review ${review.id} and its reflection.` };
      });
    }
    throw new ReviewError("Unknown command or extra arguments. Use help for review, history, show, reflect and delete examples.");
  } catch (error) {
    if (error instanceof ReviewError) return error.message;
    return "Weekly-review storage is unavailable or the operation could not finish. Run history/show to check saved state before retrying.";
  }
}

export const feature: AgentFeature = {
  id: "weekly-review",
  title: "Weekly personal review",
  description: "Synthesize seven local calendar days of personal goals, habits, journal, follow-ups and notes, with source references and a private reflection.",
  help: "Weekly personal review (private)\nreview [YYYY-MM-DD] — seven days ending on this inclusive date; defaults to today in your timezone. Example: review 2026-10-22\nhistory — up to 12 saved snapshots and storage usage\nshow [<full-review-id>|latest] — read a saved review (defaults to latest)\nreflect <full-review-id|latest> | Protected focus time helped; next week I will make one smaller commitment.\ndelete <full-review-id> confirm — remove one review and its reflection\nReviews use deterministic source-backed synthesis; no model or web calls. Each review makes a new snapshot; reflect replaces that snapshot's short reflection. At most five sources per category are selected; older snapshots expire after 12 reviews. Snapshots must stay below 400,000 serialized UTF-8 bytes, reserving 80,000 bytes for reflections and lifecycle changes; total state stays below 480,000 bytes. If full, use show to copy a review, then delete <id> confirm and retry. Source records are never changed.",
  execute,
};

export default feature;
