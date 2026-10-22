import { randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import metadata from "./context-batch.metadata.js";

const MAX_RECORDS = 12;
type Action = { id: string; label: string; minutes: number; setupKey: string; tools: string[]; location: string; status: "pending" | "completed" };
type Setup = { id: string; key: string; minutes: number };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; budget: number;
  setups: Setup[]; actions: Action[]; context: { location: string; tools: string[] } | null };
type State = { version: 1; records: RecordData[] };
function validTools(value: unknown): void {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid tools.");
  for (const tool of value) { validText(tool, 40); if (tool === "-" || tool.includes(",")) throw new Error("Invalid tool."); }
  unique(value);
}
function validateRecord(value: unknown): asserts value is RecordData {
  object(value, ["id", "title", "revision", "createdAt", "updatedAt", "budget", "setups", "actions", "context"]);
  validBase(value); validNumber(value.budget, 1, 10_080);
  if (!Array.isArray(value.setups) || value.setups.length > 12 || !Array.isArray(value.actions) || value.actions.length > 40) throw new Error("Invalid children.");
  for (const setup of value.setups) { object(setup, ["id", "key", "minutes"]); validId(setup.id); validText(setup.key, 80); if (setup.key === "-") throw new Error("Reserved key."); validNumber(setup.minutes, 0, 1440); }
  unique(value.setups.map(s => s.id)); unique(value.setups.map(s => s.key));
  for (const action of value.actions) {
    object(action, ["id", "label", "minutes", "setupKey", "tools", "location", "status"]);
    validId(action.id); validText(action.label, 400); validNumber(action.minutes, 1, 1440); validText(action.setupKey, 80); validTools(action.tools); validText(action.location, 80);
    if (action.status !== "pending" && action.status !== "completed") throw new Error("Invalid status.");
  }
  unique(value.actions.map(a => a.id));
  if (value.context !== null) { object(value.context, ["location", "tools"]); validText(value.context.location, 80); validTools(value.context.tools); }
}
function projectLifecycle(state: State): State {
  // Every action can expand pending -> completed; context is optional new content.
  return { ...state, records: state.records.map(r => ({ ...r, revision: MAX_REVISION,
    actions: r.actions.map(a => ({ ...a, status: "completed" })) })) };
}
function toolsList(value: string): string[] {
  if (value === "-") return [];
  const result = value.split(",").map(v => text(v, "Tool", 40));
  if (result.length > 8 || new Set(result).size !== result.length || result.includes("-")) fail("Use up to eight distinct comma-separated tools, or - for none.");
  return result;
}
function actionFields(values: string[]): Omit<Action, "id" | "status"> {
  return { label: text(values[0], "Action", 400), minutes: integer(values[1], 1, 1440), setupKey: text(values[2], "Setup key", 80), tools: toolsList(values[3]), location: text(values[4], "Location", 80) };
}
function batch(record: RecordData, page: number): string {
  if (!record.context) fail(`Set available context first: batch ${record.id} | home | laptop`);
  const groups = new Map<string, Action[]>(), exclusions: string[] = [];
  for (const action of record.actions) {
    const reasons: string[] = [];
    if (action.status === "completed") reasons.push("user-reported completed");
    if (action.location !== "-" && action.location !== record.context.location) reasons.push(`needs location ${action.location}`);
    const missing = action.tools.filter(tool => !record.context!.tools.includes(tool));
    if (missing.length) reasons.push(`missing tools: ${missing.join(", ")}`);
    if (action.setupKey !== "-" && !record.setups.some(s => s.key === action.setupKey)) reasons.push(`unknown setup cost: ${action.setupKey}`);
    if (reasons.length) { exclusions.push(`${action.id}: ${reasons.join("; ")}`); continue; }
    const group = groups.get(action.setupKey) ?? []; group.push(action); groups.set(action.setupKey, group);
  }
  let used = 0, savings = 0;
  const lines: string[] = [];
  for (const [key, actions] of groups) {
    const setup = key === "-" ? 0 : record.setups.find(s => s.key === key)!.minutes;
    const selected: Action[] = [];
    for (const action of actions) {
      const extra = action.minutes + (selected.length ? 0 : setup);
      if (used + extra <= record.budget) { selected.push(action); used += extra; }
      else exclusions.push(`${action.id}: needs ${extra} additional minutes; ${record.budget - used} remained when considered`);
    }
    if (selected.length) {
      const work = selected.reduce((sum, a) => sum + a.minutes, 0);
      savings += (selected.length - 1) * setup;
      lines.push(`Group ${key}: ${work} action + ${setup} setup = ${work + setup} minutes`);
      selected.forEach(a => { lines.push(`${a.id} · ${a.minutes} minutes · ${a.label}`); });
    }
  }
  return report([
    `Budget ${record.budget}; used ${used}; remaining ${record.budget - used} minutes. Setup savings ${savings} minutes versus paying setup for each selected action.`,
    `Context saved: ${record.context.location}; tools ${record.context.tools.join(", ") || "none"}. Actions unchanged.`,
    "Heuristic: first-seen eligible setup groups, then entered action order; skip actions that do not fit. This is not an optimal schedule.",
    ...lines, `Excluded ${exclusions.length}:`, ...exclusions,
    `Next: ${ROUTE} show ${record.id}`,
  ], `batch ${record.id}`, page, `Private · unsaved batch · ${record.id} · revision ${record.revision}`);
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [title, budget] = fields(rest, 162, 16), record: RecordData = { ...base(context, "board", text(title, "Title", 160)), budget: integer(budget, 1, 10080), setups: [], actions: [], context: null };
    return mutate(context, undefined, state => { state.records.push(record); return saved(record.id, "Board ready. Add setup costs and actions using help."); });
  }
  if (verb === "edit") {
    const [id, title, budget] = fields(rest, 80, 162, 16), name = text(title, "Title", 160), minutes = integer(budget, 1, 10080);
    return mutate(context, id, (_, r) => { r!.title = name; r!.budget = minutes; return saved(id, "Updated title and budget."); });
  }
  if (verb === "setup" || verb === "setup-edit") {
    const [head, keyInput, duration] = fields(rest, 160, 82, 16), [id, setupId] = words(head, verb === "setup" ? 1 : 2);
    const key = text(keyInput, "Setup key", 80), minutes = integer(duration, 0, 1440), newId = `setup-${randomUUID()}`;
    if (key === "-") fail("- means no setup; choose a named setup key.");
    return mutate(context, id, (_, r) => {
      const record = r!, existing = verb === "setup" ? record.setups.find(s => s.key === key) : record.setups.find(s => s.id === setupId);
      if (verb === "setup-edit" && !existing) fail("Setup ID not found in this board.");
      if (existing) {
        if (record.setups.some(s => s !== existing && s.key === key)) fail("Another setup already uses this key.");
        const old = existing.key; existing.key = key; existing.minutes = minutes;
        record.actions.forEach(a => { if (a.setupKey === old) a.setupKey = key; });
      } else { if (record.setups.length >= 12) fail("Maximum 12 setup keys per board."); record.setups.push({ id: newId, key, minutes }); }
      return saved(id, `Setup ${existing?.id ?? newId}: ${minutes} minutes. Referencing actions keep the same setup.`);
    });
  }
  if (verb === "setup-remove") {
    const [id, setupId, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use setup-remove BOARD SETUP confirm.");
    return mutate(context, id, (_, r) => {
      const setup = r!.setups.find(s => s.id === setupId); if (!setup) fail("Setup ID not found in this board.");
      if (r!.actions.some(a => a.setupKey === setup.key)) fail("This setup is used by an action. Edit that action's setup key to - or another setup first.");
      r!.setups = r!.setups.filter(s => s.id !== setupId); return saved(id, "Setup removed.");
    }, "remove");
  }
  if (verb === "action") {
    const match = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!match) fail("Use action BOARD add LABEL | MINUTES | SETUP-KEY | TOOLS | LOCATION.");
    const [, id, mode, input] = match;
    if (mode === "remove") {
      const [child, confirm] = words(input, 2); if (confirm !== "confirm") fail("Use action BOARD remove ACTION confirm.");
      return mutate(context, id, (_, r) => { if (!r!.actions.some(a => a.id === child)) fail("Action ID not found in this board."); r!.actions = r!.actions.filter(a => a.id !== child); return saved(id, "Action removed."); }, "remove");
    }
    const values = fields(input, ...(mode === "edit" ? [80] : []), 402, 16, 82, 400, 82);
    const child = mode === "edit" ? values.shift()! : `action-${randomUUID()}`, action = actionFields(values);
    return mutate(context, id, (_, r) => {
      if (mode === "add") { if (r!.actions.length >= 40) fail("Maximum 40 actions per board."); r!.actions.push({ id: child, ...action, status: "pending" }); }
      else { const old = r!.actions.find(a => a.id === child); if (!old) fail("Action ID not found in this board."); Object.assign(old, action, { status: "pending" }); }
      return saved(id, `Action ${child} · pending. Editing reopens a completed action.`);
    });
  }
  if (verb === "batch") {
    if (rest.includes("|")) {
      const [id, location, toolInput] = fields(rest, 80, 82, 400), available = { location: text(location, "Location", 80), tools: toolsList(toolInput) };
      await mutate(context, id, (_, r) => { r!.context = available; return "Saved context."; });
      return batch(find(await read(context), id), 1);
    }
    const [id, page] = words(rest, 1, 2); return batch(find(await read(context), id), checked(() => parsePage(page)));
  }
  if (verb === "context-clear") {
    const [id, confirm] = words(rest, 2); if (confirm !== "confirm") fail("Use context-clear BOARD confirm.");
    return mutate(context, id, (_, r) => { r!.context = null; return saved(id, "Available context removed."); }, "remove");
  }
  if (verb === "complete" || verb === "reopen") {
    const [id, child] = words(rest, 2);
    return mutate(context, id, (_, r) => { const action = r!.actions.find(a => a.id === child); if (!action) fail("Action ID not found in this board."); action.status = verb === "complete" ? "completed" : "pending"; return saved(id, `Action ${child}: ${verb === "complete" ? "user-reported completed" : "pending"}.`); }, "lifecycle");
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
