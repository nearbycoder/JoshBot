import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./checklist-lint.metadata.js";
const MAX_RECORDS = 12, STATE_BYTES = 49_152, CONTENT_BYTES = 32_768;
type Step = { id: string; action: string; verification: string; stopCondition: string; prerequisites: string[] };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; applicability: string; steps: Step[] };
type State = { version: 1; records: RecordData[] };
const VAGUE = ["check", "review", "ensure", "handle", "manage", "validate"];
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "applicability", "steps"]); validBase(v); validText(v.applicability, 1000, true); array(v.steps, 30);
  for (const s of v.steps) { object(s, ["id", "action", "verification", "stopCondition", "prerequisites"]); validId(s.id, "step"); for (const field of [s.action, s.verification, s.stopCondition]) validText(field, 500, true); array(s.prerequisites, 30); s.prerequisites.forEach((id: unknown) => validId(id, "step")); unique(s.prerequisites); }
  unique(v.steps.map((s: Step) => s.id));
  if (v.steps.reduce((n: number, s: Step) => n + s.prerequisites.length, 0) > 60 || v.steps.some((s: Step) => s.prerequisites.some(id => !v.steps.some((t: Step) => t.id === id)))) throw new Error("Invalid prerequisite graph.");
}
function projectLifecycle(s: State): State { return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION })) }; }
function step(r: RecordData, id: string): Step { const s = r.steps.find(s => s.id === id); if (!s) fail("Step not found in this review."); return s; }
function optional(value: string): string { return value === "none" ? "" : text(value, "Step field", 500, true); }
function audit(r: RecordData): string {
  const lines = [r.title, `Applicability: ${r.applicability || "missing; fill applicability before using this procedure"}`, "Advisory design lint only: no step execution, completion status, release-gate pass or safety certification.", `Finite English vague-word list: ${VAGUE.join(", ")}. Case-insensitive whole ASCII words anywhere in action; spans are zero-based UTF-16 [start,end). Duplicate normalization: NFC, lowercase, trim, collapse whitespace; exact text equality, not semantic equivalence.`];
  const positions = new Map(r.steps.map((s, i) => [s.id, i])), first = new Map<string, Step>(); let findings = 0;
  const add = (s: Step, rule: string, field: string, start: number, end: number, guidance: string) => { findings++; lines.push(`${s.id} · step ${positions.get(s.id)! + 1} · ${rule} · ${field}[${start},${end}): ${JSON.stringify(s[field as "action" | "verification" | "stopCondition"].slice(start, end))}. ${guidance}`); };
  for (const s of r.steps) {
    if (!s.action.trim()) add(s, "missing-action", "action", 0, s.action.length, "Fill action with an observable action.");
    for (const m of s.action.matchAll(/\b(check|review|ensure|handle|manage|validate)\b/gi)) add(s, "vague-action", "action", m.index, m.index + m[0].length, "Replace the flagged word with a specific action and observable target.");
    if (!s.verification.trim()) add(s, "missing-verification", "verification", 0, s.verification.length, "Fill verification with an observable expected result.");
    const normalized = s.action.normalize("NFC").toLowerCase().trim().replace(/\s+/gu, " "), earlier = first.get(normalized);
    if (normalized && earlier) add(s, "duplicate-action", "action", 0, s.action.length, `Exact normalized duplicate of ${earlier.id}; edit or remove the redundant step explicitly.`); else if (normalized) first.set(normalized, s);
    for (const p of s.prerequisites) if (positions.get(p)! >= positions.get(s.id)!) { findings++; lines.push(`${s.id} · prerequisite-after-dependent · prerequisites entry ${p} at position ${positions.get(p)! + 1}; dependent position ${positions.get(s.id)! + 1}. Move prerequisite earlier or remove that reference explicitly.`); }
    // Reachability back to this node identifies cycle participation; bounded by 30 nodes/60 refs.
    const seen = new Set<string>(), queue = [...s.prerequisites]; let cyclic = false;
    for (let i = 0; i < queue.length; i++) { const id = queue[i]; if (id === s.id) { cyclic = true; break; } if (seen.has(id)) continue; seen.add(id); queue.push(...step(r, id).prerequisites.filter(p => !seen.has(p))); }
    if (cyclic) { findings++; lines.push(`${s.id} · dependency-cycle · prerequisites: a saved dependency path returns to this step. Remove a reference to break the cycle; moving alone cannot fix it.`); }
  }
  lines.push(`${findings} rule finding(s) in ${r.steps.length} steps. ${findings ? "Edit the named fields, then audit again." : "No listed rules matched; this does not establish readiness or safety."}`);
  return lines.join("\n");
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") { const [title, applicability] = fields(rest, 160, 1000), r: RecordData = { ...base(context, "review", text(title, "Title", 160)), applicability: text(applicability, "Applicability", 1000), steps: [] }; return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Procedure review created; no execution status is tracked."); }); }
  if (verb === "edit" || verb === "clear") {
    const f = verb === "edit" ? fields(rest, 80, 20, 1000) : words(rest, 3), field = enumValue(f[1], ["title", "applicability"] as const);
    if (verb === "clear" && f[2] !== "confirm") fail("Use clear REVIEW title|applicability confirm."); const value = verb === "clear" ? "" : text(f[2], field, field === "title" ? 160 : 1000);
    return mutate(context, f[0], (_, r) => { r![field] = value; return saved(f[0], "Review field updated; audit recomputes current findings."); }, verb === "clear" ? "remove" : "content");
  }
  if (verb === "step") {
    const m = /^(\S+)\s+(add|edit|clear|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use step REVIEW add ACTION | VERIFICATION_OR_none | STOP_OR_none; see help for edit/remove syntax."); const [, id, mode, input] = m;
    if (mode === "add") { const [action, verification, stopCondition] = fields(input, 500, 500, 500), s: Step = { id: `step-${randomUUID()}`, action: text(action, "Action", 500), verification: optional(verification), stopCondition: optional(stopCondition), prerequisites: [] }; return mutate(context, id, (_, r) => { if (r!.steps.length === 30) fail("Maximum 30 steps. Remove one explicitly."); r!.steps.push(s); return saved(id, `Step ${s.id} saved.`, `audit ${id}`); }); }
    if (mode === "remove") { const [sid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Step removal requires confirm; incident prerequisites are also removed."); return mutate(context, id, (_, r) => { step(r!, sid); r!.steps = r!.steps.filter(s => s.id !== sid); for (const s of r!.steps) s.prerequisites = s.prerequisites.filter(p => p !== sid); return saved(id, "Step and every incident prerequisite reference removed; audit the remaining order.", `audit ${id}`); }, "remove"); }
    const f = mode === "edit" ? fields(input, 80, 20, 500) : words(input, 3), field = enumValue(f[1], ["action", "verification", "stopCondition"] as const);
    if (mode === "clear" && f[2] !== "confirm") fail("Use step REVIEW clear STEP FIELD confirm."); const value = mode === "clear" ? "" : field === "action" ? text(f[2], "Action", 500) : optional(f[2]);
    return mutate(context, id, (_, r) => { step(r!, f[0])[field] = value; return saved(id, "Step field updated.", `audit ${id}`); }, mode === "clear" ? "remove" : "content");
  }
  if (verb === "requires" || verb === "requires-remove") {
    const f = verb === "requires" ? fields(rest, 170, 80) : words(rest, 4), [id, sid, pid] = verb === "requires" ? [...words(f[0], 2), f[1]] : f;
    if (verb === "requires-remove" && f[3] !== "confirm") fail("Use requires-remove REVIEW STEP PREREQUISITE confirm.");
    return mutate(context, id, (_, r) => { const s = step(r!, sid); step(r!, pid); if (verb === "requires") { if (s.prerequisites.includes(pid)) fail("Reference already exists."); if (r!.steps.reduce((n, x) => n + x.prerequisites.length, 0) === 60) fail("Maximum 60 prerequisite references."); s.prerequisites.push(pid); } else { if (!s.prerequisites.includes(pid)) fail("Reference not found."); s.prerequisites = s.prerequisites.filter(p => p !== pid); } return saved(id, "Prerequisites updated. Cycles remain explicit audit findings, never an executable order.", `audit ${id}`); }, verb === "requires-remove" ? "remove" : "content");
  }
  if (verb === "move") { const [head, value] = fields(rest, 170, 2), [id, sid] = words(head, 2), position = integer(value, 1, 30); return mutate(context, id, (_, r) => { const s = step(r!, sid); if (position > r!.steps.length) fail("Position exceeds the current step count."); r!.steps = r!.steps.filter(s => s.id !== sid); r!.steps.splice(position - 1, 0, s); return saved(id, `Step moved to position ${position}.`, `audit ${id}`); }); }
  if (verb === "audit") { const args = words(rest, 1, 4), r = find(await read(context), args[0]); return report(audit(r), `audit ${r.id}`, r, args.slice(1)); }
  fail("Unknown command. Use help for exact grammar.");
}

const ROOT_PREFIX = "review";
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
