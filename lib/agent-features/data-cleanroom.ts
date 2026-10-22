import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant, civilDate } from "./feature-kit/civil-time.js";
import metadata from "./data-cleanroom.metadata.js";
const MAX_RECORDS = 6, STATE_BYTES = 65_536, CONTENT_BYTES = 49_152;
type Kind = "text" | "integer" | "decimal" | "civilDate";
type Column = { id: string; name: string; type: Kind };
type Row = { id: string; cells: string[] };
type Grid = { columns: Column[]; rows: Row[]; keys: string[] };
type Preview = { id: string; baseRevision: number; fingerprint: string; operation: "trim" | "dedupe" | "convert"; output: Grid };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; original: Grid; current: Grid; preview: Preview | null; undo: Grid | null };
type State = { version: 1; records: RecordData[] };
const KINDS = ["text", "integer", "decimal", "civilDate"] as const;
function csv(input: string): string[][] {
  checked(() => boundedText(input, { label: "CSV source", maxBytes: 16_000, maxUnits: 6000, trim: false }));
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false, closed = false, started = false;
  const cell = () => { row.push(value); if (row.length > 8) fail("Maximum 8 columns."); value = ""; closed = false; started = false; };
  const line = () => { cell(); rows.push(row); row = []; if (rows.length > 41) fail("Maximum 40 data rows plus one header."); };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '"') { if (input[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; continue; }
    if (c === ",") { cell(); continue; }
    if (c === "\n" || c === "\r") { if (c === "\r") { if (input[i + 1] !== "\n") fail("Outside quotes, use LF or CRLF row endings; bare CR is ambiguous."); i++; } line(); continue; }
    if (closed) fail("Unexpected text after closing CSV quote; delimit it with comma or newline.");
    if (c === '"') { if (started) fail("A quote must start a CSV field; double quotes inside quoted cells."); quoted = true; started = true; } else { value += c; started = true; }
  }
  if (quoted) fail("Unclosed CSV quote.");
  if (started || closed || row.length || !rows.length) line();
  if (!rows[0].length || rows.some(r => r.length !== rows[0].length)) fail("Every row must have exactly the header's column count; blank cells are explicit.");
  const names = rows[0].map(n => n.trim()); if (names.some(n => !n) || new Set(names).size !== names.length) fail("Headers must be nonblank and unique after trimming; fix ambiguous/duplicate headers explicitly.");
  rows[0].forEach(n => checked(() => boundedText(n, { label: "Header", maxBytes: 160, trim: false })));
  return rows;
}
function grid(input: string): Grid { const parsed = csv(input); return { columns: parsed[0].map(name => ({ id: `col-${randomUUID()}`, name, type: "text" })), rows: parsed.slice(1).map(cells => ({ id: `row-${randomUUID()}`, cells })), keys: [] }; }
function csvText(g: Grid, spreadsheet = false): string {
  const escape = (s: string) => { const v = spreadsheet && /^[\s]*[=+\-@]/u.test(s) ? `'${s}` : s; return /[",\r\n]/.test(v) || v === "" ? `"${v.replace(/"/g, '""')}"` : v; };
  return [g.columns.map(c => c.name), ...g.rows.map(r => r.cells)].map(r => r.map(escape).join(",")).join("\r\n");
}
function validGrid(g: unknown): asserts g is Grid {
  object(g, ["columns", "rows", "keys"]); array(g.columns, 8); if (!g.columns.length) throw new Error("Missing columns."); array(g.rows, 40); array(g.keys, 8);
  for (const c of g.columns) { object(c, ["id", "name", "type"]); validId(c.id, "col"); validText(c.name, 160); enumValue(c.type, KINDS); }
  unique(g.columns.map((c: Column) => c.id)); unique(g.columns.map((c: Column) => c.name.trim()));
  let units = g.columns.reduce((n: number, c: Column) => n + c.name.length, 0);
  for (const r of g.rows) { object(r, ["id", "cells"]); validId(r.id, "row"); array(r.cells, 8); if (r.cells.length !== g.columns.length) throw new Error("Invalid row width."); for (const v of r.cells) { validText(v, 16000, true, 6000); units += v.length; } }
  if (units > 6000) throw new Error("Excess source content."); unique(g.rows.map((r: Row) => r.id)); unique(g.keys); g.keys.forEach((id: unknown) => { validId(id, "col"); if (!g.columns.some((c: Column) => c.id === id)) throw new Error("Unknown key."); });
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "original", "current", "preview", "undo"]); validBase(v); validGrid(v.original); validGrid(v.current); if (v.undo !== null) validGrid(v.undo);
  if (v.preview !== null) { const p = v.preview; object(p, ["id", "baseRevision", "fingerprint", "operation", "output"]); validId(p.id, "preview"); validNumber(p.baseRevision, 1, MAX_REVISION); enumValue(p.operation, ["trim", "dedupe", "convert"]); validGrid(p.output);
    if (p.baseRevision !== v.revision || typeof p.fingerprint !== "string" || p.fingerprint !== digest(v.current)) throw new Error("Invalid preview binding.");
  }
  // Immutable column/row provenance: transformations never invent source IDs.
  for (const g of [v.current, v.undo, v.preview?.output].filter(Boolean) as Grid[]) {
    if (g.columns.length !== v.original.columns.length || g.columns.some((c, i) => c.id !== v.original.columns[i].id || c.name !== v.original.columns[i].name) || g.rows.some(r => !v.original.rows.some((o: Row) => o.id === r.id))) throw new Error("Invalid original provenance.");
  }
}
function projectedGrid(g: Grid): Grid { return { ...g, columns: g.columns.map(c => ({ ...c, type: "civilDate" })), keys: g.columns.map(c => c.id) }; }
function projectLifecycle(s: State): State {
  return { ...s, records: s.records.map(r => {
    // Every transform is cell-size nonincreasing. Reserve the larger current/undo
    // grid, with longest type tags and all keys, in ALL three mutable slots.
    const candidates = [r.current, r.undo, r.preview?.output].filter(Boolean).map(g => projectedGrid(g!));
    const largest = candidates.reduce((a, b) => serializedBytes(a) >= serializedBytes(b) ? a : b);
    return { ...r, revision: MAX_REVISION, current: largest, undo: largest, preview: { id: "preview-ffffffff-ffff-ffff-ffff-ffffffffffff", baseRevision: MAX_REVISION, fingerprint: "f".repeat(64), operation: "convert" as const, output: largest } };
  }) };
}
function column(g: Grid, selector: string): Column { const c = g.columns.find(c => c.id === selector) ?? g.columns.find(c => c.name === selector); if (!c) fail("Column not found. Use its complete column ID from show when names contain comma/colon or boundary spaces."); return c; }
function selection(g: Grid, input: string): Column[] { const cols = input.split(",").map(s => column(g, s.trim())); if (!cols.length || new Set(cols.map(c => c.id)).size !== cols.length) fail("Select each column once."); return cols; }
function schema(g: Grid, input: string, complete: boolean): { column: Column; type: Kind }[] {
  const defs = input.split(",").map(s => { const i = s.lastIndexOf(":"); if (i < 1) fail("Schema uses COLUMN:type, separated by commas."); return { column: column(g, s.slice(0, i).trim()), type: enumValue(s.slice(i + 1).trim(), KINDS) }; });
  if (new Set(defs.map(d => d.column.id)).size !== defs.length || (complete && defs.length !== g.columns.length)) fail("Declare each column exactly once in a complete schema."); return defs;
}
function convert(value: string, kind: Kind): string {
  if (kind === "text") return value;
  if (kind === "civilDate") return checked(() => civilDate(value));
  const pattern = kind === "integer" ? /^[+-]?\d+$/ : /^[+-]?\d+(?:\.\d{1,6})?$/;
  if (!pattern.test(value) || value.length > 30) fail(`Invalid ${kind}; blank is never zero. Use explicit trim first if needed.`);
  const negative = value[0] === "-", [whole, fraction = ""] = value.replace(/^[+-]/, "").split("."), scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (scaled > 1_000_000_000n * 1_000_000n) fail("Numeric cells must have absolute value <=1000000000.");
  const tail = fraction.replace(/0+$/, ""); return `${negative && scaled !== 0n ? "-" : ""}${BigInt(whole)}${tail ? `.${tail}` : ""}`;
}
function invalidate(r: RecordData): void { r.preview = null; r.undo = null; }
function sourceFields(input: string): [string, string] {
  const f = checked(() => pipeFields(input, [{ label: "Title or table", maxBytes: 180 }, { label: "CSV", maxBytes: 16001, maxUnits: 6001, trim: false }]));
  return [f[0], f[1].startsWith(" ") ? f[1].slice(1) : f[1]]; // one optional syntax space, not data trimming
}
function audit(r: RecordData): string {
  const lines = [`${r.title}: ${r.current.rows.length} current rows; original cells retained. Row numbers below count data rows from 1 (header excluded). No formula execution or factual verification.`], seen = new Map<string, Row>();
  for (const [i, row] of r.current.rows.entries()) {
    const key = JSON.stringify(row.cells), previous = seen.get(key); if (previous) lines.push(`Duplicate exact row ${i + 1} (${row.id}); first ${previous.id}.`); else seen.set(key, row);
    for (const [j, c] of r.current.columns.entries()) { try { convert(row.cells[j], c.type); } catch (error) { if (!(error instanceof CommandError)) throw error; lines.push(`Invalid ${c.type}: row ${i + 1} (${row.id}), column ${j + 1} (${c.id}, ${JSON.stringify(c.name)}), value ${JSON.stringify(row.cells[j])}. ${error.message}`); } }
  }
  lines.push("Schema validation does not coerce cells. Preview an explicit conversion to canonicalize valid values. Blank numeric/date cells are invalid, not zero."); return lines.join("\n");
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create" || verb === "replace") {
    const [head, source] = sourceFields(rest), original = grid(source);
    if (verb === "create") { const r: RecordData = { ...base(context, "table", text(head, "Title", 160)), original, current: structuredClone(original), preview: null, undo: null }; return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "CSV saved exactly as cells; first record is the header. Declare schema next."); }); }
    const [id, confirm] = words(head, 2); if (confirm !== "confirm") fail("Use replace TABLE confirm | CSV. This erases original/current rows, schema, preview and undo.");
    return mutate(context, id, (_, r) => { r!.original = original; r!.current = structuredClone(original); invalidate(r!); return saved(id, "Source replaced explicitly; new source IDs, schema text, no preview/undo retained."); });
  }
  if (verb === "edit" || verb === "clear") { const f = verb === "edit" ? fields(rest, 80, 16, 160) : words(rest, 3); if (f[1] !== "title" || (verb === "clear" && f[2] !== "confirm")) fail("Use edit TABLE | title | TEXT, or clear TABLE title confirm."); const value = verb === "clear" ? "" : text(f[2], "Title", 160); return mutate(context, f[0], (_, r) => { r!.title = value; invalidate(r!); return saved(f[0], "Title updated; pending preview/undo discarded."); }, verb === "clear" ? "remove" : "content"); }
  if (verb === "schema" || verb === "keys") { const [id, input] = fields(rest, 80, 1600); return mutate(context, id, (_, r) => { if (verb === "schema") for (const d of schema(r!.current, input, true)) d.column.type = d.type; else r!.current.keys = selection(r!.current, input).map(c => c.id); invalidate(r!); return saved(id, "Definition updated without converting cells; preview/undo discarded.", `audit ${id}`); }); }
  if (verb === "keys-remove" || verb === "discard") { const f = words(rest, verb === "discard" ? 3 : 2); if (f.at(-1) !== "confirm") fail("Removal requires confirm."); return mutate(context, f[0], (_, r) => { if (verb === "keys-remove") { r!.current.keys = []; invalidate(r!); } else { const key = enumValue(f[1], ["preview", "undo"] as const); r![key] = null; } return saved(f[0], "Selected retained data removed."); }, "remove"); }
  if (verb === "cell") { const [head, selector, encoded] = fields(rest, 170, 160, 12010), [id, rid] = words(head, 2); let value: unknown; try { value = JSON.parse(encoded); } catch { fail('Cell value must be a JSON string, e.g. "  text  " or "".'); } const content = checked(() => boundedText(value, { label: "Cell", maxBytes: 16000, maxUnits: 6000, trim: false, allowEmpty: false })); return mutate(context, id, (_, r) => { const row = r!.current.rows.find(x => x.id === rid); if (!row) fail("Current row not found."); const c = column(r!.current, selector); row.cells[r!.current.columns.indexOf(c)] = content; invalidate(r!); return saved(id, "Current cell edited exactly; original retained, preview/undo discarded. Use replace to erase old source cells."); }); }
  if (verb === "cell-clear") { const [id, rid, selector, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Use cell-clear TABLE ROW COLUMN_ID confirm."); return mutate(context, id, (_, r) => { const row = r!.current.rows.find(x => x.id === rid); if (!row) fail("Current row not found."); const c = column(r!.current, selector); row.cells[r!.current.columns.indexOf(c)] = ""; invalidate(r!); return saved(id, "Current cell cleared; original retained until replace/delete. Preview/undo discarded."); }, "remove"); }
  if (verb === "row-remove") { const [id, rid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use row-remove TABLE ROW confirm; original source remains until replace/delete."); return mutate(context, id, (_, r) => { if (!r!.current.rows.some(row => row.id === rid)) fail("Current row not found."); r!.current.rows = r!.current.rows.filter(row => row.id !== rid); invalidate(r!); return saved(id, "Current row removed; original remains. Preview/undo discarded."); }, "remove"); }
  if (verb === "preview") {
    const [id, operation, args] = fields(rest, 80, 10, 1600), op = enumValue(operation, ["trim", "dedupe", "convert"] as const), token = `preview-${randomUUID()}`;
    return mutate(context, id, (_, r) => { const output = structuredClone(r!.current);
      if (op === "dedupe") { const keys = args === "selected" ? output.keys : selection(output, args).map(c => c.id); if (!keys.length) fail("Select at least one dedupe key."); output.keys = keys; const indexes = keys.map(k => output.columns.findIndex(c => c.id === k)), seen = new Set<string>(); output.rows = output.rows.filter(row => { const key = JSON.stringify(indexes.map(i => row.cells[i])); if (seen.has(key)) return false; seen.add(key); return true; }); }
      else if (op === "trim") { const cols = args === "all" ? output.columns : selection(output, args); for (const row of output.rows) for (const c of cols) { const i = output.columns.indexOf(c); row.cells[i] = row.cells[i].trim(); } }
      else for (const d of schema(output, args, false)) { const j = output.columns.indexOf(d.column); for (const [i, row] of output.rows.entries()) { try { row.cells[j] = convert(row.cells[j], d.type); } catch (e) { if (!(e instanceof CommandError)) throw e; fail(`Conversion refused at row ${i + 1} (${row.id}), column ${j + 1} (${d.column.id}): ${e.message}`); } } d.column.type = d.type; }
      r!.preview = { id: token, baseRevision: r!.revision + 1, fingerprint: digest(r!.current), operation: op, output };
      return saved(id, `Preview ${token}: ${op}; ${r!.current.rows.length} → ${output.rows.length} rows. Current cells unchanged. Inspect complete output before applying; apply replaces the single undo slot.`, `preview-show ${id}`);
    }, "lifecycle");
  }
  if (verb === "apply") { const [id, token] = words(rest, 2); return mutate(context, id, (_, r) => { const p = r!.preview; if (!p || p.id !== token || p.baseRevision !== r!.revision || p.fingerprint !== digest(r!.current)) fail("Stale or consumed preview. Create and inspect a new preview."); r!.undo = r!.current; r!.current = p.output; r!.preview = null; return saved(id, "Reviewed transform applied once; one prior current grid retained for explicit undo.", `export-csv ${id}`); }, "lifecycle"); }
  if (verb === "undo") { const [id, confirm] = words(rest, 2); if (confirm !== "confirm") fail("Use undo TABLE confirm to restore the single previous current grid and consume undo/preview."); return mutate(context, id, (_, r) => { if (!r!.undo) fail("No undo version retained."); r!.current = r!.undo; invalidate(r!); return saved(id, "Previous current grid restored; undo consumed."); }, "lifecycle"); }
  if (["audit", "preview-show", "export-csv", "export-spreadsheet"].includes(verb)) {
    const args = words(rest, 1, 4), r = find(await read(context), args[0]);
    if (verb === "audit") return report(audit(r), `audit ${r.id}`, r, args.slice(1));
    if (verb === "preview-show") { if (!r.preview) fail("No preview. Use preview TABLE | OPERATION | ARGUMENTS."); return report(JSON.stringify(r.preview, null, 2) + `\nReviewed apply: ${ROUTE} apply ${r.id} ${r.preview.id}`, `preview-show ${r.id}`, r, args.slice(1)); }
    const body = csvText(r.current, verb === "export-spreadsheet");
    const title = verb === "export-csv" ? "Canonical CSV · formula-like text preserved; spreadsheets may execute it. Use export-spreadsheet for an escaped copy." : "Spreadsheet-escaped CSV · leading apostrophe added before formula-like cells; importer behavior varies. Canonical cells unchanged.";
    return checked(() => pageAt(pages(body, `${verb} ${r.id}`, r, title), pageNumber(r, `${verb} ${r.id}`, args.slice(1))).text);
  }
  fail("Unknown command. Use help for exact grammar.");
}

const ROOT_PREFIX = "table";
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
function validId(value: unknown, prefix = ROOT_PREFIX): void {
  if (typeof value !== "string" || value.length !== prefix.length + 37 || !value.startsWith(`${prefix}-`) || !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid ID.");
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
    if (typeof value !== "string" || normalizeInstant(value) !== value || !/^\d{4}-.*\.\d{3}Z$/.test(value)) throw new Error("Invalid saved instant.");
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
    const limits = { maxBytes: STATE_BYTES, contentBytes: CONTENT_BYTES, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS };
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
  kind: "content" | "lifecycle" | "remove" | "erase-root" = "content", expected?: RecordData): Promise<string> {
  const intended = id === undefined ? undefined : JSON.stringify(expected ?? find(await read(context), id));
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, raw => {
    const s = structuredClone(decode(raw)), r = id === undefined ? undefined : find(s, id);
    if (r && JSON.stringify(r) !== intended) fail(`This item changed; inspect it before retrying: ${ROUTE} show ${id}`);
    if (r && r.revision === MAX_REVISION && kind !== "remove" && kind !== "erase-root") fail("Revision limit reached. Export/show, then delete this whole record and create a new one; edits and lifecycle writes are unavailable.");
    const reply = change(s, r);
    if (s.records.length > MAX_RECORDS) fail(`Maximum ${MAX_RECORDS} records. Use list, then delete ID confirm to free space.`);
    if (r && s.records.includes(r)) {
      if (kind !== "remove" && kind !== "erase-root") { r.revision++; r.updatedAt = timestamp; }
      // Removal is content-stamped. Keeping the clock prevents byte-growing numeric
      // rollover from blocking a one-byte deletion, including at the revision ceiling.
    }
    decode(s);
    if (kind === "erase-root") {
      // A narrowly scoped recovery: exactly one root disappears, every retained
      // record is byte-identical and individually exportable. No quota bypass
      // exists for child edits, status changes or arbitrary remove-labelled work.
      if (!r || s.records.length !== raw.records.length - 1 ||
          JSON.stringify(s.records) !== JSON.stringify(raw.records.filter(x => x.id !== id)) ||
          raw.records.some(x => serializedBytes(envelope(x)) > 24_576) || serializedBytes(s) >= serializedBytes(raw))
        fail("Whole-record deletion must strictly reduce valid saved bytes.");
    } else {
      if (kind === "remove" && serializedBytes(s) >= serializedBytes(raw)) fail("Nothing was erased. Removal must reduce saved bytes.");
      quota(s, kind === "remove" ? "lifecycle" : kind);
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
  const result: { text: string; atomic?: boolean }[] = [];
  const pattern = /(?:[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-f0-9]{64})/g;
  let end = 0;
  for (const match of input.matchAll(pattern)) {
    result.push({ text: input.slice(end, match.index) }, { text: match[0], atomic: true });
    end = match.index + match[0].length;
  }
  result.push({ text: input.slice(end) });
  return result;
}
function pages(body: string, command: string, r: RecordData, title = "Private · saved detail") {
  return checked(() => paginateParts(parts(body), { mode: "plain", title: `${title} · revision ${r.revision}`, command: n => `${ROUTE} ${command} ${n} rev ${stamp(r)}` }));
}
function detailPages(r: RecordData) {
  // Admission proves the longest CSV title/continuation too, for every grid a
  // later apply/undo can expose. Detail-only admission would miss atomic URLs.
  for (const g of [r.original, r.current, r.undo, r.preview?.output].filter(Boolean) as Grid[])
    pages(csvText(g, true), `export-spreadsheet ${r.id}`, r, "Spreadsheet-escaped CSV · leading apostrophe added before formula-like cells; importer behavior varies. Canonical cells unchanged.");
  return pages(JSON.stringify(envelope(r), null, 2), `show ${r.id}`, r); }
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
    }, "erase-root");
  }
  return undefined;
}
export default {
  ...metadata,
  async execute(command: string, context: AgentFeatureContext): Promise<string> {
    if (!command.trim() || command.trim() === "help") return metadata.help;
    try {
      checked(() => boundedText(command, { label: "Command", maxBytes: 16_000, trim: false })); context.signal?.throwIfAborted();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trimStart())!;
      return await common(match[1], match[2] ?? "", context) ?? await executeDomain(match[1], match[2] ?? "", context);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CommandError) return `${error.message}\nNext: ${ROUTE} help`;
      return `This command could not be completed safely. Any dispatched save may have completed; inspect your private records before repeating it.\nNext: ${ROUTE} list`;
    }
  },
} satisfies AgentFeature;
