import { randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, addCivilDays, dateInZone } from "./feature-kit/civil-time.js";
import metadata from "./deadline-backplan.metadata.js";

const MAX_RECORDS = 8;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
type Milestone = { id: string; label: string; durationDays: number; bufferDays: number; predecessors: string[] };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; finish: string; weekdays: number[]; excluded: string[]; milestones: Milestone[] };
type State = { version: 1; records: RecordData[] };
function topological(record: RecordData): Milestone[] {
  const byId = new Map(record.milestones.map(m => [m.id, m])), visited = new Set<string>(), visiting = new Set<string>(), stack: string[] = [], result: Milestone[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail(`Cycle: ${[...stack.slice(stack.indexOf(id)), id].join(" → ")}. Dependency was not saved.`);
    const node = byId.get(id); if (!node) fail(`Missing prerequisite ${id}. Use a milestone ID from this plan.`);
    visiting.add(id); stack.push(id); node.predecessors.forEach(visit); stack.pop(); visiting.delete(id); visited.add(id); result.push(node);
  }
  record.milestones.forEach(m => visit(m.id)); return result;
}
function validateRecord(value: unknown): asserts value is RecordData {
  object(value, ["id", "title", "revision", "createdAt", "updatedAt", "finish", "weekdays", "excluded", "milestones"]); validBase(value); civilDate(value.finish);
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7) throw new Error("Invalid weekdays.");
  value.weekdays.forEach(d => validNumber(d, 0, 6)); unique(value.weekdays.map(String));
  if (!Array.isArray(value.excluded) || value.excluded.length > 30) throw new Error("Invalid exclusions."); value.excluded.forEach(civilDate); unique(value.excluded);
  if (!Array.isArray(value.milestones) || value.milestones.length > 20) throw new Error("Invalid milestones.");
  let edges = 0;
  for (const milestone of value.milestones) {
    object(milestone, ["id", "label", "durationDays", "bufferDays", "predecessors"]); validId(milestone.id); validText(milestone.label, 400); validNumber(milestone.durationDays, 1, 366); validNumber(milestone.bufferDays, 0, 365);
    if (!Array.isArray(milestone.predecessors) || milestone.predecessors.length > 19) throw new Error("Invalid prerequisites."); milestone.predecessors.forEach(validId); unique(milestone.predecessors); edges += milestone.predecessors.length;
  }
  if (edges > 60) throw new Error("Too many edges."); unique(value.milestones.map(m => m.id)); topological(value as unknown as RecordData);
}
function projectLifecycle(state: State): State { return { ...state, records: state.records.map(r => ({ ...r, revision: MAX_REVISION })) }; }
function weekdays(input: string): number[] {
  const days = input.split(",").map(v => WEEKDAYS.indexOf(v.trim().toLowerCase()));
  if (!days.length || days.length > 7 || days.includes(-1) || new Set(days).size !== days.length) fail("Use distinct weekday codes: sun,mon,tue,wed,thu,fri,sat; at least one is required.");
  return days.sort((a, b) => a - b);
}
function finishDate(input: string, context: AgentFeatureContext): string {
  const finish = checked(() => civilDate(input)), today = checked(() => dateInZone(context.now, context.timezone));
  if (Math.abs(civilDaysBetween(today, finish)) > 366) fail(`Finish must be within 366 civil days of today (${today}, ${context.timezone}). Historical starts are reported as risks.`);
  checked(() => addCivilDays(finish, -365)); return finish;
}
function milestone(record: RecordData, id: string): Milestone {
  const node = record.milestones.find(m => m.id === id); if (!node) fail("Milestone ID not found in this plan."); return node;
}
function backplan(record: RecordData, context: AgentFeatureContext, page: number): string {
  const today = checked(() => dateInZone(context.now, context.timezone)), windowStart = checked(() => addCivilDays(record.finish, -365));
  const days: string[] = [];
  for (let offset = 0; offset < 366; offset++) {
    const day = addCivilDays(windowStart, offset), weekday = ((civilDaysBetween("1970-01-04", day) % 7) + 7) % 7;
    if (record.weekdays.includes(weekday) && !record.excluded.includes(day)) days.push(day);
  }
  const ordered = topological(record), latest = new Map<string, { start: number; workFinish: number; end: number }>(), earliest = new Map<string, number>();
  const lines = [`Finish requested ${record.finish}; latest working finish ${days.at(-1) ?? "none in horizon"}. Today ${today} (${context.timezone}).`,
    `Working weekdays ${record.weekdays.map(d => WEEKDAYS[d]).join(",")}; excluded dates ${record.excluded.join(", ") || "none"}. No implicit public holidays.`,
    `Bounded civil horizon: ${windowStart}–${record.finish} (366 days). Work start/finish are inclusive; buffer follows work on separate working days; prerequisites including buffers finish strictly before dependent starts.`,
    "Slack is working-day room between a today-based earliest prerequisite start and latest start, within this horizon. Unrelated milestones may overlap; people/capacity are not modeled."];
  if (!ordered.length) return report([...lines, "No milestones yet; deadline feasibility is unknown.", `Next: ${ROUTE} show ${record.id}`], `backplan ${record.id}`, page, `Private · unsaved backplan · ${record.id} · revision ${record.revision}`);
  for (const node of ordered.slice().reverse()) {
    const successors = ordered.filter(m => m.predecessors.includes(node.id));
    const end = successors.length ? Math.min(...successors.map(m => latest.get(m.id)!.start - 1)) : days.length - 1;
    const workFinish = end - node.bufferDays, start = workFinish - node.durationDays + 1;
    if (start < 0 || !days.length) return report([...lines, `Infeasible within the 366-day analysis horizon: ${node.id} needs ${node.durationDays} work + ${node.bufferDays} buffer working days before its dependents. Reduce durations/buffers, change dependencies/working days, or choose another finish date. No partial schedule is presented as feasible.`, `Next: ${ROUTE} show ${record.id}`], `backplan ${record.id}`, page, `Private · unsaved backplan · ${record.id} · revision ${record.revision}`);
    latest.set(node.id, { start, workFinish, end });
  }
  const todayIndex = days.findIndex(day => day >= today), baseline = todayIndex === -1 ? days.length : todayIndex;
  for (const node of ordered) earliest.set(node.id, Math.max(baseline, ...node.predecessors.map(id => {
    const predecessor = milestone(record, id); return earliest.get(id)! + predecessor.durationDays + predecessor.bufferDays;
  })));
  const late = ordered.filter(m => days[latest.get(m.id)!.start] < today);
  lines.unshift(late.length ? `Deadline at risk: ${late.length} latest start(s) are already in the past. No dates were shifted to hide the risk.` : "Deadline feasible under supplied dependencies/working-day assumptions; not a resource-capacity guarantee.");
  for (const node of ordered) {
    const slot = latest.get(node.id)!;
    lines.push(`${node.id} · ${node.label}`, `Latest start ${days[slot.start]}; work finish ${days[slot.workFinish]}; ready after buffer ${days[slot.end]}.`,
      `Work ${node.durationDays} working day(s); buffer ${node.bufferDays ? `${node.bufferDays} working day(s): ${days[slot.workFinish + 1]}–${days[slot.end]}` : "none"}; slack ${slot.start - earliest.get(node.id)!} working day(s).${days[slot.start] < today ? " Start is in the past." : ""}`,
      `Prerequisites: ${node.predecessors.join(", ") || "none"}.`);
  }
  lines.push(`Next: ${ROUTE} show ${record.id}`);
  return report(lines, `backplan ${record.id}`, page, `Private · unsaved backplan · ${record.id} · revision ${record.revision}`);
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [titleInput, finishInput, weekdaysInput] = fields(rest, 162, 16, 64), record: RecordData = { ...base(context, "plan", text(titleInput, "Title", 160)), finish: finishDate(finishInput, context), weekdays: weekdays(weekdaysInput), excluded: [], milestones: [] };
    return mutate(context, undefined, state => { state.records.push(record); return saved(record.id, "Finish and working weekdays saved. Add milestones and explicit prerequisites using help.", `backplan ${record.id}`); });
  }
  if (verb === "edit") {
    const [id, titleInput, finishInput, weekdaysInput] = fields(rest, 80, 162, 16, 64), title = text(titleInput, "Title", 160), finish = finishDate(finishInput, context), workdays = weekdays(weekdaysInput);
    return mutate(context, id, (_, r) => { r!.title = title; r!.finish = finish; r!.weekdays = workdays; return saved(id, "Title, deadline and working weekdays updated; exclusions and milestones preserved.", `backplan ${id}`); });
  }
  if (verb === "milestone") {
    const match = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!match) fail("Use milestone PLAN add LABEL | WORK-DAYS | BUFFER-DAYS.");
    const [, id, mode, input] = match;
    if (mode === "remove") {
      const [child, confirm] = words(input, 2); if (confirm !== "confirm") fail("Use milestone PLAN remove MILESTONE confirm.");
      return mutate(context, id, (_, r) => { milestone(r!, child); const dependents = r!.milestones.filter(m => m.predecessors.includes(child)); if (dependents.length) fail(`Remove dependency edges first; this milestone is required by ${dependents.map(m => m.id).join(", ")}.`); r!.milestones = r!.milestones.filter(m => m.id !== child); return saved(id, "Milestone and its incoming prerequisites removed.", `backplan ${id}`); }, "remove");
    }
    const values = fields(input, ...(mode === "edit" ? [80] : []), 402, 16, 16), child = mode === "edit" ? values.shift()! : `milestone-${randomUUID()}`;
    const label = text(values[0], "Milestone", 400), durationDays = integer(values[1], 1, 366, "Work days"), bufferDays = integer(values[2], 0, 365, "Buffer days");
    return mutate(context, id, (_, r) => {
      if (mode === "add") { if (r!.milestones.length >= 20) fail("Maximum 20 milestones per plan."); r!.milestones.push({ id: child, label, durationDays, bufferDays, predecessors: [] }); }
      else Object.assign(milestone(r!, child), { label, durationDays, bufferDays });
      return saved(id, `Milestone ${child}: ${durationDays} work + ${bufferDays} buffer working days.`, `backplan ${id}`);
    });
  }
  if (verb === "depends" || verb === "undepend") {
    const [head, tail] = fields(rest, 180, 100), [id, child] = words(head, 2), [predecessor, confirm] = words(tail, verb === "depends" ? 1 : 2);
    if (verb === "undepend" && confirm !== "confirm") fail("Use undepend PLAN MILESTONE | PREREQUISITE confirm.");
    return mutate(context, id, (_, r) => {
      const node = milestone(r!, child); if (!r!.milestones.some(m => m.id === predecessor)) fail(`Missing prerequisite ${predecessor}. Use a milestone ID from this plan.`);
      if (verb === "depends") {
        if (node.predecessors.includes(predecessor)) fail("That prerequisite is already recorded.");
        if (r!.milestones.reduce((sum, m) => sum + m.predecessors.length, 0) >= 60) fail("Maximum 60 prerequisite edges per plan.");
        node.predecessors.push(predecessor); topological(r!);
      } else { if (!node.predecessors.includes(predecessor)) fail("That dependency edge is not recorded."); node.predecessors = node.predecessors.filter(p => p !== predecessor); }
      return saved(id, `Dependency ${verb === "depends" ? "added" : "removed"}: ${child} follows ${predecessor}.`, `backplan ${id}`);
    }, verb === "depends" ? "content" : "remove");
  }
  if (verb === "exclude" || verb === "include") {
    const [id, tail] = fields(rest, 80, 32), [dateInput, confirm] = words(tail, verb === "exclude" ? 1 : 2), date = checked(() => civilDate(dateInput));
    if (verb === "include" && confirm !== "confirm") fail("Use include PLAN | DATE confirm to remove an exclusion.");
    return mutate(context, id, (_, r) => {
      if (verb === "exclude") { if (r!.excluded.includes(date)) fail("That date is already excluded."); if (r!.excluded.length >= 30) fail("Maximum 30 excluded dates per plan."); r!.excluded.push(date); r!.excluded.sort(); }
      else { if (!r!.excluded.includes(date)) fail("That date is not explicitly excluded."); r!.excluded = r!.excluded.filter(d => d !== date); }
      return saved(id, `${date} ${verb === "exclude" ? "excluded from working days" : "exclusion removed; weekday rules still apply"}.`, `backplan ${id}`);
    }, verb === "exclude" ? "content" : "remove");
  }
  if (verb === "backplan") { const [id, page] = words(rest, 1, 2); return backplan(find(await read(context), id), context, checked(() => parsePage(page))); }
  fail("Unknown command. Use help for supported syntax.");
}

const ROUTE = `/nobo-help agent ${metadata.id}`;
const MAX_REVISION = 999_999_999;
const EMPTY: State = { version: 1, records: [] };
class CommandError extends Error {}
function fail(message: string): never { throw new CommandError(message); }
function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { if (error instanceof Error) fail(error.message); throw error; }
}
function text(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  return checked(() => boundedText(value, { label, maxBytes, allowEmpty }));
}
function fields(input: string, ...limits: number[]): string[] {
  return checked(() => pipeFields(input, limits.map((maxBytes, i) => ({ label: `Field ${i + 1}`, maxBytes, allowEmpty: true }))));
}
function integer(value: string, min: number, max: number, label = "Minutes"): number {
  return checked(() => parseInteger(value, { min, max, label }));
}
function words(value: string, min: number, max = min): string[] {
  const parts = value.trim() ? value.trim().split(/\s+/u) : [];
  if (parts.length < min || parts.length > max) fail("Wrong arguments. Use the exact syntax in help.");
  return parts;
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.slice().sort().join(",")) throw new Error("Invalid object fields.");
}
function validText(value: unknown, maxBytes: number, allowEmpty = false): void {
  boundedText(value, { label: "Saved text", maxBytes, allowEmpty, trim: false });
}
function validNumber(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error("Invalid number.");
}
function validId(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid ID.");
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error("Duplicate values.");
}
function validBase(record: Record<string, unknown>): void {
  validId(record.id); validText(record.title, 160); validNumber(record.revision, 1, MAX_REVISION);
  for (const value of [record.createdAt, record.updatedAt]) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid timestamp.");
  }
}
function decode(value: unknown): State {
  try {
    assertStateVersion(value, 1); object(value, ["version", "records"]);
    if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("Invalid records.");
    for (const record of value.records) validateRecord(record);
    unique(value.records.map(record => record.id));
    return value as unknown as State;
  } catch { fail("Saved data could not be read safely. It was preserved; no reset or mutation was performed."); }
}
const envelope = (record: RecordData) => ({ feature: metadata.id, version: 1, record });
function quota(state: State, kind: "content" | "lifecycle"): void {
  checked(() => {
    const future = projectLifecycle(state);
    assertQuota(state, kind === "content"
      ? { kind, records: state.records.map(envelope), future: { value: future, records: future.records.map(envelope) }, limits: { maxRecords: MAX_RECORDS } }
      : { kind, records: state.records.map(envelope), limits: { maxRecords: MAX_RECORDS } });
  });
}
function find(state: State, id: string): RecordData {
  const result = state.records.find(record => record.id === id);
  if (!result) fail("Item not found in your private records. Use list to find a saved ID.");
  return result;
}
async function read(context: AgentFeatureContext): Promise<State> {
  const value = await context.store.read<unknown>("state");
  context.signal?.throwIfAborted();
  return value === null ? structuredClone(EMPTY) : decode(value);
}
async function mutate(context: AgentFeatureContext, id: string | undefined, change: (state: State, record?: RecordData) => string,
  kind: "content" | "lifecycle" | "remove" = "content"): Promise<string> {
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, current => {
    const state = structuredClone(decode(current));
    const record = id === undefined ? undefined : find(state, id);
    const result = change(state, record);
    if (record && state.records.includes(record)) {
      if (record.revision >= MAX_REVISION) fail("Revision limit reached. Export this record and create a new one.");
      record.revision++; record.updatedAt = timestamp;
    }
    if (state.records.length > MAX_RECORDS) fail(`Maximum ${MAX_RECORDS} records. Use list, export, then delete ID confirm to free space.`);
    decode(state);
    // Removal remains possible for readable legacy state over the current byte cap.
    if (kind !== "remove") quota(state, kind);
    return { value: state, result };
  });
}
function base(context: AgentFeatureContext, prefix: string, title: string) {
  return { id: `${prefix}-${randomUUID()}`, title, revision: 1, createdAt: context.now.toISOString(), updatedAt: context.now.toISOString() };
}
function saved(id: string, detail: string, next = `show ${id}`): string {
  return `Saved privately: ${id}\n${detail}\nNext: ${ROUTE} ${next}`;
}
function view(parts: { text: string; atomic?: boolean }[], command: string, page = 1, title = "Private · unsaved report"): string {
  return checked(() => pageAt(paginateParts(parts, { mode: "plain", title, command: n => `${ROUTE} ${command} ${n}` }), page).text);
}
function report(lines: string[], command: string, page = 1, title?: string): string {
  return view(lines.map(line => ({ text: `${line}\n`, atomic: true })), command, page, title);
}
async function common(verb: string, rest: string, context: AgentFeatureContext): Promise<string | undefined> {
  if (verb === "list") {
    const args = words(rest, 0, 1), page = checked(() => parsePage(args[0]));
    const state = await read(context), total = Math.max(1, Math.ceil(state.records.length / 10));
    if (page > total) fail(`Current list has ${total} page(s). Reopen list 1.`);
    if (!state.records.length) return `No saved items yet.\nNext: ${metadata.example}`;
    const rows = state.records.slice((page - 1) * 10, page * 10).map(r => `${r.id} — ${r.title.replace(/[\r\n]/g, " ")} · revision ${r.revision}`);
    return `Private · current list · page ${page}/${total} · ${(page - 1) * 10 + 1}–${Math.min(page * 10, state.records.length)} of ${state.records.length}\n${rows.join("\n")}\nNext: ${ROUTE} ${page < total ? `list ${page + 1}` : `show ${state.records[(page - 1) * 10].id}`}`;
  }
  if (verb === "show" || verb === "export") {
    const args = words(rest, 1, verb === "show" ? 2 : 1), record = find(await read(context), args[0]);
    if (verb === "export") {
      const result = JSON.stringify(envelope(record));
      if (serializedBytes(envelope(record)) > 24_576) fail(`This legacy record exceeds the export ceiling. Retrieve all parts with show ${record.id}.`);
      return result;
    }
    const json = JSON.stringify(envelope(record), null, 2);
    // Keys and IDs stay on complete lines; each accepted text field is <=1200 bytes.
    return view(json.split("\n").map(line => ({ text: line + "\n", atomic: true })), `show ${record.id}`, checked(() => parsePage(args[1])),
      `Saved privately: ${record.id} · revision ${record.revision} · current data; restart page 1 if revision changes`);
  }
  if (verb === "delete") {
    const args = words(rest, 1, 2);
    if (args[1] !== undefined && args[1] !== "confirm") fail("Use delete ID confirm.");
    if (args[1] !== "confirm") {
      const record = find(await read(context), args[0]);
      return `Delete ${record.id} and all its owned children?\nNext: ${ROUTE} delete ${record.id} confirm`;
    }
    return mutate(context, args[0], state => {
      state.records = state.records.filter(record => record.id !== args[0]);
      return `Deleted privately: ${args[0]} and its owned children.\nNext: ${ROUTE} list`;
    }, "remove");
  }
  return undefined;
}

export default {
  ...metadata,
  async execute(command: string, context: AgentFeatureContext): Promise<string> {
    if (!command.trim() || command.trim() === "help") return metadata.help;
    try {
      text(command, "Command", 16_000);
      context.signal?.throwIfAborted();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim())!;
      const verb = match[1], rest = match[2] ?? "";
      return await common(verb, rest, context) ?? await executeDomain(verb, rest, context);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CommandError) return `${error.message}\nNext: ${ROUTE} help`;
      return `This command could not be completed safely. Any dispatched save may have completed; inspect your private records before repeating it.\nNext: ${ROUTE} list`;
    }
  },
} satisfies AgentFeature;
