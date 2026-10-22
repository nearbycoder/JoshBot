import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, dateInZone, normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./skill-matrix.metadata.js";

const MAX_RECORDS = 10;
type Evidence = { id: string; date: string; text: string };
type Skill = { id: string; name: string; target: number; rubric: string[]; self: string; evidence: Evidence[]; reflection: string };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; skills: Skill[] };
type State = { version: 1; records: RecordData[] };
const DEFAULT_RUBRIC = ["0: No demonstrated example yet", "1: Can explain basics", "2: Can apply with support", "3: Can apply independently and explain tradeoffs", "4: Can guide others and evaluate alternatives"];
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "skills"]); validBase(v); array(v.skills, 24);
  for (const s of v.skills) {
    object(s, ["id", "name", "target", "rubric", "self", "evidence", "reflection"]);
    validId(s.id); validText(s.name, 160, true); validNumber(s.target, 0, 4);
    array(s.rubric, 5); if (s.rubric.length !== 5) throw new Error("Invalid rubric.");
    for (const definition of s.rubric) validText(definition, 320, true);
    if (s.self !== "") enumValue(s.self, ["0", "1", "2", "3", "4"]);
    validText(s.reflection, 320, true); array(s.evidence, 3);
    for (const e of s.evidence) { object(e, ["id", "date", "text"]); validId(e.id); civilDate(e.date); validText(e.text, 1000); }
    unique(s.evidence.map((e: Evidence) => e.id));
  }
  unique(v.skills.flatMap((s: Skill) => [s.id, ...s.evidence.map(e => e.id)]));
}
function projectLifecycle(s: State): State {
  // All admitted skills can receive a self-rating and a full 320-byte reflection.
  // A backslash is the worst permitted JSON-escaped byte (2 serialized bytes).
  return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION, skills: r.skills.map(k => ({ ...k, self: "4", reflection: "\\".repeat(320) })) })) };
}
function skill(r: RecordData, id: string): Skill { const s = r.skills.find(s => s.id === id); if (!s) fail("Skill not found in this matrix."); return s; }
function invalidate(s: Skill): void { s.self = ""; s.reflection = ""; }
function gaps(r: RecordData, context: AgentFeatureContext): string {
  const today = checked(() => dateInZone(context.now, context.timezone));
  const sorted = r.skills.slice().sort((a, b) => (a.self === "" ? Infinity : 0) - (b.self === "" ? Infinity : 0) ||
    (b.self === "" || a.self === "" ? 0 : (b.target - Number(b.self)) - (a.target - Number(a.self))) || a.id.localeCompare(b.id));
  const lines = [`${r.title} · private self-assessment`, "Known gaps = target − self; unknown is distinct from zero. No candidate ranking, credential verification or inferred qualification.", `Evidence age as of ${today} (${context.timezone}); age does not prove skill loss.`];
  for (const s of sorted) {
    lines.push(`\n${s.id} · ${s.name || "(name cleared)"}`, `Target ${s.target}; self ${s.self === "" ? "unknown; gap unknown" : `${s.self}; gap ${s.target - Number(s.self)}; ${s.evidence.length ? "user-linked examples, not verified competence" : "unsubstantiated (no linked evidence)"}`}.`);
    for (const [i, definition] of s.rubric.entries()) lines.push(`Rubric ${i}: ${definition || "undefined; add an explicit definition"}`);
    for (const e of s.evidence) { const age = checked(() => civilDaysBetween(e.date, today)); lines.push(`Evidence ${e.id} · ${e.date} · ${age < 0 ? `future date, ${-age} days ahead` : `${age} civil days old`}: ${e.text}`); }
    lines.push(`Reflection: ${s.reflection || "not entered"}`);
  }
  if (!sorted.length) lines.push("No skills yet. Use skill MATRIX add NAME | TARGET | TARGET_DEFINITION.");
  return lines.join("\n");
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [title] = fields(rest, 160), r: RecordData = { ...base(context, "matrix", text(title, "Target role", 160)), skills: [] };
    return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Private target matrix created. Add skills and dated examples."); });
  }
  if (verb === "edit") {
    const [id, field, value] = fields(rest, 80, 16, 160); if (field !== "title") fail("Matrix field: title.");
    return mutate(context, id, (_, r) => { r!.title = text(value, "Target role", 160); return saved(id, "Target role label updated; skill rubrics are unchanged."); });
  }
  if (verb === "clear") {
    const [id, field, confirm] = words(rest, 3); if (field !== "title" || confirm !== "confirm") fail("Use clear MATRIX title confirm.");
    return mutate(context, id, (_, r) => { r!.title = ""; return saved(id, "Target role label removed."); }, "remove");
  }
  if (verb === "skill") {
    const m = /^(\S+)\s+(add|edit|clear|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use skill MATRIX add NAME | TARGET_0_TO_4 | TARGET_DEFINITION; see help for edits.");
    const [, id, mode, input] = m;
    if (mode === "add") {
      const [name, level, definition] = fields(input, 160, 1, 320), target = integer(level, 0, 4), rubric = [...DEFAULT_RUBRIC]; rubric[target] = text(definition, "Target definition", 320);
      const k: Skill = { id: `skill-${randomUUID()}`, name: text(name, "Skill", 160), target, rubric, self: "", evidence: [], reflection: "" };
      return mutate(context, id, (_, r) => { if (r!.skills.length >= 24) fail("Maximum 24 skills. Remove a skill explicitly first."); r!.skills.push(k); return saved(id, `Skill ${k.id} saved. The five explicit starter definitions can be edited with rubric. Self-rating is unknown.`, `gaps ${id}`); });
    }
    if (mode === "remove") {
      const [child, confirm] = words(input, 2); if (confirm !== "confirm") fail("Use skill MATRIX remove SKILL confirm.");
      return mutate(context, id, (_, r) => { skill(r!, child); r!.skills = r!.skills.filter(s => s.id !== child); return saved(id, "Skill, examples, self-rating and reflection removed."); }, "remove");
    }
    if (mode === "clear") {
      const [child, field, confirm] = words(input, 3); if (field !== "name" || confirm !== "confirm") fail("Use skill MATRIX clear SKILL name confirm. Remove the whole skill to remove its required target.");
      return mutate(context, id, (_, r) => { const k = skill(r!, child); k.name = ""; invalidate(k); return saved(id, "Name removed; dependent self-rating and reflection invalidated."); }, "remove");
    }
    const [child, field, value] = fields(input, 80, 16, 160);
    return mutate(context, id, (_, r) => { const k = skill(r!, child); if (field === "name") k.name = text(value, "Skill", 160); else if (field === "target") k.target = integer(value, 0, 4); else fail("Skill fields: name, target."); invalidate(k); return saved(id, "Skill definition updated; prior self-rating and reflection cleared. Dated examples remain supplied historical examples.", `gaps ${id}`); });
  }
  if (verb === "rubric") {
    const [head, level, definition] = fields(rest, 170, 1, 320), [id, child] = words(head, 2), index = integer(level, 0, 4);
    return mutate(context, id, (_, r) => { const k = skill(r!, child); k.rubric[index] = text(definition, "Rubric definition", 320); invalidate(k); return saved(id, "Rubric updated. Prior self-rating and reflection cleared; there is no hidden assessment history.", `gaps ${id}`); });
  }
  if (verb === "rubric-remove") {
    const [id, child, level, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Use rubric-remove MATRIX SKILL LEVEL confirm."); const index = integer(level, 0, 4);
    return mutate(context, id, (_, r) => { const k = skill(r!, child); k.rubric[index] = ""; invalidate(k); return saved(id, "Definition removed. Ratings require all five definitions; prior assessment cleared."); }, "remove");
  }
  if (verb === "self-rate" || verb === "review") {
    const [head, value] = fields(rest, 170, verb === "review" ? 320 : 1), [id, child] = words(head, 2);
    return mutate(context, id, (_, r) => { const k = skill(r!, child); if (verb === "self-rate") { if (k.rubric.some(d => !d.trim())) fail("Define every rubric level before self-rating."); k.self = String(integer(value, 0, 4)); } else k.reflection = text(value, "Reflection", 320); return saved(id, "Private self-assessment updated, not a verified qualification.", `gaps ${id}`); }, "lifecycle");
  }
  if (verb === "assessment-remove") {
    const [id, child, field, confirm] = words(rest, 4); if (confirm !== "confirm" || !["self", "reflection"].includes(field)) fail("Use assessment-remove MATRIX SKILL self|reflection confirm.");
    return mutate(context, id, (_, r) => { const k = skill(r!, child); if (field === "self") k.self = ""; else k.reflection = ""; return saved(id, "Assessment field removed; unknown is not zero."); }, "remove");
  }
  if (verb === "evidence") {
    const [head, date, value] = fields(rest, 170, 10, 1000), [id, child] = words(head, 2), e: Evidence = { id: `example-${randomUUID()}`, date: checked(() => civilDate(date)), text: text(value, "Example", 1000) };
    return mutate(context, id, (_, r) => { const k = skill(r!, child); if (k.evidence.length >= 3) fail("Maximum 3 examples per skill. Remove one explicitly first."); k.evidence.push(e); return saved(id, `Dated example ${e.id} saved; age does not establish present competence.`, `gaps ${id}`); });
  }
  if (verb === "evidence-edit") {
    const [head, date, value] = fields(rest, 250, 10, 1000), [id, child, eid] = words(head, 3), day = checked(() => civilDate(date)), content = text(value, "Example", 1000);
    return mutate(context, id, (_, r) => { const k = skill(r!, child), e = k.evidence.find(e => e.id === eid); if (!e) fail("Example not found."); e.date = day; e.text = content; invalidate(k); return saved(id, "Example updated; dependent assessment cleared for honest reassessment."); });
  }
  if (verb === "evidence-remove") {
    const [id, child, eid, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Use evidence-remove MATRIX SKILL EVIDENCE confirm.");
    return mutate(context, id, (_, r) => { const k = skill(r!, child); if (!k.evidence.some(e => e.id === eid)) fail("Example not found."); k.evidence = k.evidence.filter(e => e.id !== eid); invalidate(k); return saved(id, "Example removed; dependent assessment cleared."); }, "remove");
  }
  if (verb === "gaps") { const args = words(rest, 1, 4), r = find(await read(context), args[0]); return report(gaps(r, context), `gaps ${r.id}`, r, args.slice(1)); }
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
  const result: { text: string; atomic?: boolean }[] = [];
  const pattern = /(?:[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolbox:goals:[A-Za-z0-9_.:-]+|e1:[a-f0-9]{64})/g;
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
