import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./process-friction.metadata.js";
const MAX_RECORDS = 12, STATE_BYTES = 49_152, CONTENT_BYTES = 32_768;
type Step = { id: string; label: string; active: number; wait: number; ownerLabel: string; requiredReason: string };
type Totals = { active: number; wait: number; handoffs: number; stepCount: number; repetitions: number; largestWait: number; largestStep: string | null };
type Assumption = { step: Step; field: "active" | "wait" | "owner" | "remove"; value: string };
type Scenario = { id: string; name: string; baselineId: string; baselineRevision: number; fingerprint: string; assumption: Assumption; before: Totals; after: Totals };
type Pending = { token: string; replaces: string | null; scenario: Scenario };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; baselineId: string; repetitions: number; steps: Step[]; scenarios: Scenario[]; pending: Pending | null };
type State = { version: 1; records: RecordData[] };
function minutes(v: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(v) || v.length > 11) fail("Minutes must be plain nonnegative decimals, <=3 places and <=1000000.");
  const [whole, fractional = ""] = v.split("."), n = Number(whole) * 1000 + Number(fractional.padEnd(3, "0")); if (!Number.isSafeInteger(n) || n > 1_000_000_000) fail("Minutes exceed 1000000."); return n;
}
const fmt = (n: number) => `${Math.trunc(n / 1000)}.${String(Math.abs(n % 1000)).padStart(3, "0")}`.replace(/\.?0+$/, "");
function validStep(s: unknown): asserts s is Step { object(s, ["id", "label", "active", "wait", "ownerLabel", "requiredReason"]); validId(s.id, "step"); validText(s.label, 160, true); validText(s.ownerLabel, 128, true); validText(s.requiredReason, 320, true); validNumber(s.active, 0, 1_000_000_000); validNumber(s.wait, 0, 1_000_000_000); }
function validTotals(t: unknown): asserts t is Totals {
  object(t, ["active", "wait", "handoffs", "stepCount", "repetitions", "largestWait", "largestStep"]); validNumber(t.stepCount, 0, 24); validNumber(t.repetitions, 1, 10000); validNumber(t.handoffs, 0, Math.max(0, t.stepCount - 1)); validNumber(t.active, 0, t.stepCount * 1_000_000_000); validNumber(t.wait, 0, t.stepCount * 1_000_000_000); validNumber(t.largestWait, 0, 1_000_000_000);
  if (t.stepCount === 0 ? t.largestStep !== null || t.largestWait !== 0 : typeof t.largestStep !== "string") throw new Error("Invalid largest-wait snapshot.");
  if (t.largestStep !== null) validId(t.largestStep, "step");
  if (t.largestWait > t.wait || t.largestWait * t.stepCount < t.wait) throw new Error("Invalid wait accounting.");
}
function validScenario(s: unknown): asserts s is Scenario {
  object(s, ["id", "name", "baselineId", "baselineRevision", "fingerprint", "assumption", "before", "after"]); validId(s.id, "scenario"); validId(s.baselineId, "base"); validNumber(s.baselineRevision, 1, MAX_REVISION); validText(s.name, 160, true);
  if (typeof s.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(s.fingerprint)) throw new Error("Invalid snapshot fingerprint.");
  object(s.assumption, ["step", "field", "value"]); validStep(s.assumption.step); enumValue(s.assumption.field, ["active", "wait", "owner", "remove"]); validText(s.assumption.value, 320, true);
  if (s.assumption.field === "active" || s.assumption.field === "wait") minutes(s.assumption.value);
  if (s.assumption.field === "owner") validText(s.assumption.value, 128);
  if (s.assumption.field === "remove" && s.assumption.step.requiredReason && !s.assumption.value.trim()) throw new Error("Required removal lacks rationale.");
  validTotals(s.before); validTotals(s.after);
  const a = s.assumption, before = s.before as Totals, after = s.after as Totals;
  if (!before.stepCount || after.repetitions !== before.repetitions || after.stepCount !== before.stepCount - (a.field === "remove" ? 1 : 0) || before.active < a.step.active || before.wait < a.step.wait) throw new Error("Invalid historic comparison counts.");
  const active = before.active + (a.field === "active" ? minutes(a.value) - a.step.active : a.field === "remove" ? -a.step.active : 0);
  const wait = before.wait + (a.field === "wait" ? minutes(a.value) - a.step.wait : a.field === "remove" ? -a.step.wait : 0);
  if (((a.field === "active" || a.field === "wait") && after.handoffs !== before.handoffs) || Math.abs(after.handoffs - before.handoffs) > 2 || after.active !== active || after.wait !== wait) throw new Error("Invalid historic comparison arithmetic.");
}
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "baselineId", "repetitions", "steps", "scenarios", "pending"]); validBase(v); validId(v.baselineId, "base"); validNumber(v.repetitions, 1, 10000); array(v.steps, 24); v.steps.forEach(validStep); unique(v.steps.map((s: Step) => s.id)); array(v.scenarios, 3); v.scenarios.forEach(validScenario); unique(v.scenarios.map((s: Scenario) => s.id));
  if (v.pending !== null) { const p = v.pending; object(p, ["token", "replaces", "scenario"]); validId(p.token, "preview"); validScenario(p.scenario); if (p.replaces !== null) { validId(p.replaces, "scenario"); if (!v.scenarios.some((s: Scenario) => s.id === p.replaces) || p.scenario.id !== p.replaces) throw new Error("Invalid replacement target."); } else if (v.scenarios.some((s: Scenario) => s.id === p.scenario.id) || v.scenarios.length === 3) throw new Error("No scenario slot.");
    if (p.scenario.baselineId !== v.baselineId || p.scenario.fingerprint !== fingerprint(v as RecordData)) throw new Error("Invalid pending binding.");
  }
  for (const s of [...v.scenarios, ...(v.pending ? [v.pending.scenario] : [])] as Scenario[]) {
    if (s.baselineRevision > v.revision) throw new Error("Invalid future baseline revision.");
    if (s.baselineId !== v.baselineId) continue;
    const st = v.steps.find((x: Step) => x.id === s.assumption.step.id);
    if (!st || JSON.stringify(st) !== JSON.stringify(s.assumption.step) || s.fingerprint !== fingerprint(v as RecordData) || JSON.stringify(s.before) !== JSON.stringify(totals(v.steps, v.repetitions)) || JSON.stringify(s.after) !== JSON.stringify(totals(changed(v.steps, s.assumption), v.repetitions))) throw new Error("Invalid current scenario comparison.");
  }
}
function fingerprint(r: RecordData): string { return createHash("sha256").update(JSON.stringify({ steps: r.steps, repetitions: r.repetitions })).digest("hex"); }
function totals(steps: Step[], repetitions: number): Totals {
  let active = 0, wait = 0, handoffs = 0, largest: Step | undefined;
  for (const [i, s] of steps.entries()) { active += s.active; wait += s.wait; if (!largest || s.wait > largest.wait) largest = s; if (i && steps[i - 1].ownerLabel && s.ownerLabel && steps[i - 1].ownerLabel !== s.ownerLabel) handoffs++; }
  return { active, wait, handoffs, stepCount: steps.length, repetitions, largestWait: largest?.wait ?? 0, largestStep: largest?.id ?? null };
}
function changed(steps: Step[], assumption: Assumption): Step[] {
  const output = structuredClone(steps), s = output.find(s => s.id === assumption.step.id); if (!s) fail("Scenario step is absent from the baseline.");
  if (assumption.field === "remove") { if (s.requiredReason && !assumption.value.trim()) fail("Required step removal needs an explicit replacement rationale in VALUE."); return output.filter(x => x.id !== s.id); }
  if (assumption.field === "owner") s.ownerLabel = text(assumption.value, "Owner label", 128); else s[assumption.field] = minutes(assumption.value); return output;
}
function projectLifecycle(s: State): State {
  return { ...s, records: s.records.map(r => {
    // Sparse assumptions and numeric summaries avoid copying entire baselines.
    // Reserve all three saved slots AND a replacement preview, final names,
    // worst escaped rationale, historic snapshots and numeric digit growth.
    if (!r.steps.length) return { ...r, revision: MAX_REVISION, scenarios: r.scenarios.map(s => ({ ...s, name: "\\".repeat(160) })) };
    const stepCandidates = [...r.steps, ...r.scenarios.map(s => s.assumption.step), ...(r.pending ? [r.pending.scenario.assumption.step] : [])];
    const fallback: Step = { id: "step-ffffffff-ffff-ffff-ffff-ffffffffffff", label: "", active: 1_000_000_000, wait: 1_000_000_000, ownerLabel: "", requiredReason: "" };
    const largest = stepCandidates.map(s => ({ ...s, active: 1_000_000_000, wait: 1_000_000_000 })).reduce((a, b) => serializedBytes(a) >= serializedBytes(b) ? a : b, fallback);
    const summary: Totals = { active: 24_000_000_000, wait: 24_000_000_000, handoffs: 23, stepCount: 24, repetitions: 10000, largestWait: 1_000_000_000, largestStep: fallback.id };
    const projected: Scenario = { id: "scenario-ffffffff-ffff-ffff-ffff-ffffffffffff", name: "\\".repeat(160), baselineId: r.baselineId, baselineRevision: MAX_REVISION, fingerprint: "f".repeat(64), assumption: { step: { ...largest, active: 1_000_000_000, wait: 1_000_000_000 }, field: "remove", value: "\\".repeat(320) }, before: summary, after: summary };
    const biggest = [...r.scenarios, ...(r.pending ? [r.pending.scenario] : [])].reduce((a, b) => serializedBytes(a) >= serializedBytes(b) ? a : b, projected);
    return { ...r, revision: MAX_REVISION, scenarios: [biggest, biggest, biggest], pending: { token: "preview-ffffffff-ffff-ffff-ffff-ffffffffffff", replaces: projected.id, scenario: biggest } };
  }) };
}
function step(r: RecordData, id: string): Step { const s = r.steps.find(s => s.id === id); if (!s) fail("Step not found in this process."); return s; }
function scenario(r: RecordData, id: string): Scenario { const s = r.scenarios.find(s => s.id === id); if (!s) fail("Scenario not found."); return s; }
async function baseline(context: AgentFeatureContext, id: string, change: (r: RecordData) => string, kind: "content" | "remove" = "content"): Promise<string> {
  const nextId = `base-${randomUUID()}`; return mutate(context, id, (_, r) => { const reply = change(r!); r!.baselineId = nextId; r!.pending = null; return saved(id, reply + " Pending preview discarded; saved scenarios remain historical until explicitly revised.", `analyze ${id}`); }, kind);
}
function summary(t: Totals): string {
  const share = t.wait ? `${(t.largestWait * 100 / t.wait).toFixed(2)}% (rounded)` : "undefined (zero total wait)";
  return `${fmt(t.active)} active minutes + ${fmt(t.wait)} waiting minutes = ${fmt(t.active + t.wait)} sequential elapsed minutes; ${t.handoffs} handoff(s), ${t.stepCount} step(s). At ${t.repetitions} occurrences/month: ${fmt(t.active * t.repetitions)} active, ${fmt(t.wait * t.repetitions)} waiting, ${fmt((t.active + t.wait) * t.repetitions)} elapsed minutes. Largest wait ${fmt(t.largestWait)} minutes at ${t.largestStep ?? "no step"}: ${share}.`;
}
function analyze(r: RecordData): string {
  const lines = [r.title, summary(totals(r.steps, r.repetitions)), "Assumptions: sequential nonoverlapping steps; active and wait are entered per occurrence. Handoffs count adjacent unequal nonempty owner labels; empty/unknown boundaries are excluded. Largest-wait ties use first step. Labels are not Slack identities. Elapsed reductions are not equivalent labor or cloud savings; no automation or external changes."];
  for (const s of r.scenarios) lines.push(`\n${s.id} · ${s.name || "(name cleared)"} · ${s.baselineId === r.baselineId ? "CURRENT baseline assumptions" : "STALE historical baseline; revise explicitly before using"}\nSnapshot ${s.baselineId} at record revision ${s.baselineRevision}; ${s.fingerprint}\nAssumption on ${s.assumption.step.id} (${s.assumption.step.label}): ${s.assumption.field} = ${JSON.stringify(s.assumption.value)}\nBefore: ${summary(s.before)}\nAfter: ${summary(s.after)}\nRetained: changed-step snapshot and numerical comparison, not a full historical process graph.`);
  if (r.pending) lines.push(`\nPending ${r.pending.token}; inspect: ${ROUTE} scenario-preview ${r.id}`); return lines.join("\n");
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") { const [title, count] = fields(rest, 160, 5), r: RecordData = { ...base(context, "process", text(title, "Title", 160)), baselineId: `base-${randomUUID()}`, repetitions: integer(count, 1, 10000), steps: [], scenarios: [], pending: null }; return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Process created with explicit monthly occurrences."); }); }
  if (verb === "edit" || verb === "clear") { const f = verb === "edit" ? fields(rest, 80, 20, 160) : words(rest, 3), key = enumValue(f[1], ["title", "repetitions"] as const); if (verb === "clear" && (key !== "title" || f[2] !== "confirm")) fail("Use clear PROCESS title confirm; remove the process to erase required repetitions."); const value = verb === "clear" ? "" : key === "title" ? text(f[2], "Title", 160) : integer(f[2], 1, 10000); return baseline(context, f[0], r => { if (key === "title") r.title = value as string; else r.repetitions = value as number; return "Baseline field updated."; }, verb === "clear" ? "remove" : "content"); }
  if (verb === "step") {
    const m = /^(\S+)\s+(add|edit|clear|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use step PROCESS add LABEL | ACTIVE_MINUTES | WAIT_MINUTES | OWNER | REQUIRED_REASON_OR_none."); const [, id, mode, input] = m;
    if (mode === "add") { const [label, active, wait, ownerLabel, reason] = fields(input, 160, 11, 11, 128, 320), s: Step = { id: `step-${randomUUID()}`, label: text(label, "Label", 160), active: minutes(active), wait: minutes(wait), ownerLabel: text(ownerLabel, "Owner label", 128), requiredReason: reason === "none" ? "" : text(reason, "Required reason", 320) }; return baseline(context, id, r => { if (r.steps.length === 24) fail("Maximum 24 steps."); r.steps.push(s); return `Step ${s.id} added.`; }); }
    if (mode === "remove") { const [sid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Use step PROCESS remove STEP confirm; this removes baseline input, not an approved scenario."); return baseline(context, id, r => { step(r, sid); r.steps = r.steps.filter(s => s.id !== sid); return "Baseline step removed explicitly."; }, "remove"); }
    const f = mode === "edit" ? fields(input, 80, 20, 320) : words(input, 3), field = enumValue(f[1], ["label", "active", "wait", "ownerLabel", "requiredReason"] as const);
    if (mode === "clear" && (!['label','ownerLabel','requiredReason'].includes(field) || f[2] !== "confirm")) fail("Clear label, ownerLabel or requiredReason with confirm. Numeric zero is an explicit edit; remove the step to erase its required time fields.");
    const value = mode === "clear" ? "" : field === "active" || field === "wait" ? minutes(f[2]) : text(f[2], field, field === "label" ? 160 : field === "ownerLabel" ? 128 : 320);
    return baseline(context, id, r => { const s = step(r, f[0]); if (field === "active" || field === "wait") s[field] = value as number; else s[field] = value as string; return "Baseline step field updated."; }, mode === "clear" ? "remove" : "content");
  }
  if (verb === "move") { const [head, value] = fields(rest, 170, 2), [id, sid] = words(head, 2), position = integer(value, 1, 24); return baseline(context, id, r => { const s = step(r, sid); if (position > r.steps.length) fail("Position exceeds current step count."); r.steps = r.steps.filter(x => x.id !== sid); r.steps.splice(position - 1, 0, s); return "Baseline order updated."; }); }
  if (verb === "what-if" || verb === "revise") {
    const [head, name, value] = fields(rest, 260, 10, 320), ids = words(head, verb === "revise" ? 3 : 2), [id] = ids, sid = ids.at(-1)!, replaces = verb === "revise" ? ids[1] : null, field = enumValue(name, ["active", "wait", "owner", "remove"] as const), token = `preview-${randomUUID()}`, scenarioId = replaces ?? `scenario-${randomUUID()}`;
    if (field === "active" || field === "wait") minutes(value); else if (field === "owner") text(value, "Owner", 128);
    return mutate(context, id, (_, r) => { if (replaces) scenario(r!, replaces); else if (r!.scenarios.length === 3) fail("Maximum 3 saved scenarios. Use revise PROCESS SCENARIO STEP | FIELD | VALUE or remove a scenario explicitly.");
      const assumption: Assumption = { step: structuredClone(step(r!, sid)), field, value }, after = changed(r!.steps, assumption);
      r!.pending = { token, replaces, scenario: { id: scenarioId, name: "", baselineId: r!.baselineId, baselineRevision: r!.revision, fingerprint: fingerprint(r!), assumption, before: totals(r!.steps, r!.repetitions), after: totals(after, r!.repetitions) } };
      return saved(id, `Preview ${token}; baseline unchanged. ${summary(r!.pending.scenario.after)}\nInspect the assumption before saving; no actual process change occurs.`, `scenario-preview ${id}`);
    }, "lifecycle");
  }
  if (verb === "save-scenario") { const [head, name] = fields(rest, 170, 160), [id, token] = words(head, 2), title = text(name, "Scenario name", 160); return mutate(context, id, (_, r) => { const p = r!.pending; if (!p || p.token !== token || p.scenario.baselineId !== r!.baselineId || p.scenario.fingerprint !== fingerprint(r!)) fail("Stale/replaced/consumed scenario token; create and inspect a new preview."); const s = { ...p.scenario, name: title }; if (p.replaces) Object.assign(scenario(r!, p.replaces), s); else { if (r!.scenarios.length === 3) fail("Maximum 3 scenarios."); r!.scenarios.push(s); } r!.pending = null; return saved(id, `Scenario ${s.id} saved as reviewed assumptions only; baseline unchanged.`, `analyze ${id}`); }, "lifecycle"); }
  if (verb === "scenario-name") { const [head, name] = fields(rest, 170, 160), [id, sid] = words(head, 2), value = text(name, "Name", 160); return mutate(context, id, (_, r) => { scenario(r!, sid).name = value; r!.pending = null; return saved(id, "Scenario renamed; pending preview discarded."); }, "lifecycle"); }
  if (verb === "scenario-remove" || verb === "scenario-clear-name" || verb === "discard") { const f = words(rest, verb === "discard" ? 2 : 3); if (f.at(-1) !== "confirm") fail("Removal requires confirm."); return mutate(context, f[0], (_, r) => { if (verb === "scenario-remove") { scenario(r!, f[1]); r!.scenarios = r!.scenarios.filter(s => s.id !== f[1]); } else if (verb === "scenario-clear-name") scenario(r!, f[1]).name = ""; r!.pending = null; return saved(f[0], "Selected scenario data removed; pending preview discarded."); }, "remove"); }
  if (verb === "analyze" || verb === "scenario-preview") { const args = words(rest, 1, 4), r = find(await read(context), args[0]); if (verb === "analyze") return report(analyze(r), `analyze ${r.id}`, r, args.slice(1)); if (!r.pending) fail("No pending preview."); return report(`Before: ${summary(r.pending.scenario.before)}\nAfter: ${summary(r.pending.scenario.after)}\nJSON time fields active/wait/largestWait below are integer thousandths of a minute; reports and command inputs use minutes.\n` + JSON.stringify(r.pending, null, 2) + `\nReviewed save: ${ROUTE} save-scenario ${r.id} ${r.pending.token} | NAME`, `scenario-preview ${r.id}`, r, args.slice(1)); }
  fail("Unknown command. Use help for exact grammar.");
}

const ROOT_PREFIX = "process";
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
