import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./estimate-calibration.metadata.js";
import { boundedText, pipeFields, parseDecimal, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant } from "./feature-kit/civil-time.js";

const route = "/nobo-help agent estimate-calibration";
const text = (max: number) => v.pipe(v.string(), v.check(s => { try { return boundedText(s, { label: "Text", maxBytes: max }) === s; } catch { return false; } }));
const instant = v.pipe(v.string(), v.check(s => { try { return normalizeInstant(s) === s; } catch { return false; } }));
const idSchema = v.pipe(v.string(), v.regex(/^[0-9a-f-]{36}$/));
const number = v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000), v.check(n => Number.isFinite(n) && Math.abs(n * 1000 - Math.round(n * 1000)) < 0.00001));
const positive = v.pipe(number, v.minValue(0.001));
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const sampleSchema = v.strictObject({
  id: idSchema, revision, createdAt: instant, label: text(120), category: text(80), estimatedMinutes: positive,
  actualMinutes: v.nullable(number), actualAt: v.nullable(instant),
  correction: v.nullable(v.strictObject({ minutes: positive, reason: text(768), at: instant })),
  excludedReason: v.nullable(text(768)),
});
type Sample = v.InferOutput<typeof sampleSchema>;
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(sampleSchema), v.maxLength(60)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
function validate(raw: unknown): State {
  assertStateVersion(raw, 1);
  const parsed = v.safeParse(schema, raw);
  if (!parsed.success) throw new Error("Invalid saved estimate data; nothing changed.");
  const s = parsed.output;
  if (new Set(s.records.map(r => r.id)).size !== s.records.length || new Set(s.records.map(r => r.category)).size > 12 || s.records.some(r => (r.actualMinutes === null) !== (r.actualAt === null))) throw new Error("Invalid saved sample identities, categories, or actuals; nothing changed.");
  return s;
}
const envelope = (r: Sample) => ({ feature: metadata.id, version: 1, record: r });
function admit(s: State, lifecycle: boolean) {
  const records = s.records.map(envelope);
  // Actuals and their timestamp remain possible for EVERY accepted sample.
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: Number.MAX_SAFE_INTEGER, actualMinutes: 999999.999, actualAt: "9999-12-31T23:59:59.999Z" })) };
  assertQuota(s, { records, limits: { maxRecords: 60 }, ...(lifecycle ? { kind: "lifecycle" as const } : { kind: "content" as const, future: { value: future, records: future.records.map(envelope) } }) });
}
const fields = (input: string, sizes: number[]) => pipeFields(input, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i] }));
const minutes = (s: string, min = 0) => { if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(s)) throw new Error("Minutes need a plain number with at most 3 decimal places."); return parseDecimal(s, { min, max: 1_000_000 }); };
const get = (s: State, id: string) => { const r = s.records.find(r => r.id === id); if (!r) throw new Error(`Sample not found. Use ${route} list`); return r; };
const median = (values: number[]) => { const a = [...values].sort((a, b) => a - b), i = Math.floor(a.length / 2); return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const fmt = (n: number) => Number(n.toFixed(6)).toString();
function statistics(records: Sample[], category: string) {
  const all = records.filter(r => r.category === category);
  const excluded = all.filter(r => r.excludedReason !== null);
  const incomplete = all.filter(r => r.excludedReason === null && r.actualMinutes === null);
  const complete = all.filter(r => r.excludedReason === null && r.actualMinutes !== null);
  const estimate = (r: Sample) => r.correction?.minutes ?? r.estimatedMinutes;
  return { complete, count: complete.length, ratio: complete.length ? median(complete.map(r => r.actualMinutes! / estimate(r))) : null,
    error: complete.length ? median(complete.map(r => Math.abs(r.actualMinutes! - estimate(r)))) : null,
    signed: complete.length ? median(complete.map(r => r.actualMinutes! - estimate(r))) : null,
    summary: `Category: ${category}\nComplete, nonexcluded: ${complete.length}; incomplete, nonexcluded: ${incomplete.length}; excluded: ${excluded.length} (${excluded.filter(r => r.actualMinutes === null).length} incomplete).\nExplicit corrections used: ${complete.filter(r => r.correction).length}.` };
}
function display(r: Sample, page: number, expected?: string) {
  if (expected) assertRevision(r.revision, Number(expected));
  return pageAt(paginateParts(JSON.stringify(envelope(r), null, 2).split(/(?<=\n)/).map(text => ({ text, atomic: true })), { mode: "plain", title: `Sample ${r.id} · revision ${r.revision}`, command: p => `${route} show ${r.id} page ${p} rev ${r.revision}` }), page).text;
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 });
  if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial);
  const now = normalizeInstant(ctx.now.toISOString()), newId = randomUUID();
  const save = (change: (state: State) => Sample | null, kind: "content" | "lifecycle" | "remove" = "content") => ctx.store.update("state", initial, raw => {
    const current = validate(raw), result = change(current); validate(current);
    if (kind !== "remove") admit(current, kind === "lifecycle");
    return { value: current, result: result ? `Saved privately: ${result.id} · revision ${result.revision}\nNext: ${route} show ${result.id}` : `Deleted privately.\nNext: ${route} list` };
  });
  const edit = (id: string, change: (r: Sample) => void, kind: "content" | "lifecycle" | "remove" = "content") => {
    const expected = get(s, id).revision;
    return save(state => { const r = get(state, id); assertRevision(r.revision, expected); change(r); r.revision++; return r; }, kind);
  };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) {
    const p = parsePage(m[1]), rows = [...s.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (!rows.length) return `No saved samples.\nStart: ${metadata.example}`;
    if ((p - 1) * 10 >= rows.length) throw new Error(`Page out of range. Use ${route} list`);
    return `Current samples ${(p - 1) * 10 + 1}–${Math.min(p * 10, rows.length)} of ${rows.length}\n` + rows.slice((p - 1) * 10, p * 10).map(r => `${r.id} · ${r.label} · ${r.actualMinutes === null ? "incomplete" : "paired"}${r.excludedReason ? ", excluded" : ""}`).join("\n") + `\n${p * 10 < rows.length ? `Next: ${route} list page ${p + 1}` : `Open: ${route} show ${rows[(p - 1) * 10].id}`}`;
  }
  if ((m = command.match(/^show (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) return display(get(s, m[1]), parsePage(m[2]), m[3]);
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Export exceeds 24576 bytes; use show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) {
    const r = get(s, m[1]); if (!m[2]) return `Delete sample ${r.id} and its correction?\n${route} delete ${r.id} confirm`;
    return save(state => { assertRevision(get(state, r.id).revision, r.revision); state.records = state.records.filter(x => x.id !== r.id); return null; }, "remove");
  }
  if (command.startsWith("estimate ")) {
    const [label, category, value] = fields(command.slice(9), [120, 80, 24]);
    const r: Sample = { id: newId, revision: 1, createdAt: now, label, category, estimatedMinutes: minutes(value, 0.001), actualMinutes: null, actualAt: null, correction: null, excludedReason: null };
    return save(state => { state.records.push(r); return r; });
  }
  if (command.startsWith("actual ")) { const [id, value] = fields(command.slice(7), [36, 24]); const n = minutes(value); return edit(id, r => { r.actualMinutes = n; r.actualAt = now; }, "lifecycle"); }
  if (command.startsWith("correct ")) { const [id, value, reason] = fields(command.slice(8), [36, 24, 768]); const n = minutes(value, 0.001); return edit(id, r => { r.correction = { minutes: n, reason, at: now }; }); }
  if (command.startsWith("exclude ")) { const [id, reason] = fields(command.slice(8), [36, 768]); return edit(id, r => { r.excludedReason = reason; }); }
  if ((m = command.match(/^edit (\S+) (label|category) ([\s\S]+)$/))) { const [, id, field, raw] = m; const [value] = fields(raw, [field === "label" ? 120 : 80]); return edit(id, r => { r[field as "label" | "category"] = value; }); }
  if ((m = command.match(/^remove (\S+) (actual|correction|exclusion) confirm$/))) { const [, id, field] = m; return edit(id, r => { if (field === "actual") { r.actualMinutes = null; r.actualAt = null; } else if (field === "correction") r.correction = null; else r.excludedReason = null; }, "remove"); }
  if (command.startsWith("report ") || command.startsWith("forecast ")) {
    const forecast = command.startsWith("forecast "); const [category, value] = fields(command.slice(forecast ? 9 : 7), forecast ? [80, 24] : [80]);
    const stats = statistics(s.records, category), base = forecast ? minutes(value, 0.001) : null;
    let reply = stats.summary;
    if (stats.count) reply += `\nMedian actual/estimate ratio: ${fmt(stats.ratio!)}. Median absolute error: ${fmt(stats.error!)} minutes. Median signed error: ${fmt(stats.signed!)} minutes (actual minus estimate).`;
    if (stats.count < 3) reply += "\nNo adjustment: at least 3 complete, nonexcluded samples in this exact category are required.";
    else reply += forecast ? `\nUnsaved forecast: ${fmt(base!)} × ${fmt(stats.ratio!)} = ${fmt(base! * stats.ratio!)} minutes (n=${stats.count}).` : `\nPreview multiplier: ${fmt(stats.ratio!)} (n=${stats.count}).`;
    return reply + `\nSmall, self-reported sample; similar work is assumed. Medians resist outliers but do not guarantee future effort. Zero actuals are known values. Original estimates remain unchanged.\nNext: ${route} list`;
  }
  throw new Error(`Unknown or incomplete command. Syntax: ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
