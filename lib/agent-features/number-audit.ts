import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./number-audit.metadata.js";
const MAX_RECORDS = 12, STATE_BYTES = 49_152, CONTENT_BYTES = 32_768;
type Operand = { value: string; unit: string; weight: string | null };
type Check = { id: string; operation: "sum" | "percent-change" | "weighted-average"; operands: Operand[]; claim: string; tolerance: string; unit: string };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; checks: Check[] };
type State = { version: 1; records: RecordData[] };
const SCALE = 1_000_000n;
function decimal(value: unknown, nonnegative = false): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) || value.length > 18) fail("Use plain decimals: at most 6 decimal places, absolute value <=1000000000; no expressions/exponents.");
  const negative = value.startsWith("-"), [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const n = (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"))) * (negative ? -1n : 1n);
  if ((negative && n === 0n) || n > 1_000_000_000n * SCALE || n < -1_000_000_000n * SCALE || (nonnegative && n < 0n)) fail("Numeric magnitude/sign outside the allowed range; weights and tolerance must be nonnegative.");
  return n;
}
function unit(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9 _/%.-]{0,39}$/.test(value)) fail("Unit must be a 1–40 character label (letters, digits, spaces, _ / % . -).");
  return value;
}
function validateCheck(c: unknown): asserts c is Check {
  object(c, ["id", "operation", "operands", "claim", "tolerance", "unit"]); validId(c.id, "check");
  enumValue(c.operation, ["sum", "percent-change", "weighted-average"]); unit(c.unit); decimal(c.claim); decimal(c.tolerance, true); array(c.operands, 20);
  if (!c.operands.length || (c.operation === "percent-change" && c.operands.length !== 2)) fail("Checks need 1–20 operands; percent-change needs exactly before,after.");
  for (const o of c.operands) { object(o, ["value", "unit", "weight"]); decimal(o.value); unit(o.unit); if (c.operation === "weighted-average") decimal(o.weight, true); else if (o.weight !== null) fail("Weights belong only to weighted-average."); }
  if (c.operands.some((o: Operand) => o.unit !== c.operands[0].unit)) fail("Mixed operand units. Normalize inputs explicitly; no unit conversion is performed.");
  if (c.operation === "percent-change" ? c.unit !== "percent" : c.operands.some((o: Operand) => o.unit !== c.unit)) fail("Output unit must match operands, or be percent for percent-change.");
  if (c.operation === "weighted-average" && c.operands.reduce((n: bigint, o: Operand) => n + decimal(o.weight, true), 0n) <= 0n) fail("Weighted-average needs paired nonnegative weights with a positive total.");
}
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "checks"]); validBase(v); array(v.checks, 20);
  v.checks.forEach(validateCheck); unique(v.checks.map((c: Check) => c.id));
}
function projectLifecycle(s: State): State { return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION })) }; }
function check(r: RecordData, id: string): Check { const c = r.checks.find(c => c.id === id); if (!c) fail("Check not found in this audit."); return c; }
function parseCheck(input: string, id: string): Check {
  const [op, values, claim, tolerance, outputUnit] = fields(input, 20, 1800, 18, 18, 40);
  const operation = enumValue(op, ["sum", "percent-change", "weighted-average"] as const), u = unit(outputUnit);
  const operands = values.split(",").map(token => {
    const pair = token.trim().split(":"), annotated = pair[0].split("@");
    if (annotated.length > 2 || pair.length !== (operation === "weighted-average" ? 2 : 1)) fail("Operands: value[@unit], or value[@unit]:weight for weighted-average; separate pairs with commas.");
    return { value: annotated[0], unit: annotated[1] ?? (operation === "percent-change" ? "base" : u), weight: pair[1] ?? null };
  });
  const c = { id, operation, operands, claim, tolerance, unit: u }; validateCheck(c); return c;
}
function rational(c: Check): { n: bigint; d: bigint; formula: string } {
  const values = c.operands.map(o => decimal(o.value));
  if (c.operation === "sum") return { n: values.reduce((a, b) => a + b, 0n), d: SCALE, formula: c.operands.map(o => `(${o.value})`).join(" + ") };
  if (c.operation === "percent-change") return { n: (values[1] - values[0]) * 100n, d: values[0], formula: `((${c.operands[1].value}) - (${c.operands[0].value})) / (${c.operands[0].value}) × 100` };
  const weights = c.operands.map(o => decimal(o.weight, true));
  return { n: values.reduce((n, v, i) => n + v * weights[i], 0n), d: weights.reduce((a, b) => a + b, 0n) * SCALE,
    formula: `(${c.operands.map(o => `(${o.value}) × (${o.weight})`).join(" + ")}) / (${c.operands.map(o => `(${o.weight})`).join(" + ")})` };
}
const abs = (n: bigint) => n < 0n ? -n : n;
function displayRatio(n: bigint, d: bigint): string {
  if (d < 0n) { n = -n; d = -d; }
  let a = abs(n), b = d; while (b) { const t = a % b; a = b; b = t; } n /= a; d /= a;
  const sign = n < 0n ? "-" : "", magnitude = abs(n), precision = 1_000_000_000_000n;
  const exact = (magnitude * precision) % d === 0n;
  const scaled = (magnitude * precision * 2n + d) / (2n * d); // half away from zero
  const rendered = `${sign}${scaled / precision}.${String(scaled % precision).padStart(12, "0")}`.replace(/\.?0+$/, "");
  if (n !== 0n && scaled === 0n) return `${n}/${d} exactly (nonzero; magnitude <0.000000000001)`;
  return exact ? `${rendered} (exact; ratio ${n}/${d})` : `≈${rendered} (rounded half away from zero to 12 decimals; exact ratio ${n}/${d})`;
}
function run(r: RecordData): string {
  const lines = [r.title, "Exact rational arithmetic; tolerance uses the unrounded result. Operand units must match. Percent change divides by the signed before value (negative bases reverse the sign compared with dividing by absolute before). No external data verification."];
  for (const c of r.checks) {
    let { n, d, formula } = rational(c); lines.push(`\n${c.id} · ${c.operation}\nInputs (${c.operands[0].unit}); formula: ${formula}`);
    if (d === 0n) { lines.push("UNDEFINED: zero baseline; no pass/fail claim."); continue; }
    if (d < 0n) { d = -d; n = -n; }
    const passes = abs(n * SCALE - decimal(c.claim) * d) <= decimal(c.tolerance, true) * d;
    lines.push(`${passes ? "PASS" : "MISMATCH"}: result ${displayRatio(n, d)} ${c.unit}; claimed ${c.claim}; absolute tolerance ${c.tolerance} ${c.unit}.`);
    if (!passes) lines.push(`To correct explicitly: ${ROUTE} correct ${r.id} ${c.id} | VALUE`);
  }
  if (!r.checks.length) lines.push("No checks. Add a typed sum, percent-change or weighted-average.");
  return lines.join("\n");
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") { const [title] = fields(rest, 160), r: RecordData = { ...base(context, "audit", text(title, "Title", 160)), checks: [] }; return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Audit created. Add typed checks."); }); }
  if (verb === "edit" || verb === "clear") {
    const f = verb === "edit" ? fields(rest, 80, 16, 160) : words(rest, 3); if (f[1] !== "title" || (verb === "clear" && f[2] !== "confirm")) fail("Use edit AUDIT | title | TEXT, or clear AUDIT title confirm.");
    const value = verb === "clear" ? "" : text(f[2], "Title", 160);
    return mutate(context, f[0], (_, r) => { r!.title = value; return saved(f[0], "Title updated."); }, verb === "clear" ? "remove" : "content");
  }
  if (verb === "check") {
    const m = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use check AUDIT add OPERATION | OPERANDS | CLAIM | TOLERANCE | UNIT; edit CHECK | OPERATION | OPERANDS | CLAIM | TOLERANCE | UNIT; remove CHECK confirm.");
    const [, id, mode, input] = m;
    if (mode === "remove") { const [cid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Check removal requires confirm."); return mutate(context, id, (_, r) => { check(r!, cid); r!.checks = r!.checks.filter(c => c.id !== cid); return saved(id, "Check and all its inputs removed."); }, "remove"); }
    let cid = `check-${randomUUID()}`, content = input;
    if (mode === "edit") { const match = /^(\S+)\s*\|([\s\S]*)$/.exec(input); if (!match) fail("Use edit CHECK | OPERATION | OPERANDS | CLAIM | TOLERANCE | UNIT."); cid = match[1]; content = match[2]; }
    const c = parseCheck(content, cid);
    return mutate(context, id, (_, r) => { if (mode === "add") { if (r!.checks.length === 20) fail("Maximum 20 checks. Remove one explicitly."); r!.checks.push(c); } else Object.assign(check(r!, cid), c); return saved(id, `Check ${cid} saved. Run recomputes every result from these inputs.`, `run ${id}`); });
  }
  if (verb === "correct") { const [head, value] = fields(rest, 170, 18), [id, cid] = words(head, 2); decimal(value); return mutate(context, id, (_, r) => { check(r!, cid).claim = value; return saved(id, "Claim explicitly corrected; rerun to compare.", `run ${id}`); }); }
  if (verb === "run") { const args = words(rest, 1, 4), r = find(await read(context), args[0]); return report(run(r), `run ${r.id}`, r, args.slice(1)); }
  fail("Unknown command. Use help for exact grammar.");
}

const ROOT_PREFIX = "audit";
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
