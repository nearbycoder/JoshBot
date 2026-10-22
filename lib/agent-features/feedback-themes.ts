import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, dateInZone, normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./feedback-themes.metadata.js";

const MAX_RECORDS = 12;
type Quote = { id: string; speaker: string; date: string; context: string; text: string; themeId: string };
type Theme = { id: string; label: string; counterexamples: { id: string; text: string }[]; experiment: string };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; quotes: Quote[]; themes: Theme[] };
type State = { version: 1; records: RecordData[] };
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "quotes", "themes"]); validBase(v); array(v.quotes, 30); array(v.themes, 10);
  for (const t of v.themes) { object(t, ["id", "label", "counterexamples", "experiment"]); validId(t.id); validText(t.label, 160); validText(t.experiment, 320, true); array(t.counterexamples, 3); for (const e of t.counterexamples) { object(e, ["id", "text"]); validId(e.id); validText(e.text, 1000); } }
  for (const q of v.quotes) { object(q, ["id", "speaker", "date", "context", "text", "themeId"]); validId(q.id); validText(q.speaker, 160); civilDate(q.date); validText(q.context, 500); validText(q.text, 1000); if (q.themeId !== "") { validId(q.themeId); if (!v.themes.some((t: Theme) => t.id === q.themeId)) throw new Error("Dangling theme assignment."); } }
  unique([...v.quotes.map((q: Quote) => q.id), ...v.themes.flatMap((t: Theme) => [t.id, ...t.counterexamples.map(e => e.id)])]);
}
function projectLifecycle(s: State): State {
  // Every admitted quote can be assigned; every admitted theme can receive a full
  // worst-escaped response experiment. Counterexamples are optional new content.
  return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION,
    quotes: r.quotes.map(q => ({ ...q, themeId: "theme-00000000-0000-0000-0000-000000000000" })),
    themes: r.themes.map(t => ({ ...t, experiment: "\\".repeat(320) })),
  })) };
}
function quote(r: RecordData, id: string): Quote { const q = r.quotes.find(q => q.id === id); if (!q) fail("Quote not found in this review."); return q; }
function theme(r: RecordData, id: string): Theme { const t = r.themes.find(t => t.id === id); if (!t) fail("Theme not found in this review."); return t; }
function counts(quotes: Quote[]): string {
  const exactEvidence = new Set(quotes.map(q => JSON.stringify([q.speaker, q.date, q.context, q.text]))).size;
  return `${quotes.length} retained entries; ${new Set(quotes.map(q => q.text)).size} distinct exact quote texts; ${quotes.length - exactEvidence} duplicate evidence entries (same supplied speaker/date/context/text); ${exactEvidence} separately entered evidence tuples; ${new Set(quotes.map(q => q.speaker)).size} distinct supplied speaker labels.`;
}
function themes(r: RecordData): string {
  const lines = [`${r.id} · ${r.title}`, counts(r.quotes), "Repeated wording is not consensus. Separately entered excerpts are not verified independent evidence; supplied speaker labels are not verified distinct people. No personality or psychological finding is inferred."];
  for (const t of r.themes) {
    const assigned = r.quotes.filter(q => q.themeId === t.id);
    lines.push(`\nTheme ${t.id} · ${t.label} (manual interpretation)`, counts(assigned));
    for (const q of assigned) lines.push(`Quote ${q.id} · supplied label ${q.speaker} · ${q.date} · context ${q.context}: “${q.text}”`);
    if (t.counterexamples.length) { lines.push("Counterevidence / contradictions retained:"); for (const e of t.counterexamples) lines.push(`${e.id}: ${e.text}`); } else lines.push("No counterexample entered; absence is not agreement.");
    lines.push(`User response experiment: ${t.experiment || "not entered"}. No external action performed.`);
  }
  const unassigned = r.quotes.filter(q => !q.themeId);
  lines.push(`\nCoverage: ${r.quotes.length - unassigned.length}/${r.quotes.length} entries manually assigned. Unassigned IDs: ${unassigned.map(q => q.id).join(", ") || "none"}.`);
  for (const q of unassigned) lines.push(`Unassigned ${q.id} · ${q.speaker} · ${q.date} · ${q.context}: “${q.text}”`);
  return lines.join("\n");
}
async function suggest(context: AgentFeatureContext, id: string): Promise<string> {
  const r = find(await read(context), id); if (!r.quotes.length) fail("Add at least one quote before requesting grouping suggestions.");
  const input = JSON.stringify({ quotes: r.quotes.map(({ id, speaker, date, context, text }) => ({ id, speaker, date, context, text })), existingThemes: r.themes.map(({ id, label }) => ({ id, label })) });
  const instructions = 'Return exactly JSON {groups:[[existing quote IDs]],unassigned:[existing quote IDs]}. Groups: at most 10 nonempty arrays. Each current quote ID must appear exactly once across groups and unassigned. Empty groups is valid when all IDs are unassigned. No labels, quotations, personalities, identities, prose or additional keys. Keep conflicting excerpts available; grouping is a suggestion only.';
  const render = (p: { groups: string[][]; unassigned: string[] }) => {
    const lines = [`Unsaved grouping suggestion · ${r.id} · revision ${r.revision}`, `Coverage: ${r.quotes.length}/${r.quotes.length} quote IDs accounted for exactly once; ${r.quotes.length - p.unassigned.length} grouped, ${p.unassigned.length} unassigned.`];
    p.groups.forEach((ids, i) => lines.push(`Proposed group ${i + 1}: ${ids.join(", ")}`));
    lines.push(`Unassigned: ${p.unassigned.join(", ") || "none"}.`, "Review exact quotations and counterevidence with themes/show. Repetition is not consensus; labels are not verified people. Suggestions remain unsaved: create your own theme label and assign quotes manually.", `Next: ${ROUTE} themes ${r.id}`); return lines.join("\n");
  };
  // Both zero-group/all-unassigned and one-group/all-assigned layouts are allowed.
  // More groups strictly add punctuation/labels; compare all 0..10 group counts and
  // all possible unassigned counts to obtain true minima without exponential search.
  const ids = r.quotes.map(q => q.id), layouts: { groups: string[][]; unassigned: string[] }[] = [];
  for (let remaining = 0; remaining <= ids.length; remaining++) {
    const grouped = ids.length - remaining;
    for (let groups = 0; groups <= Math.min(10, grouped); groups++) {
      if ((groups === 0) !== (grouped === 0)) continue;
      const chunks = groups === 0 ? [] : [...ids.slice(0, groups - 1).map(id => [id]), ids.slice(groups - 1, grouped)];
      layouts.push({ groups: chunks, unassigned: ids.slice(grouped) });
    }
  }
  if (Buffer.byteLength(input) > 16000 || Math.min(...layouts.map(p => JSON.stringify(p).length)) > 4000 || Math.min(...layouts.map(p => render(p).length)) > 3500) fail(`The complete grouping request cannot fit assistance limits. Shorten quotes/context or use manual themes/assignments; no model call was made.`);
  if (Buffer.byteLength(instructions) > 4000) fail("Assistance instructions exceed capacity; use manual themes.");
  const raw = await context.services.generate({ instructions, input }); context.signal?.throwIfAborted();
  if (stamp(find(await read(context), id)) !== stamp(r)) fail("Review changed while suggestions ran; the unsaved grouping was discarded. Reopen themes.");
  let p: { groups: string[][]; unassigned: string[] };
  try {
    if (typeof raw !== "string" || raw.length > 4000 || !raw.isWellFormed()) throw new Error();
    const parsed = JSON.parse(raw); object(parsed, ["groups", "unassigned"]); array(parsed.groups, 10); array(parsed.unassigned, 30);
    for (const group of parsed.groups) { array(group, 30); if (!group.length) throw new Error(); }
    const all = [...parsed.groups.flat(), ...parsed.unassigned]; if (all.length !== ids.length || all.some(x => typeof x !== "string" || !ids.includes(x))) throw new Error(); unique(all);
    p = { groups: parsed.groups, unassigned: parsed.unassigned }; if (render(p).length > 3500) throw new Error();
  } catch { fail("Invalid grouping output: complete unique existing quote IDs are required. Nothing was saved; use manual themes or explicitly request suggestions again."); }
  return render(p);
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [title] = fields(rest, 160), r: RecordData = { ...base(context, "feedback", text(title, "Review", 160)), quotes: [], themes: [] };
    return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Private feedback review created. Add exact quotes with supplied labels and context."); });
  }
  if (verb === "edit" || verb === "clear") {
    const v = verb === "edit" ? fields(rest, 80, 16, 160) : words(rest, 3), [id, key] = v, clear = verb === "clear";
    if (key !== "title" || (clear && v[2] !== "confirm")) fail("Use edit REVIEW | title | VALUE or clear REVIEW title confirm.");
    return mutate(context, id, (_, r) => { r!.title = text(clear ? "" : v[2], "Review", 160, clear); return saved(id, "Review label updated."); }, clear ? "remove" : "content");
  }
  if (verb === "quote") {
    const m = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use quote REVIEW add SPEAKER | DATE | CONTEXT | QUOTE; see help for edit/remove.");
    const [, id, mode, input] = m;
    if (mode === "remove") { const [qid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Quote removal requires confirm."); return mutate(context, id, (_, r) => { quote(r!, qid); r!.quotes = r!.quotes.filter(q => q.id !== qid); return saved(id, "Quote and assignment removed. Counterexamples remain.", `themes ${id}`); }, "remove"); }
    const v = fields(input, ...(mode === "add" ? [160, 10, 500, 1000] : [80, 160, 10, 500, 1000])), offset = mode === "add" ? 0 : 1, qid = offset ? v[0] : `quote-${randomUUID()}`;
    const data = { speaker: text(v[offset], "Supplied speaker", 160), date: checked(() => civilDate(v[offset + 1])), context: text(v[offset + 2], "Context", 500), text: text(v[offset + 3], "Exact quote", 1000) };
    return mutate(context, id, (_, r) => { if (mode === "add") { if (r!.quotes.length >= 30) fail("Maximum 30 feedback excerpts. Remove one explicitly first."); r!.quotes.push({ id: qid, ...data, themeId: "" }); } else { Object.assign(quote(r!, qid), data, { themeId: "" }); } return saved(id, `Quote ${qid} saved exactly. Edited quotes become unassigned for manual reassessment.`, `themes ${id}`); });
  }
  if (verb === "theme") {
    const m = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use theme REVIEW add LABEL, edit THEME | LABEL, or remove THEME confirm."); const [, id, mode, input] = m;
    if (mode === "remove") { const [tid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Theme removal requires confirm."); return mutate(context, id, (_, r) => { theme(r!, tid); r!.themes = r!.themes.filter(t => t.id !== tid); for (const q of r!.quotes) if (q.themeId === tid) q.themeId = ""; return saved(id, "Theme/counterexamples/experiment removed; its quotes retained and unassigned.", `themes ${id}`); }, "remove"); }
    const v = fields(input, ...(mode === "add" ? [160] : [80, 160])), label = text(v.at(-1), "Theme label", 160), tid = mode === "add" ? `theme-${randomUUID()}` : v[0];
    return mutate(context, id, (_, r) => { if (mode === "add") { if (r!.themes.length >= 10) fail("Maximum 10 themes. Remove one explicitly first."); r!.themes.push({ id: tid, label, counterexamples: [], experiment: "" }); } else theme(r!, tid).label = label; return saved(id, `Manual theme ${tid} saved. Its interpretation is yours, not a psychological finding.`, `themes ${id}`); });
  }
  if (verb === "assign") {
    const [head, tid] = fields(rest, 170, 80), [id, qid] = words(head, 2);
    return mutate(context, id, (_, r) => { theme(r!, tid); quote(r!, qid).themeId = tid; return saved(id, "Manual assignment saved.", `themes ${id}`); }, "lifecycle");
  }
  if (verb === "unassign") {
    const [id, qid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Unassign requires confirm.");
    return mutate(context, id, (_, r) => { quote(r!, qid).themeId = ""; return saved(id, "Assignment removed; quote retained.", `themes ${id}`); }, "remove");
  }
  if (verb === "counterexample" || verb === "counterexample-edit") {
    const [head, value] = fields(rest, 250, 1000), v = words(head, verb === "counterexample" ? 2 : 3), [id, tid] = v, eid = v[2] ?? `counter-${randomUUID()}`, content = text(value, "Counterexample");
    return mutate(context, id, (_, r) => { const t = theme(r!, tid); if (v[2]) { const e = t.counterexamples.find(e => e.id === eid); if (!e) fail("Counterexample not found."); e.text = content; } else { if (t.counterexamples.length >= 3) fail("Maximum 3 counterexamples per theme."); t.counterexamples.push({ id: eid, text: content }); } return saved(id, `Counterexample ${eid} saved and remains visible alongside supporting excerpts.`, `themes ${id}`); });
  }
  if (verb === "counterexample-remove") {
    const [id, tid, eid, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Counterexample removal requires confirm.");
    return mutate(context, id, (_, r) => { const t = theme(r!, tid); if (!t.counterexamples.some(e => e.id === eid)) fail("Counterexample not found."); t.counterexamples = t.counterexamples.filter(e => e.id !== eid); return saved(id, "Counterexample explicitly removed.", `themes ${id}`); }, "remove");
  }
  if (verb === "experiment") {
    const [head, value] = fields(rest, 170, 320), [id, tid] = words(head, 2);
    return mutate(context, id, (_, r) => { theme(r!, tid).experiment = text(value, "Response experiment", 320); return saved(id, "Current response experiment saved; no action performed and no hidden prior version retained.", `themes ${id}`); }, "lifecycle");
  }
  if (verb === "experiment-remove") {
    const [id, tid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Experiment removal requires confirm.");
    return mutate(context, id, (_, r) => { theme(r!, tid).experiment = ""; return saved(id, "Response experiment removed.", `themes ${id}`); }, "remove");
  }
  if (verb === "themes") { const args = words(rest, 1, 4), r = find(await read(context), args[0]); return report(themes(r), `themes ${r.id}`, r, args.slice(1)); }
  if (verb === "suggest-themes") { const [id] = words(rest, 1); return suggest(context, id); }
  fail("Unknown command. Use help for supported grammar.");
}

const ROUTE = `/nobo-help agent ${metadata.id}`;
const MAX_REVISION = 999_999_999;
const EMPTY: State = { version: 1, records: [] };
class CommandError extends Error {}
function fail(message: string): never { throw new CommandError(message); }
// Only pure, known validation/rendering helpers are wrapped. Backend/provider errors
// never enter this wrapper and cannot become trusted user-facing diagnostics.
function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof Error) fail(error.message);
    throw error;
  }
}
function text(value: unknown, label: string, maxBytes = 1000, empty = false, maxUnits = maxBytes): string {
  return checked(() => boundedText(value, { label, maxBytes, maxUnits, allowEmpty: empty }));
}
function fields(input: string, ...limits: number[]): string[] {
  return checked(() => pipeFields(input, limits.map((maxBytes, i) => ({ label: `Field ${i + 1}`, maxBytes: maxBytes + 2, allowEmpty: true })))
    .map((v, i) => boundedText(v, { label: `Field ${i + 1}`, maxBytes: limits[i], allowEmpty: true })));
}
function words(input: string, min: number, max = min): string[] {
  const parts = input.trim() ? input.trim().split(/\s+/u) : [];
  if (parts.length < min || parts.length > max) fail("Wrong arguments. Use the exact grammar in help.");
  return parts;
}
function integer(value: string, min: number, max: number, label = "Value"): number {
  return checked(() => parseInteger(value, { min, max, label }));
}
function object(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.slice().sort().join(",")) throw new Error("Invalid object fields.");
}
function validText(value: unknown, maxBytes = 1000, empty = false, maxUnits = maxBytes): void {
  boundedText(value, { label: "Saved text", maxBytes, maxUnits, allowEmpty: empty, trim: false });
}
function validNumber(value: unknown, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid number.");
}
function validId(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid ID.");
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(`Choose ${values.join(", ")}.`);
  return value as T;
}
function array(value: unknown, max: number): asserts value is any[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid saved collection.");
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error("Duplicate IDs.");
}
function validBase(r: Record<string, any>): void {
  validId(r.id); validText(r.title, 160, true); validNumber(r.revision, 1, MAX_REVISION);
  for (const value of [r.createdAt, r.updatedAt]) {
    if (typeof value !== "string" || checked(() => normalizeInstant(value)) !== value || !/^\d{4}-.*\.\d{3}Z$/.test(value)) throw new Error("Invalid saved instant.");
  }
}
function decode(value: unknown): State {
  try {
    serializedBytes(value); assertStateVersion(value, 1); object(value, ["version", "records"]);
    array(value.records, MAX_RECORDS);
    for (const record of value.records) validateRecord(record);
    unique(value.records.map(r => r.id));
    return value as State;
  } catch { fail("Saved data could not be read safely. It was preserved; no reset or mutation was performed."); }
}
const envelope = (record: RecordData) => ({ feature: metadata.id, version: 1, record });
function quota(state: State, kind: "content" | "lifecycle"): void {
  checked(() => {
    const future = projectLifecycle(state);
    const limits = { maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS };
    assertQuota(state, kind === "content"
      ? { kind, records: state.records.map(envelope), limits, future: { value: future, records: future.records.map(envelope) } }
      : { kind, records: state.records.map(envelope), limits });
    // Even a lifecycle write must leave room for every other admitted record.
    assertQuota(future, { kind: "lifecycle", records: future.records.map(envelope), limits });
  });
}
function find(state: State, id: string): RecordData {
  const r = state.records.find(r => r.id === id);
  if (!r) fail("Item not found in your private records. Use list to find its complete ID.");
  return r;
}
async function read(context: AgentFeatureContext): Promise<State> {
  const raw = await context.store.read<unknown>("state");
  context.signal?.throwIfAborted();
  return raw === null ? structuredClone(EMPTY) : decode(raw);
}
async function mutate(context: AgentFeatureContext, id: string | undefined, change: (s: State, r?: RecordData) => string,
  kind: "content" | "lifecycle" | "remove" = "content", expected?: RecordData): Promise<string> {
  const intended = id === undefined ? undefined : JSON.stringify(expected ?? find(await read(context), id));
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, raw => {
    const s = structuredClone(decode(raw)), r = id === undefined ? undefined : find(s, id);
    if (r && JSON.stringify(r) !== intended) fail(`This item changed; inspect it before retrying: ${ROUTE} show ${id}`);
    if (r && r.revision === MAX_REVISION && kind !== "remove") fail("Revision limit reached. Export/show, then delete this whole record and create a new one; edits and lifecycle writes are unavailable.");
    const reply = change(s, r);
    if (s.records.length > MAX_RECORDS) fail(`Maximum ${MAX_RECORDS} records. Use list, then delete ID confirm to free space.`);
    if (r && s.records.includes(r)) {
      if (kind !== "remove") { r.revision++; r.updatedAt = timestamp; }
      // Removal is content-stamped. Keeping the clock prevents byte-growing numeric
      // rollover from blocking a one-byte deletion, including at the revision ceiling.
    }
    decode(s);
    if (kind === "remove") {
      if (serializedBytes(s) >= serializedBytes(raw)) fail("Nothing was removed. Choose a populated field or an existing child; removal must reduce saved bytes.");
    } else {
      quota(s, kind);
      for (const record of s.records) detailPages(record); // prove lossless retrieval at admission
    }
    return { value: s, result: reply };
  });
}
function base(context: AgentFeatureContext, prefix: string, title: string) {
  return { id: `${prefix}-${randomUUID()}`, title, revision: 1, createdAt: context.now.toISOString(), updatedAt: context.now.toISOString() };
}
function saved(id: string, detail: string, next = `show ${id}`): string {
  return `Saved privately: ${id}\n${detail}\nNext: ${ROUTE} ${next}`;
}
function stamp(r: RecordData): string { return `${r.revision}-${createHash("sha256").update(JSON.stringify(r)).digest("hex")}`; }
function pageNumber(r: RecordData, command: string, args: string[]): number {
  if (![0, 1, 3].includes(args.length)) fail("Copy the full PAGE rev TOKEN continuation or restart page 1.");
  const page = checked(() => parsePage(args[0]));
  if (args.length === 3 && (args[1] !== "rev" || args[2] !== stamp(r))) fail(`This item changed; stale continuation rejected. Restart: ${ROUTE} ${command} 1`);
  return page;
}
// Known local/source identifiers are atomic even when embedded in prose or JSON.
function parts(input: string): { text: string; atomic?: boolean }[] {
  // Coalesce small atoms into bounded chunks. Dense IDs in readable legacy data
  // must not exhaust the kit's 4096-part limit. No known ID, URL or command splits.
  const result: { text: string; atomic?: boolean }[] = [];
  const tokens = /(?:[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolbox:goals:[A-Za-z0-9_.:-]+|(?:e1|s1):[a-f0-9]{64}|https?:\/\/[^\s]+|\/nobo-help[^\r\n]*|[\s\S])/gu;
  let chunk = "";
  for (const match of input.matchAll(tokens)) {
    const token = match[0];
    if (chunk && chunk.length + token.length > 2000) { result.push({ text: chunk, atomic: true }); chunk = ""; }
    if (token.length > 2000) result.push({ text: token, atomic: true });
    else chunk += token;
  }
  if (chunk) result.push({ text: chunk, atomic: true });
  return result;
}
function pages(body: string, command: string, r: RecordData, title = "Private · saved detail") {
  return checked(() => paginateParts(parts(body), { mode: "plain", title: `${title} · revision ${r.revision}`, command: n => `${ROUTE} ${command} ${n} rev ${stamp(r)}` }));
}
function detailPages(r: RecordData) { return pages(JSON.stringify(envelope(r), null, 2), `show ${r.id}`, r); }
function report(body: string, command: string, r: RecordData, args: string[]): string {
  return checked(() => pageAt(pages(body + `\nNext: ${ROUTE} show ${r.id}`, command, r, "Private · deterministic report"), pageNumber(r, command, args)).text);
}
async function common(verb: string, rest: string, context: AgentFeatureContext): Promise<string | undefined> {
  if (verb === "list") {
    const args = words(rest, 0, 1), page = checked(() => parsePage(args[0]));
    const s = await read(context), total = Math.max(1, Math.ceil(s.records.length / 10));
    if (page > total) fail(`Current list has ${total} page(s). Reopen list 1.`);
    if (!s.records.length) return `No saved items.\nNext: ${metadata.example}`;
    const rows = s.records.slice((page - 1) * 10, page * 10).map(r => `${r.id} — ${r.title.replace(/[\r\n]/g, " ") || "(cleared)"} · revision ${r.revision}`);
    return `Private · current list (recomputed) · page ${page}/${total} · ${(page - 1) * 10 + 1}–${Math.min(page * 10, s.records.length)} of ${s.records.length}\n${rows.join("\n")}\nNext: ${ROUTE} ${page < total ? `list ${page + 1}` : `show ${s.records[(page - 1) * 10].id}`}`;
  }
  if (verb === "show" || verb === "export") {
    const args = words(rest, 1, verb === "show" ? 4 : 1), r = find(await read(context), args[0]);
    if (verb === "export") {
      if (serializedBytes(envelope(r)) > 24_576) fail(`Legacy record exceeds the export ceiling. Retrieve all bytes using show ${r.id}.`);
      return JSON.stringify(envelope(r));
    }
    return checked(() => pageAt(detailPages(r), pageNumber(r, `show ${r.id}`, args.slice(1))).text);
  }
  if (verb === "delete") {
    const args = words(rest, 1, 2);
    if (args[1] !== "confirm") {
      if (args.length !== 1) fail("Use delete ID confirm.");
      find(await read(context), args[0]);
      return `Delete ${args[0]} and all owned children?\nNext: ${ROUTE} delete ${args[0]} confirm`;
    }
    return mutate(context, args[0], s => {
      s.records = s.records.filter(r => r.id !== args[0]);
      return `Deleted privately: ${args[0]} and all owned children.\nNext: ${ROUTE} list`;
    }, "remove");
  }
  return undefined;
}
export default {
  ...metadata,
  async execute(command: string, context: AgentFeatureContext): Promise<string> {
    if (!command.trim() || command.trim() === "help") return metadata.help;
    try {
      text(command, "Command", 16_000); context.signal?.throwIfAborted();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim())!;
      return await common(match[1], match[2] ?? "", context) ?? await executeDomain(match[1], match[2] ?? "", context);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CommandError) return `${error.message}\nNext: ${ROUTE} help`;
      return `This command could not be completed safely. Any dispatched save may have completed; inspect your private records before repeating it.\nNext: ${ROUTE} list`;
    }
  },
} satisfies AgentFeature;
