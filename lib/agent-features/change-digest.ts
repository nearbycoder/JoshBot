import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./change-digest.metadata.js";
import { boundedText, pipeFields, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
const route = "/nobo-help agent change-digest";
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/));
const rev = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const text = (bytes: number, units = bytes, empty = false) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, maxUnits: units, trim: false, allowEmpty: empty }); return empty || !!s.trim(); } catch { return false; } }));
const source = v.pipe(text(16000, 6000, true), v.check(s => s.split("\n").length <= 120, "At most 120 lines per version, counting a trailing empty line."));
const classification = v.strictObject({ hunkId: v.pipe(v.string(), v.regex(/^[0-9a-f-]{36}:r[1-9]\d{0,15}:h[1-9]\d?$/)), label: v.picklist(["substantive", "cosmetic"]), note: text(96, 96, true) });
const comparison = v.strictObject({ id, revision: rev, diffRevision: rev, title: text(120), beforeLabel: text(80), afterLabel: text(80), before: source, after: v.nullable(source), classifications: v.pipe(v.array(classification), v.maxLength(60)) });
type Comparison = v.InferOutput<typeof comparison>;
type Hunk = { id: string; oldStart: number; oldEnd: number; newStart: number; newEnd: number; oldLine: number; newLine: number };
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(comparison), v.maxLength(6)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
const lineTokens = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function hunks(r: Comparison): Hunk[] {
  if (r.after === null) return [];
  const a = lineTokens(r.before), b = lineTokens(r.after), width = b.length + 1, table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result: Hunk[] = []; let i = 0, j = 0, old = 0, next = 0, pending: Hunk | null = null;
  const flush = () => { if (pending) { pending.oldEnd = old; pending.newEnd = next; result.push(pending); pending = null; if (result.length > 60) throw new Error("More than 60 diff hunks; narrow the comparison before saving. No partial diff was accepted."); } };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); old += a[i++].length; next += b[j++].length; continue; }
    pending ??= { id: `${r.id}:r${r.diffRevision}:h${result.length + 1}`, oldStart: old, oldEnd: old, newStart: next, newEnd: next, oldLine: i + 1, newLine: j + 1 };
    if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) old += a[i++].length;
    else next += b[j++].length;
  }
  flush(); return result;
}
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw); if (!p.success) throw new Error("Invalid saved change-digest data; preserved. Ask a maintainer to repair this scoped state; help remains available.");
  if (new Set(p.output.records.map(r => r.id)).size !== p.output.records.length) throw new Error("Duplicate saved IDs; data preserved.");
  for (const r of p.output.records) { const hs = new Set(hunks(r).map(h => h.id)); if (r.diffRevision > r.revision || new Set(r.classifications.map(c => c.hunkId)).size !== r.classifications.length || r.classifications.some(c => !hs.has(c.hunkId))) throw new Error("Invalid or stale hunk classification; data preserved."); }
  return p.output;
}
const envelope = (r: Comparison) => ({ feature: metadata.id, version: 1, record: r });
const limits = { maxBytes: 65536, contentBytes: 49152, maxRecords: 6 };
function admit(s: State, lifecycle = false) {
  // Every hunk can receive the longest category and a maximum JSON-escaped note.
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: Number.MAX_SAFE_INTEGER, diffRevision: Number.MAX_SAFE_INTEGER, classifications: hunks(r).map((_, i) => ({ hunkId: `${r.id}:r${Number.MAX_SAFE_INTEGER}:h${i + 1}`, label: "substantive" as const, note: "\n".repeat(96) })) })) };
  assertQuota(s, { records: s.records.map(envelope), limits, ...(lifecycle ? { kind: "lifecycle" as const } : { kind: "content" as const, future: { value: future, records: future.records.map(envelope) } }) });
  if (lifecycle) assertQuota(future, { kind: "lifecycle", records: future.records.map(envelope), limits });
  for (const r of future.records) { render(r, "show", JSON.stringify(envelope(r), null, 2), 1); render(r, "compare", report(r, false), 1); render(r, "digest", report(r, true), 1); }
}
const fields = (s: string, sizes: number[]) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32, allowEmpty: true }))).map((x, i) => boundedText(x, { label: "Field", maxBytes: sizes[i], allowEmpty: true }));
const get = (s: State, key: string) => { const r = s.records.find(x => x.id === key); if (!r) throw new Error(`Comparison not found. Use ${route} list`); return r; };
function render(r: Comparison, verb: string, body: string, p: number, expected?: string) {
  if (expected) assertRevision(r.revision, Number(expected));
  return pageAt(paginateParts(body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?::r\d+:h\d+)?)/g).map((text, i) => ({ text, atomic: i % 2 === 1 })), { mode: "plain", title: `Comparison ${r.id} · revision ${r.revision}`, command: n => `${route} ${verb} ${r.id} page ${n} rev ${r.revision}` }), p).text;
}
type Token = { kind: "number" | "date" | "name?"; text: string; start: number; end: number };
function tokens(s: string, offset: number): Token[] {
  const out: Token[] = [], occupied = new Uint8Array(s.length);
  const add = (kind: Token["kind"], re: RegExp) => { for (const m of s.matchAll(re)) { const start = m.index!, end = start + m[0].length; if (occupied.slice(start, end).some(Boolean)) continue; occupied.fill(1, start, end); out.push({ kind, text: m[0], start: start + offset, end: end + offset }); } };
  add("date", /\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?\b/g);
  add("number", /(?<![\w.])[+-]?\d+(?:[.,]\d+)*%?/g);
  add("name?", /\b[A-Z][a-z]+\b/g);
  return out.sort((a, b) => a.start - b.start);
}
function absent(a: Token[], b: Token[]) {
  const counts = new Map<string, number>(); for (const t of b) { const k = `${t.kind}/${t.text}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  return a.filter(t => { const k = `${t.kind}/${t.text}`, n = counts.get(k) ?? 0; if (!n) return true; counts.set(k, n - 1); return false; });
}
function detail(r: Comparison, h: Hunk) {
  const old = r.before.slice(h.oldStart, h.oldEnd), next = r.after!.slice(h.newStart, h.newEnd), c = r.classifications.find(c => c.hunkId === h.id), a = tokens(old, h.oldStart), b = tokens(next, h.newStart);
  return `Hunk ${h.id} · ${c?.label ?? "unreviewed"}${c ? `; user rationale: ${c.note || "(none)"}` : ""}\n${!old ? "INSERTION" : !next ? "DELETION" : "REPLACEMENT"}; before [${h.oldStart},${h.oldEnd}) from line ${h.oldLine}; after [${h.newStart},${h.newEnd}) from line ${h.newLine}.\nDeleted exact span: ${JSON.stringify(old)}\nInserted exact span: ${JSON.stringify(next)}\n` + (old.replace(/\s/g, "") === next.replace(/\s/g, "") ? "Whitespace-only hint; classification remains your judgment.\n" : "") + absent(a, b).map(t => `old ${t.kind} [${t.start},${t.end}): ${JSON.stringify(t.text)}\n`).join("") + absent(b, a).map(t => `new ${t.kind} [${t.start},${t.end}): ${JSON.stringify(t.text)}\n`).join("");
}
function report(r: Comparison, digest: boolean) {
  if (r.after === null) return `After version not supplied. Next: ${route} after ${r.id} | replacement text\n`;
  const hs = hunks(r), status = (h: Hunk) => r.classifications.find(c => c.hunkId === h.id)?.label ?? "unreviewed";
  const out = [`${r.beforeLabel} → ${r.afterLabel}; ${hs.length} line-diff hunks. Offsets are zero-based UTF-16, end exclusive.\nNumeric/date and capitalized name? tokens are exact lexical hints, not inferred business meaning or factual verification.\n`];
  if (!hs.length) out.push("No changes: supplied text is exactly identical.\n");
  if (digest) for (const group of ["substantive", "cosmetic", "unreviewed"]) { const selected = hs.filter(h => status(h) === group); out.push(`${group.toUpperCase()}: ${selected.length}\n`); for (const h of selected) out.push(detail(r, h)); }
  else for (const h of hs) out.push(detail(r, h));
  return out.join("");
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID();
  const usage = (state: State) => `${state.records.length}/6 comparisons; ${serializedBytes(state)}/65536 UTF-8 bytes (49152 content admission). Export/delete to free space: ${route} list`;
  const save = (change: (state: State) => Comparison | null, kind: "content" | "lifecycle" | "remove" = "content") => ctx.store.update("state", initial, raw => { const state = validate(raw), r = change(state); validate(state); if (kind !== "remove") admit(state, kind === "lifecycle"); return { value: state, result: `${r ? `Saved privately: ${r.id} · revision ${r.revision}\nNext: ${route} compare ${r.id}` : "Deleted privately."}\n${usage(state)}` }; });
  const edit = (key: string, change: (r: Comparison) => void, kind: "content" | "lifecycle" | "remove" = "content") => { const expected = get(s, key).revision; return save(state => { const r = get(state, key); assertRevision(r.revision, expected); change(r); r.revision++; return r; }, kind); };
  const invalidate = (r: Comparison) => { r.diffRevision++; r.classifications = []; };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { if (parsePage(m[1]) !== 1) throw new Error("Page out of range; use list."); return `${usage(s)}\n${s.records.map(r => `${r.id} · ${r.title} · revision ${r.revision}; ${r.after === null ? "after missing" : `${hunks(r).length} hunks`}`).join("\n") || `No comparisons. Start: ${metadata.example}`}`; }
  if ((m = command.match(/^(show|compare|digest) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const r = get(s, m[2]); return render(r, m[1], m[1] === "show" ? JSON.stringify(envelope(r), null, 2) : report(r, m[1] === "digest"), parsePage(m[3]), m[4]); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Legacy record exceeds export limit; use show pages then delete."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const r = get(s, m[1]); if (!m[2]) return `Delete versions/labels/classifications: ${route} delete ${r.id} confirm`; return save(state => { assertRevision(get(state, r.id).revision, r.revision); state.records = state.records.filter(x => x.id !== r.id); return null; }, "remove"); }
  if (command.startsWith("create ")) { const [title, beforeLabel, before] = fields(command.slice(7), [120, 80, 16000]); return save(state => { const r: Comparison = { id: newId, revision: 1, diffRevision: 1, title, beforeLabel, afterLabel: "after", before, after: null, classifications: [] }; state.records.push(r); return r; }); }
  if ((m = command.match(/^(before|after|title) (\S+)\s*\|([\s\S]*)$/))) { const [, verb, key, input] = m, [value] = fields(input, [verb === "title" ? 120 : 16000]); return edit(key, r => { r[verb as "before" | "after" | "title"] = value; invalidate(r); }); }
  if ((m = command.match(/^labels (\S+)\s*\|([\s\S]+)$/))) { const [, key, input] = m, [beforeLabel, afterLabel] = fields(input, [80, 80]); return edit(key, r => { Object.assign(r, { beforeLabel, afterLabel }); invalidate(r); }); }
  if ((m = command.match(/^classify (\S+) ([\s\S]+)$/))) { const [, key, input] = m, [hunkId, labelInput, note] = fields(input, [64, 11, 96]), label = v.parse(v.picklist(["substantive", "cosmetic"]), labelInput); return edit(key, r => { if (!hunks(r).some(h => h.id === hunkId)) throw new Error("Hunk changed or not found. Run compare for current full hunk IDs; old classifications cannot apply."); r.classifications = [...r.classifications.filter(c => c.hunkId !== hunkId), { hunkId, label, note }]; }, "lifecycle"); }
  if ((m = command.match(/^unclassify (\S+) (\S+) confirm$/))) { const [, key, hid] = m; return edit(key, r => { if (!r.classifications.some(c => c.hunkId === hid)) throw new Error("Classification not found; use show/compare."); r.classifications = r.classifications.filter(c => c.hunkId !== hid); }, "remove"); }
  if ((m = command.match(/^clear (\S+) (before|after|classifications) confirm$/))) { const [, key, field] = m; return edit(key, r => { if (field === "before") r.before = ""; else if (field === "after") r.after = null; invalidate(r); }, field === "classifications" || field === "after" ? "remove" : "content"); }
  throw new Error(`Unknown or incomplete command. Use ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
