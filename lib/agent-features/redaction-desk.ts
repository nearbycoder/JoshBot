import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./redaction-desk.metadata.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
const route = "/nobo-help agent redaction-desk";
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/));
const rev = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const offset = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6000));
const text = (bytes: number, units = bytes, empty = false) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, maxUnits: units, trim: false, allowEmpty: empty }); return empty || !!s.trim(); } catch { return false; } }));
const category = v.picklist(["email", "phone", "literal"]);
const span = v.strictObject({ start: offset, end: offset, categories: v.pipe(v.array(category), v.minLength(1), v.maxLength(3)) });
const preview = v.strictObject({ token: id, revision: rev, spans: v.pipe(v.array(span), v.maxLength(30)), selected: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30))), v.maxLength(30)) });
const doc = v.strictObject({ id, revision: rev, title: text(120), original: text(16000, 6000, true), current: text(16000, 6000, true), literals: v.pipe(v.array(v.strictObject({ id, value: text(1200, 300) })), v.maxLength(20)), enabled: v.pipe(v.array(category), v.maxLength(3)), preview: v.nullable(preview), undo: v.nullable(text(16000, 6000, true)) });
type Doc = v.InferOutput<typeof doc>;
type Category = v.InferOutput<typeof category>;
type Span = v.InferOutput<typeof span>;
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(doc), v.maxLength(6)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
const categories: Category[] = ["email", "phone", "literal"];
function detect(d: Doc): Span[] {
  const source = d.current, starts = categories.map(() => new Int32Array(source.length + 1)), ends = categories.map(() => new Int32Array(source.length + 1));
  const mark = (kind: Category, a: number, b: number) => { const i = categories.indexOf(kind); starts[i][a]++; ends[i][b]++; };
  if (d.enabled.includes("literal")) for (const l of d.literals) { let pos = source.indexOf(l.value); while (pos !== -1) { mark("literal", pos, pos + l.value.length); pos = source.indexOf(l.value, pos + 1); } }
  if (d.enabled.includes("email")) for (const m of source.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+/g)) {
    const token = m[0].replace(/^\.+|\.+$/g, ""), at = token.indexOf("@"), local = token.slice(0, at), domain = token.slice(at + 1), labels = domain.split(".");
    if (at < 1 || at !== token.lastIndexOf("@") || local.length > 64 || domain.length > 253 || labels.length < 2 || !/^[A-Za-z]{2,24}$/.test(labels.at(-1)!) || labels.some(l => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) continue;
    const start = m.index! + m[0].indexOf(token); mark("email", start, start + token.length);
  }
  if (d.enabled.includes("phone")) for (const m of source.matchAll(/\+?[\d(][\d ()\-.]{5,40}\d/g)) {
    const digits = m[0].replace(/\D/g, "").length, start = m.index!, end = start + m[0].length;
    if (digits >= 7 && digits <= 15 && !/[A-Za-z0-9]/.test(source[start - 1] ?? "") && !/[A-Za-z0-9]/.test(source[end] ?? "")) mark("phone", start, end);
  }
  // Difference arrays avoid retaining thousands of overlapping literal matches.
  const active = [0, 0, 0], result: Span[] = []; let open: Span | null = null;
  for (let i = 0; i <= source.length; i++) {
    for (let k = 0; k < 3; k++) active[k] -= ends[k][i];
    if (open && active.every(n => n === 0)) { open.end = i; result.push(open); open = null; if (result.length > 30) throw new Error("More than 30 merged spans. No preview saved. Narrow scan categories/literals or revise the text; no partial scan is accepted."); }
    for (let k = 0; k < 3; k++) active[k] += starts[k][i];
    if (active.some(n => n > 0)) { open ??= { start: i, end: i, categories: [] }; for (let k = 0; k < 3; k++) if (active[k] && !open.categories.includes(categories[k])) open.categories.push(categories[k]); }
  }
  return result.map(s => ({ ...s, categories: categories.filter(c => s.categories.includes(c)) }));
}
const placeholder = (s: Span) => s.categories.length > 1 ? "[MIXED]" : `[${s.categories[0].toUpperCase()}]`;
function masked(d: Doc): string {
  if (!d.preview) throw new Error("No preview. Run scan first.");
  let result = "", cursor = 0;
  for (let i = 0; i < d.preview.spans.length; i++) if (d.preview.selected.includes(i + 1)) { const s = d.preview.spans[i]; result += d.current.slice(cursor, s.start) + placeholder(s); cursor = s.end; }
  return result + d.current.slice(cursor);
}
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw); if (!p.success) throw new Error("Invalid saved redaction data; preserved. Ask a maintainer to repair this scoped state; help remains available.");
  const ids: string[] = [];
  for (const d of p.output.records) {
    ids.push(d.id, ...d.literals.map(l => l.id), ...(d.preview ? [d.preview.token] : []));
    if (new Set(d.enabled).size !== d.enabled.length || new Set(d.literals.map(l => l.value)).size !== d.literals.length) throw new Error("Duplicate redaction settings; data preserved.");
    if (d.preview) {
      if (d.preview.revision !== d.revision || JSON.stringify(d.preview.spans) !== JSON.stringify(detect(d)) || new Set(d.preview.selected).size !== d.preview.selected.length || d.preview.selected.some((x, i, a) => x > d.preview!.spans.length || (i > 0 && x <= a[i - 1]))) throw new Error("Invalid/stale preview spans or selection; data preserved.");
      v.parse(text(16000, 6000, true), masked(d));
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved IDs; data preserved."); return p.output;
}
const envelope = (d: Doc) => ({ feature: metadata.id, version: 1, record: d });
const limits = { maxBytes: 65536, contentBytes: 49152, maxRecords: 6 };
function projection(s: State) {
  // At most 30 replacements, each <=9 ASCII units. Include a full prior version,
  // the largest possible preview and maximum revision width simultaneously.
  return { ...s, records: s.records.map(d => {
    const largest = [d.current, d.undo ?? ""].sort((a, b) => serializedBytes(b) - serializedBytes(a))[0];
    return { ...d, revision: Number.MAX_SAFE_INTEGER, current: d.current + "X".repeat(270), undo: largest + "X".repeat(270), preview: { token: "ffffffff-ffff-ffff-ffff-ffffffffffff", revision: Number.MAX_SAFE_INTEGER, spans: Array.from({ length: 30 }, () => ({ start: 6000, end: 6000, categories })), selected: Array.from({ length: 30 }, (_, i) => i + 1) } };
  }) };
}
function admit(s: State, lifecycle = false) {
  const future = projection(s);
  if (lifecycle) assertQuota(s, { kind: "lifecycle", records: s.records.map(envelope), limits });
  else assertQuota(s, { kind: "content", records: s.records.map(envelope), limits, future: { value: future, records: future.records.map(d => ({ feature: metadata.id, version: 1, record: d })) } });
  // Scans validate exact apply capacity even when an earlier lifecycle used reserve.
  for (const d of s.records) {
    render(d, "show", JSON.stringify(envelope(d), null, 2), 1); render(d, "copy", d.current, 1);
    if (d.preview) {
      render(d, `preview ${d.id} ${d.preview.token}`, previewText(d), 1, undefined, true);
      const applied = { ...d, revision: Number.MAX_SAFE_INTEGER, current: masked(d), undo: d.current, preview: null };
      const undone = { ...applied, current: d.current, undo: null };
      for (const r of [applied, undone]) { const projected = { ...s, records: s.records.map(x => x.id === d.id ? r : x) }; assertQuota(projected, { kind: "lifecycle", records: projected.records.map(envelope), limits }); }
    }
  }
  // Sum each record's largest reachable version, covering every combination of
  // independently applied previews (not merely the all-applied endpoint).
  const worst = { ...s, records: s.records.map(d => {
    const saved = { ...d, revision: Number.MAX_SAFE_INTEGER, preview: d.preview ? { ...d.preview, revision: Number.MAX_SAFE_INTEGER } : null };
    const choices = [saved];
    if (d.preview) choices.push({ ...saved, current: masked(d), undo: d.current, preview: null });
    if (d.undo !== null) choices.push({ ...saved, current: d.undo, undo: null, preview: null });
    return choices.sort((a, b) => serializedBytes(b) - serializedBytes(a))[0];
  }) };
  assertQuota(worst, { kind: "lifecycle", records: worst.records.map(envelope), limits });
}
const fields = (s: string, sizes: number[]) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((x, i) => boundedText(x, { label: "Field", maxBytes: sizes[i] }));
const get = (s: State, key: string) => { const d = s.records.find(x => x.id === key); if (!d) throw new Error(`Document not found. Use ${route} list`); return d; };
function render(d: Doc, verb: string, body: string, p: number, expected?: string, fullCommand = false) {
  if (expected) assertRevision(d.revision, Number(expected));
  return pageAt(paginateParts(body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g).map((text, i) => ({ text, atomic: i % 2 === 1 })), { mode: "plain", title: `Redaction ${d.id} · revision ${d.revision}; original/undo may remain. Detection is incomplete.`, command: n => `${route} ${fullCommand ? verb : `${verb} ${d.id}`} page ${n} rev ${d.revision}` }), p).text;
}
function previewText(d: Doc) {
  const p = d.preview!;
  return `Preview token: ${p.token}\nOnly selected spans will be replaced. Offsets are zero-based UTF-16, end exclusive.\n` + p.spans.map((s, i) => `${i + 1}. ${p.selected.includes(i + 1) ? "SELECTED" : "not selected"} [${s.start},${s.end}) ${s.categories.join("+")} => ${placeholder(s)}\nExact span: ${JSON.stringify(d.current.slice(s.start, s.end))}\n`).join("") + `Proposed current text:\n${masked(d)}\nOriginal and one undo version remain retained until removed/deleted. These heuristics cannot detect all secrets.\nApply: ${route} apply ${d.id} ${p.token}\n`;
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID();
  const usage = (state: State) => `${state.records.length}/6 documents; ${serializedBytes(state)}/65536 UTF-8 bytes (49152 content admission). Original/undo can retain secrets. Export/delete: ${route} list`;
  const save = (change: (state: State) => Doc | null, kind: "content" | "lifecycle" | "remove" = "content") => ctx.store.update("state", initial, raw => { const state = validate(raw), d = change(state); validate(state); if (kind !== "remove") admit(state, kind === "lifecycle"); return { value: state, result: `${d ? `Saved privately: ${d.id} · revision ${d.revision}\n${d.preview ? `Preview token: ${d.preview.token}\nNext: ${route} preview ${d.id} ${d.preview.token}` : `Next: ${route} show ${d.id}`}` : "Deleted privately."}\n${usage(state)}` }; });
  const edit = (key: string, change: (d: Doc) => void, kind: "content" | "lifecycle" | "remove" = "content") => { const expected = get(s, key).revision; return save(state => { const d = get(state, key); assertRevision(d.revision, expected); change(d); d.revision++; if (d.preview) d.preview.revision = d.revision; return d; }, kind); };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { if (parsePage(m[1]) !== 1) throw new Error("Page out of range; use list."); return `${usage(s)}\n${s.records.map(d => `${d.id} · ${d.title} · revision ${d.revision}; ${d.preview ? "preview pending" : "no preview"}; ${d.undo === null ? "no undo" : "undo retained"}`).join("\n") || `No documents. Start: ${metadata.example}`}`; }
  if ((m = command.match(/^(show|copy) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const d = get(s, m[2]); return render(d, m[1], m[1] === "show" ? JSON.stringify(envelope(d), null, 2) : d.current, parsePage(m[3]), m[4]); }
  if ((m = command.match(/^preview (\S+) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const d = get(s, m[1]); if (!d.preview || d.preview.token !== m[2]) throw new Error("Preview changed or missing. Run scan again; no stale token can apply."); return render(d, `preview ${d.id} ${d.preview.token}`, previewText(d), parsePage(m[3]), m[4], true); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Legacy record exceeds export limit; use show pages then delete."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const d = get(s, m[1]); if (!m[2]) return `Delete original/current/literals/preview/undo: ${route} delete ${d.id} confirm`; return save(state => { assertRevision(get(state, d.id).revision, d.revision); state.records = state.records.filter(x => x.id !== d.id); return null; }, "remove"); }
  if (command.startsWith("create ")) { const [title, source] = fields(command.slice(7), [120, 16000]); return save(state => { const d: Doc = { id: newId, revision: 1, title, original: source, current: source, literals: [], enabled: [], preview: null, undo: null }; state.records.push(d); return d; }); }
  if ((m = command.match(/^(revise|original|title) (\S+)\s*\|([\s\S]+)$/))) { const [, verb, key, input] = m, [value] = fields(input, [verb === "title" ? 120 : 16000]); return edit(key, d => { if (verb === "revise") d.current = value; else if (verb === "original") d.original = value; else d.title = value; d.preview = null; }); }
  if ((m = command.match(/^literal (\S+) (add|edit) ([\s\S]+)$/))) { const [, key, action, input] = m, f = fields(input, action === "add" ? [1200] : [36, 1200]); return edit(key, d => { if (action === "add") d.literals.push({ id: newId, value: f[0] }); else { const l = d.literals.find(l => l.id === f[0]); if (!l) throw new Error("Literal not found; use show."); l.value = f[1]; } d.preview = null; }); }
  if ((m = command.match(/^remove (\S+) literal (\S+) confirm$/))) { const [, key, lid] = m; return edit(key, d => { if (!d.literals.some(l => l.id === lid)) throw new Error("Literal not found."); d.literals = d.literals.filter(l => l.id !== lid); d.preview = null; }, "remove"); }
  if ((m = command.match(/^(scan|settings) (\S+)\s*\|([\s\S]+)$/))) { const [, verb, key, input] = m, [value] = fields(input, [40]); const enabled = value === "none" ? [] : value.split(",").map(x => v.parse(category, x.trim())); if (new Set(enabled).size !== enabled.length) throw new Error("Duplicate scan categories."); return edit(key, d => { d.enabled = categories.filter(c => enabled.includes(c)); d.preview = null; if (verb === "scan") { const spans = detect(d); d.preview = { token: newId, revision: d.revision, spans, selected: spans.map((_, i) => i + 1) }; } }, "lifecycle"); }
  if ((m = command.match(/^select (\S+) (\S+)\s*\|([\s\S]+)$/))) { const [, key, token, input] = m, [value] = fields(input, [120]); const selected = value === "none" ? [] : value.split(",").map(x => parseInteger(x.trim(), { min: 1, max: 30, label: "Span" })).sort((a, b) => a - b); return edit(key, d => { if (!d.preview || d.preview.token !== token) throw new Error("Preview changed or missing; run scan again."); d.preview = { ...d.preview, token: newId, selected }; }, "lifecycle"); }
  if ((m = command.match(/^apply (\S+) (\S+)$/))) { const [, key, token] = m; return edit(key, d => { if (!d.preview || d.preview.token !== token) throw new Error("Preview changed or missing; run scan again."); const result = masked(d); d.undo = d.current; d.current = result; d.preview = null; }, "lifecycle"); }
  if ((m = command.match(/^undo (\S+)$/))) return edit(m[1], d => { if (d.undo === null) throw new Error("No undo version retained. Inspect original/current with show."); d.current = d.undo; d.undo = null; d.preview = null; }, "lifecycle");
  if ((m = command.match(/^clear (\S+) (original|current|undo|preview|literals|settings) confirm$/))) { const [, key, field] = m; return edit(key, d => { if (field === "original" || field === "current") d[field] = ""; else if (field === "undo") d.undo = null; else if (field === "literals") d.literals = []; else if (field === "settings") d.enabled = []; d.preview = null; }, "remove"); }
  throw new Error(`Unknown or incomplete command. Use ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
