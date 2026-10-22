import { randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import metadata from "./scope-slicer.metadata.js";

const MAX_RECORDS = 8;
type Priority = "must" | "should" | "could";
type Item = { id: string; label: string; priority: Priority; minutes: number; acceptance: string; prerequisites: string[]; selected: boolean };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; budget: number; items: Item[] };
type State = { version: 1; records: RecordData[] };
function topological(record: RecordData): Item[] {
  const byId = new Map(record.items.map(i => [i.id, i])), seen = new Set<string>(), active = new Set<string>(), path: string[] = [], ordered: Item[] = [];
  function visit(id: string) {
    if (seen.has(id)) return;
    if (active.has(id)) fail(`Cycle: ${[...path.slice(path.indexOf(id)), id].join(" → ")}. Prerequisite was not saved.`);
    const item = byId.get(id); if (!item) fail(`Missing prerequisite ${id}. Use an item ID from this scope.`);
    active.add(id); path.push(id); item.prerequisites.forEach(visit); path.pop(); active.delete(id); seen.add(id); ordered.push(item);
  }
  record.items.forEach(i => visit(i.id)); return ordered;
}
function validateRecord(value: unknown): asserts value is RecordData {
  object(value, ["id", "title", "revision", "createdAt", "updatedAt", "budget", "items"]); validBase(value); validNumber(value.budget, 0, 80640);
  if (!Array.isArray(value.items) || value.items.length > 24) throw new Error("Invalid items.");
  let edges = 0;
  for (const item of value.items) {
    object(item, ["id", "label", "priority", "minutes", "acceptance", "prerequisites", "selected"]);
    validId(item.id); validText(item.label, 400); validText(item.acceptance, 1200); validNumber(item.minutes, 1, 10080);
    if ((item.priority !== "must" && item.priority !== "should" && item.priority !== "could") || typeof item.selected !== "boolean") throw new Error("Invalid priority or selection.");
    if (!Array.isArray(item.prerequisites) || item.prerequisites.length > 23) throw new Error("Invalid prerequisites."); item.prerequisites.forEach(validId); unique(item.prerequisites); edges += item.prerequisites.length;
  }
  if (edges > 60) throw new Error("Too many prerequisite edges."); unique(value.items.map(i => i.id)); topological(value as unknown as RecordData);
}
function projectLifecycle(state: State): State {
  // All optional analysis is unsaved. false is the longer JSON selection value;
  // reserve it for every child plus maximum revision digits for select/unselect.
  return { ...state, records: state.records.map(r => ({ ...r, revision: MAX_REVISION, items: r.items.map(i => ({ ...i, selected: false })) })) };
}
function item(record: RecordData, id: string): Item {
  const result = record.items.find(i => i.id === id); if (!result) fail("Item ID not found in this scope."); return result;
}
function priority(input: string): Priority {
  if (input !== "must" && input !== "should" && input !== "could") fail("Priority must be must, should, or could."); return input;
}
function sliceLines(record: RecordData, budget: number): string[] {
  const ordered = topological(record), byId = new Map(record.items.map(i => [i.id, i]));
  const closure = (roots: readonly string[]): Set<string> => {
    const found = new Set<string>();
    const visit = (id: string) => { if (found.has(id)) return; found.add(id); byId.get(id)!.prerequisites.forEach(visit); };
    roots.forEach(visit); return found;
  };
  const cost = (ids: Iterable<string>) => [...ids].reduce((sum, id) => sum + byId.get(id)!.minutes, 0);
  const roots = record.items.filter(i => i.priority === "must" || i.selected), required = closure(roots.map(i => i.id));
  const requiredCost = cost(required), selected = new Set(required), decisions: string[] = [];
  let used = requiredCost;
  const optional = record.items.map((i, position) => ({ i, position })).filter(({ i }) => !required.has(i.id))
    .sort((a, b) => (a.i.priority === "should" ? 0 : 1) - (b.i.priority === "should" ? 0 : 1) || a.position - b.position);
  for (const { i } of optional) {
    if (selected.has(i.id)) { decisions.push(`${i.id}: included as a prerequisite already; additional cost 0 minutes.`); continue; }
    const extra = [...closure([i.id])].filter(id => !selected.has(id)), incremental = cost(extra);
    if (requiredCost > budget) decisions.push(`${i.id}: deferred; mandatory core already exceeds budget. Its remaining prerequisite closure costs ${incremental} minutes.`);
    else if (used + incremental > budget) decisions.push(`${i.id}: deferred; ${incremental} incremental minutes including prerequisites exceeds remaining ${budget - used}.`);
    else { extra.forEach(id => selected.add(id)); used += incremental; decisions.push(`${i.id}: included by ${i.priority} priority and entered order; incremental cost ${incremental} minutes for ${extra.length} new item(s).`); }
  }
  const lines = [
    requiredCost > budget ? `Infeasible: required core ${requiredCost} exceeds budget ${budget} by ${requiredCost - budget} minutes. Every must/selected item and prerequisite is retained in the required core; none is quietly cut.` : `Required core fits: ${requiredCost} of ${budget} minutes.`,
    `Required ${required.size} item(s); included ${selected.size}; deferred ${record.items.length - selected.size}; used ${used}; ${used > budget ? `over budget ${used - budget}` : `remaining ${budget - used}`} minutes.`,
    "Heuristic: required transitive closure first; then should before could, entered order within priority. Add an optional item only when its whole incremental closure fits. Shared prerequisites count once. No exponential search or optimality claim.",
    roots.length ? `Required roots: ${roots.map(i => i.id).join(", ")}.` : "No must or explicitly selected items declared. The empty required core does not establish a useful minimum deliverable.",
    "Included work in prerequisite order (inclusion is not completion):",
  ];
  for (const i of ordered.filter(i => selected.has(i.id))) {
    const reason = required.has(i.id) ? i.priority === "must" ? "must" : i.selected ? "explicitly selected" : "required prerequisite" : "optional or optional prerequisite";
    lines.push(`${i.id} · ${reason} · ${i.priority} · ${i.minutes} minutes`, i.label, `Acceptance: ${i.acceptance}`, `Prerequisites: ${i.prerequisites.join(", ") || "none"}.`);
  }
  lines.push("Optional decisions:", ...decisions);
  for (const i of record.items.filter(i => !selected.has(i.id))) lines.push(`Deferred ${i.id} · ${i.label} · ${i.minutes} minutes`, `Acceptance retained: ${i.acceptance}`);
  return lines;
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [titleInput, budgetInput] = fields(rest, 162, 16), record: RecordData = { ...base(context, "scope", text(titleInput, "Title", 160)), budget: integer(budgetInput, 0, 80640, "Budget"), items: [] };
    return mutate(context, undefined, state => { state.records.push(record); return saved(record.id, "Scope budget saved. Add must/should/could deliverables with acceptance criteria.", `slice ${record.id}`); });
  }
  if (verb === "edit") {
    const [id, titleInput, budgetInput] = fields(rest, 80, 162, 16), title = text(titleInput, "Title", 160), budget = integer(budgetInput, 0, 80640, "Budget");
    return mutate(context, id, (_, r) => { r!.title = title; r!.budget = budget; return saved(id, "Title and budget updated; priorities, selections and acceptance criteria preserved.", `slice ${id}`); });
  }
  if (verb === "item") {
    const match = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!match) fail("Use item SCOPE add LABEL | must/should/could | MINUTES | ACCEPTANCE.");
    const [, id, mode, input] = match;
    if (mode === "remove") {
      const [child, confirm] = words(input, 2); if (confirm !== "confirm") fail("Use item SCOPE remove ITEM confirm.");
      return mutate(context, id, (_, r) => {
        item(r!, child); const dependents = r!.items.filter(i => i.prerequisites.includes(child));
        if (dependents.length) fail(`Remove prerequisite edges first; this item is required by ${dependents.map(i => i.id).join(", ")}.`);
        r!.items = r!.items.filter(i => i.id !== child); return saved(id, "Item, its selection and incoming prerequisites removed.", `slice ${id}`);
      }, "remove");
    }
    const values = fields(input, ...(mode === "edit" ? [80] : []), 402, 16, 16, 1202), child = mode === "edit" ? values.shift()! : `item-${randomUUID()}`;
    const label = text(values[0], "Deliverable", 400), level = priority(values[1]), minutes = integer(values[2], 1, 10080), acceptance = text(values[3], "Acceptance", 1200);
    return mutate(context, id, (_, r) => {
      if (mode === "add") { if (r!.items.length >= 24) fail("Maximum 24 deliverables per scope."); r!.items.push({ id: child, label, priority: level, minutes, acceptance, prerequisites: [], selected: false }); }
      else Object.assign(item(r!, child), { label, priority: level, minutes, acceptance });
      return saved(id, `Item ${child} · ${level} · ${minutes} minutes.`, `slice ${id}`);
    });
  }
  if (verb === "requires" || verb === "unrequire") {
    const [head, tail] = fields(rest, 180, 100), [id, child] = words(head, 2), [predecessor, confirm] = words(tail, verb === "requires" ? 1 : 2);
    if (verb === "unrequire" && confirm !== "confirm") fail("Use unrequire SCOPE ITEM | PREREQUISITE confirm.");
    return mutate(context, id, (_, r) => {
      const node = item(r!, child); if (!r!.items.some(i => i.id === predecessor)) fail(`Missing prerequisite ${predecessor}. Use an item ID from this scope.`);
      if (verb === "requires") {
        if (node.prerequisites.includes(predecessor)) fail("That prerequisite is already recorded.");
        if (r!.items.reduce((sum, i) => sum + i.prerequisites.length, 0) >= 60) fail("Maximum 60 prerequisite edges per scope.");
        node.prerequisites.push(predecessor); topological(r!);
      } else { if (!node.prerequisites.includes(predecessor)) fail("That prerequisite edge is not recorded."); node.prerequisites = node.prerequisites.filter(id => id !== predecessor); }
      return saved(id, `Prerequisite ${verb === "requires" ? "added" : "removed"}: ${child} requires ${predecessor}.`, `slice ${id}`);
    }, verb === "requires" ? "content" : "remove");
  }
  if (verb === "select" || verb === "unselect") {
    const [id, child, confirm] = words(rest, verb === "select" ? 2 : 3);
    if (verb === "unselect" && confirm !== "confirm") fail("Use unselect SCOPE ITEM confirm.");
    return mutate(context, id, (_, r) => { item(r!, child).selected = verb === "select"; return saved(id, `Item ${child}: ${verb === "select" ? "explicitly required with all prerequisites" : "explicit selection removed; must priority and dependency requirements still apply"}.`, `slice ${id}`); }, "lifecycle");
  }
  if (verb === "slice") {
    const [id, page] = words(rest, 1, 2), record = find(await read(context), id);
    return report([...sliceLines(record, record.budget), `Next: ${ROUTE} show ${id}`], `slice ${id}`, checked(() => parsePage(page)), `Private · unsaved scope slice · ${id} · revision ${record.revision}`);
  }
  if (verb === "what-if") {
    const [id, tail] = fields(rest, 80, 32), [budgetInput, page] = words(tail, 1, 2), budget = integer(budgetInput, 0, 80640, "Budget"), record = find(await read(context), id);
    return report([`Unsaved what-if budget ${budget}; saved budget remains ${record.budget}. Categories, selections, prerequisites and acceptance remain unchanged.`, ...sliceLines(record, budget), `Next: ${ROUTE} slice ${id}`],
      `what-if ${id} | ${budget}`, checked(() => parsePage(page)), `Private · unsaved scope comparison · ${id} · revision ${record.revision}`);
  }
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
