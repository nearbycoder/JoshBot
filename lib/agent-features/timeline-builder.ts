import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./timeline-builder.metadata.js";
import { boundedText as kitBoundedText, pipeFields as kitPipeFields, parsePage as kitParsePage, paginateParts as kitPaginateParts, pageAt as kitPageAt } from "./feature-kit/command-and-display.js";
import { assertQuota as kitAssertQuota, assertRevision as kitAssertRevision, assertStateVersion as kitAssertStateVersion, serializedBytes as kitSerializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate as kitCivilDate, normalizeInstant as kitNormalizeInstant } from "./feature-kit/civil-time.js";

class CommandError extends Error {}
// Only pure local validation is trusted as guidance. Never wrap backend/service I/O.
function checked<T>(work: () => T): T {
  try { return work(); }
  catch (error) { throw new CommandError(error instanceof Error ? error.message : "Invalid input."); }
}
const boundedText: typeof kitBoundedText = (...args) => checked(() => kitBoundedText(...args));
const pipeFields: typeof kitPipeFields = (...args) => checked(() => kitPipeFields(...args));
const parsePage: typeof kitParsePage = (...args) => checked(() => kitParsePage(...args));
const paginateParts: typeof kitPaginateParts = (...args) => checked(() => kitPaginateParts(...args));
const pageAt: typeof kitPageAt = (...args) => checked(() => kitPageAt(...args));
const assertQuota: typeof kitAssertQuota = (...args) => checked(() => kitAssertQuota(...args));
const assertRevision: typeof kitAssertRevision = (...args) => checked(() => kitAssertRevision(...args));
const assertStateVersion: typeof kitAssertStateVersion = (...args) => checked(() => kitAssertStateVersion(...args));
const serializedBytes: typeof kitSerializedBytes = (...args) => checked(() => kitSerializedBytes(...args));
const civilDate: typeof kitCivilDate = (...args) => checked(() => kitCivilDate(...args));
const normalizeInstant: typeof kitNormalizeInstant = (...args) => checked(() => kitNormalizeInstant(...args));

const route = "/nobo-help agent timeline-builder", MAX_REV = 999_999_999;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = v.pipe(v.string(), v.regex(uuid));
const text = (bytes: number, empty = false) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, trim: false, allowEmpty: empty }); return empty || !!s.trim(); } catch { return false; } }));
const date = v.variant("kind", [v.strictObject({ kind: v.literal("civil"), value: v.pipe(v.string(), v.check(s => { try { return civilDate(s) === s; } catch { return false; } })) }), v.strictObject({ kind: v.literal("instant"), value: v.pipe(v.string(), v.check(s => { try { normalizeInstant(s); return true; } catch { return false; } })) }), v.strictObject({ kind: v.literal("unknown"), value: v.null() })]);
const entry = v.strictObject({ id, label: text(160), date, sourceLabel: text(200), excerpt: text(600), dispute: v.nullable(text(256)) });
const order = v.strictObject({ id, before: id, after: id });
const record = v.strictObject({ id, title: text(160), revision: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_REV)), entries: v.pipe(v.array(entry), v.maxLength(30)), orders: v.pipe(v.array(order), v.maxLength(50)) });
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(record), v.maxLength(12)) });
type Timeline = v.InferOutput<typeof record>;
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
const envelope = (r: Timeline) => ({ feature: metadata.id, version: 1, record: r });
function validate(raw: unknown): State {
  assertStateVersion(raw, 1);
  const result = v.safeParse(schema, raw);
  if (!result.success) throw new CommandError("Invalid saved timeline fields; data preserved. Ask the operator for scoped recovery; help remains available.");
  const ids: string[] = [];
  for (const r of result.output.records) {
    ids.push(r.id, ...r.entries.map(e => e.id), ...r.orders.map(e => e.id));
    const degree = new Map(r.entries.map(e => [e.id, 0])), outgoing = new Map(r.entries.map(e => [e.id, [] as string[]]));
    if (new Set(r.orders.map(e => `${e.before}/${e.after}`)).size !== r.orders.length) throw new CommandError("Duplicate order constraint; nothing changed.");
    for (const e of r.orders) {
      if (e.before === e.after || !degree.has(e.before) || !degree.has(e.after)) throw new CommandError("Order constraints need two different existing entries; nothing changed.");
      degree.set(e.after, degree.get(e.after)! + 1); outgoing.get(e.before)!.push(e.after);
    }
    const queue = r.entries.filter(e => degree.get(e.id) === 0).map(e => e.id);
    for (let i = 0; i < queue.length; i++) for (const child of outgoing.get(queue[i])!) { degree.set(child, degree.get(child)! - 1); if (degree.get(child) === 0) queue.push(child); }
    if (queue.length !== r.entries.length) throw new CommandError("Declared order cycle rejected atomically. Remove or reverse a constraint; observations remain unchanged.");
  }
  if (new Set(ids).size !== ids.length) throw new CommandError("Duplicate saved IDs; data preserved.");
  return result.output;
}
function quota(s: State, content: boolean) {
  // Every observation can acquire/correct one 256-byte dispute. Quotes maximize JSON expansion.
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REV, entries: r.entries.map(e => ({ ...e, dispute: '"'.repeat(256) })) })) };
  assertQuota(s, content ? { kind: "content", records: s.records.map(envelope), future: { value: future, records: future.records.map(envelope) } } : { kind: "lifecycle", records: s.records.map(envelope) });
  assertQuota(future, { kind: "lifecycle", records: future.records.map(envelope) });
  for (const r of s.records) render(r, "show", JSON.stringify(envelope(r), null, 2), 1);
}
const fields = (input: string, sizes: number[]) => pipeFields(input, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i] }));
const get = (s: State, key: string) => { const r = s.records.find(r => r.id === key); if (!r) throw new CommandError(`Item not found in your private records. Use ${route} list`); return r; };
const getEntry = (r: Timeline, key: string) => { const e = r.entries.find(e => e.id === key); if (!e) throw new CommandError("Entry not found; inspect show for full IDs."); return e; };
function parseDate(value: string): Timeline["entries"][number]["date"] {
  if (value === "unknown") return { kind: "unknown", value: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "civil", value: civilDate(value) };
  normalizeInstant(value); return { kind: "instant", value };
}
function render(r: Timeline, verb: string, body: string, page: number, expected?: string) {
  if ((page > 1 && !expected) || (expected !== undefined && String(r.revision) !== expected)) throw new CommandError(`This timeline page changed or needs a revision. Restart: ${route} ${verb} ${r.id} page 1`);
  return pageAt(paginateParts(body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g).map((text, i) => ({ text, atomic: i % 2 === 1 })), { mode: "plain", title: `Timeline ${r.id} · revision ${r.revision}`, command: p => `${route} ${verb} ${r.id} page ${p} rev ${r.revision}` }), page).text;
}
function orderStatus(a: Timeline["entries"][number], b: Timeline["entries"][number]) {
  const x = a.date, y = b.date;
  if (x.kind === "unknown" || y.kind === "unknown") return "unknown chronology; declared order only";
  if (x.kind === "civil" && y.kind === "civil") return x.value > y.value ? "CONTRADICTION: reversed civil-date labels" : x.value < y.value ? "consistent civil-date labels" : "same civil date; within-day order unknown";
  if (x.kind === "instant" && y.kind === "instant") {
    const first = Date.parse(normalizeInstant(x.value)), second = Date.parse(normalizeInstant(y.value));
    return first > second ? "CONTRADICTION: known instant is later" : first < second ? "consistent exact instants" : "same instant; strict before is unproven";
  }
  // An unzoned civil day may occupy any instant across offsets -14:00..+14:00.
  // These are comparison bounds only, never invented observation timestamps.
  const interval = (d: typeof x): [number, number] => d.kind === "instant" ? [Date.parse(normalizeInstant(d.value)), Date.parse(normalizeInstant(d.value))] : [Date.parse(`${d.value}T00:00:00Z`) - 14 * 3600000, Date.parse(`${d.value}T00:00:00Z`) + 38 * 3600000];
  const [lo, hi] = interval(x), [otherLo, otherHi] = interval(y);
  return lo > otherHi ? "CONTRADICTION: even broad civil-date bounds are later" : hi < otherLo ? "consistent disjoint bounds" : "mixed precision overlaps; order unknown without the declaration";
}
function view(r: Timeline) {
  const out = ["Precision bands are separate; their display order does not establish chronology across bands. Equal dates/instants retain input order. Sources are user labels, not verification.\n"];
  for (const kind of ["instant", "civil", "unknown"] as const) {
    out.push(`\n${kind === "instant" ? "Exact offset instants" : kind === "civil" ? "Civil-date labels (no timezone or midnight inferred)" : "Unknown dates"}:\n`);
    const entries = r.entries.filter(e => e.date.kind === kind).sort((a, b) => kind === "instant" ? Date.parse(a.date.value!) - Date.parse(b.date.value!) : (a.date.value ?? "").localeCompare(b.date.value ?? ""));
    for (const e of entries) out.push(`${e.id} · ${e.label}\nDate: ${e.date.value ?? "unknown"} (${e.date.kind})\nSource: ${e.sourceLabel}\nExact excerpt: ${e.excerpt}\nDispute: ${e.dispute ?? "none recorded"}\n`);
  }
  out.push("\nDeclared before constraints (acyclic; declarations are not proof):\n");
  for (const e of r.orders) out.push(`${e.id}: ${e.before} before ${e.after} · ${orderStatus(getEntry(r, e.before), getEntry(r, e.after))}\n`);
  return out.join("");
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 });
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID();
  // Whole-root erasure is a separate operation, never an admission flag. Each
  // root has independent lifecycle reservations, so retaining an exact subset
  // strictly reduces actual bytes and cannot increase any projected quota.
  const deleteRoot = (key: string) => {
    const expected = JSON.stringify(get(s, key));
    return ctx.store.update("state", initial, raw => {
      const state = validate(raw), target = get(state, key);
      if (JSON.stringify(target) !== expected) throw new CommandError("Record changed; inspect before deleting again.");
      const beforeBytes = serializedBytes(state);
      state.records = state.records.filter(r => r.id !== key);
      validate(state);
      if (serializedBytes(state) >= beforeBytes) throw new CommandError("Removal did not reduce saved data; nothing changed.");
      return { value: state, result: `Deleted privately: ${key}\nNext: ${route} list` };
    });
  };
  const save = (key: string | undefined, change: (s: State, r?: Timeline) => string, content = true) => {
    const expected = key === undefined ? undefined : get(s, key).revision;
    return ctx.store.update("state", initial, raw => {
      const state = validate(raw), r = key === undefined ? undefined : get(state, key);
      if (r) assertRevision(r.revision, expected);
      const detail = change(state, r);
      if (r && state.records.includes(r)) { if (r.revision === MAX_REV) throw new CommandError("Revision limit reached; export then delete this record."); r.revision++; }
      validate(state); quota(state, content);
      return { value: state, result: `${detail}\n${serializedBytes(state)}/49152 state bytes.\nNext: ${route} ${key && state.records.some(r => r.id === key) ? `view ${key}` : "list"}` };
    });
  };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) {
    const p = parsePage(m[1]), total = Math.max(1, Math.ceil(s.records.length / 10)); if (p > total) throw new CommandError(`Page out of range. Restart: ${route} list 1`);
    return `Private current list · ${p}/${total}\n${s.records.slice((p - 1) * 10, p * 10).map(r => `${r.id} · ${r.title.replace(/[\r\n]/g, " ")} · revision ${r.revision}`).join("\n") || `No timelines. Start: ${metadata.example}`}\n${p < total ? `Next: ${route} list ${p + 1}` : ""}`;
  }
  if ((m = command.match(/^(show|view) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const r = get(s, m[2]); return render(r, m[1], m[1] === "show" ? JSON.stringify(envelope(r), null, 2) : view(r), parsePage(m[3]), m[4]); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new CommandError("Record exceeds export limit; retrieve show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const key = get(s, m[1]).id; if (!m[2]) return `Delete timeline and all observations/orders: ${route} delete ${key} confirm`; return deleteRoot(key); }
  if (command.startsWith("create ")) { const [title] = fields(command.slice(7), [160]); return save(undefined, state => { if (state.records.length === 12) throw new CommandError("Maximum 12 timelines. Export/delete one explicitly."); state.records.push({ id: newId, title, revision: 1, entries: [], orders: [] }); return `Saved privately: ${newId}\nInspect: ${route} view ${newId}`; }); }
  if ((m = command.match(/^edit (\S+)\s*\|([\s\S]+)$/))) { const [, key, input] = m, [title] = fields(input, [160]); return save(key, (_, r) => { r!.title = title; return `Updated timeline: ${key}`; }); }
  if ((m = command.match(/^entry (\S+) (add|edit) ([\s\S]+)$/))) {
    const [, key, action, input] = m, f = fields(input, action === "add" ? [160, 29, 200, 600] : [36, 160, 29, 200, 600]), eid = action === "edit" ? f.shift()! : newId, [label, dateInput, sourceLabel, excerpt] = f, parsedDate = parseDate(dateInput);
    return save(key, (_, r) => { if (action === "add") { if (r!.entries.length === 30) throw new CommandError("Maximum 30 observations; remove one explicitly."); r!.entries.push({ id: eid, label, date: parsedDate, sourceLabel, excerpt, dispute: null }); } else Object.assign(getEntry(r!, eid), { label, date: parsedDate, sourceLabel, excerpt }); return `Saved entry: ${eid}. Existing disputes/orders are retained for review.`; });
  }
  if ((m = command.match(/^(before|before-edit) (\S+) ([\s\S]+)$/))) {
    const [, action, key, input] = m, f = fields(input, action === "before" ? [36, 36] : [36, 36, 36]), oid = action === "before-edit" ? f.shift()! : newId;
    return save(key, (_, r) => { const next = { id: oid, before: f[0], after: f[1] }; if (action === "before") { if (r!.orders.length === 50) throw new CommandError("Maximum 50 order constraints; remove one explicitly."); r!.orders.push(next); } else { const e = r!.orders.find(e => e.id === oid); if (!e) throw new CommandError("Order ID not found."); Object.assign(e, next); } return `Saved order: ${oid}`; });
  }
  if ((m = command.match(/^(dispute|dispute-edit) (\S+) ([\s\S]+)$/))) { const [, action, key, input] = m, [eid, note] = fields(input, [36, 256]); return save(key, (_, r) => { const e = getEntry(r!, eid); if ((action === "dispute") !== (e.dispute === null)) throw new CommandError("Use dispute for a new note, dispute-edit to replace it, or remove TIMELINE dispute ENTRY confirm."); e.dispute = note; return `Saved dispute on entry: ${eid}. No truth winner selected.`; }, false); }
  if ((m = command.match(/^remove (\S+) (entry|order|dispute) (\S+) confirm$/))) {
    const [, key, kind, child] = m; return save(key, (_, r) => { if (kind === "order") { if (!r!.orders.some(e => e.id === child)) throw new CommandError("Order ID not found."); r!.orders = r!.orders.filter(e => e.id !== child); } else { const e = getEntry(r!, child); if (kind === "dispute") e.dispute = null; else { r!.entries = r!.entries.filter(e => e.id !== child); r!.orders = r!.orders.filter(e => e.before !== child && e.after !== child); } } return `Removed ${kind}: ${child}${kind === "entry" ? " and its incident orders/dispute" : ""}.`; }, false);
  }
  throw new CommandError(`Unknown/incomplete command. Use ${route} help`);
}
export default { ...metadata, async execute(command, ctx) { try { return await execute(command, ctx); } catch (error) { ctx.signal?.throwIfAborted(); if (error instanceof CommandError) return `${error.message}\nNext: ${route} help`;
    return `Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed. Help remains available; ask the operator about scoped state recovery if this persists.\nNext: ${route} list`; } } } satisfies AgentFeature;
