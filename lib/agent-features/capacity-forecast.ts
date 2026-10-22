import { randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, addCivilDays } from "./feature-kit/civil-time.js";
import metadata from "./capacity-forecast.metadata.js";

const MAX_RECORDS = 8;
type Package = { id: string; label: string; low: number; high: number; earliest: number; latest: number };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; start: string; weeks: number; capacity: (number | null)[]; packages: Package[] };
type State = { version: 1; records: RecordData[] };
function monday(value: string): string {
  const result = checked(() => civilDate(value));
  if (civilDaysBetween("1970-01-05", result) % 7 !== 0) fail("Start must be a Monday in YYYY-MM-DD form.");
  return result;
}
function validateRecord(value: unknown): asserts value is RecordData {
  object(value, ["id", "title", "revision", "createdAt", "updatedAt", "start", "weeks", "capacity", "packages"]);
  validBase(value); validNumber(value.weeks, 2, 8);
  const start = civilDate(value.start); if (civilDaysBetween("1970-01-05", start) % 7 !== 0) throw new Error("Invalid Monday.");
  addCivilDays(start, Number(value.weeks) * 7 - 1);
  if (!Array.isArray(value.capacity) || value.capacity.length !== value.weeks) throw new Error("Invalid capacities.");
  for (const capacity of value.capacity) if (capacity !== null) validNumber(capacity, 0, 10080);
  if (!Array.isArray(value.packages) || value.packages.length > 24) throw new Error("Invalid packages.");
  for (const item of value.packages) {
    object(item, ["id", "label", "low", "high", "earliest", "latest"]); validId(item.id); validText(item.label, 400);
    validNumber(item.low, 0, 80640); validNumber(item.high, 1, 80640); validNumber(item.earliest, 1, Number(value.weeks)); validNumber(item.latest, Number(item.earliest), Number(value.weeks));
    if (Number(item.low) > Number(item.high)) throw new Error("Invalid effort range.");
  }
  unique(value.packages.map(p => p.id));
}
function projectLifecycle(state: State): State {
  // Reports and what-if are unsaved; only bounded revision digits can expand without new content.
  return { ...state, records: state.records.map(r => ({ ...r, revision: MAX_REVISION })) };
}
type Scenario = { load: number[]; overflow: number[]; unknown: number[]; packages: { id: string; allocations: number[]; remaining: number; unassessed: boolean }[]; total: number };
function scenario(record: RecordData, field: "low" | "high"): Scenario {
  const load = Array<number>(record.weeks).fill(0), overflow = [...load], unknown = [...load];
  const packages: Scenario["packages"] = [];
  const ordered = record.packages.map((p, index) => ({ p, index })).sort((a, b) => a.p.earliest - b.p.earliest || a.index - b.index);
  for (const { p } of ordered) {
    let remaining = p[field]; const allocations = Array<number>(record.weeks).fill(0);
    const unassessed = record.capacity.slice(p.earliest - 1, p.latest).some(capacity => capacity === null);
    for (let w = p.earliest - 1; w < p.latest; w++) {
      const capacity = record.capacity[w]; if (capacity === null) continue;
      const allocated = Math.min(remaining, capacity - load[w]); load[w] += allocated; allocations[w] = allocated; remaining -= allocated;
    }
    if (remaining) (unassessed ? unknown : overflow)[p.latest - 1] += remaining;
    packages.push({ id: p.id, allocations, remaining, unassessed });
  }
  return { load, overflow, unknown, packages, total: record.packages.reduce((sum, p) => sum + p[field], 0) };
}
function forecastLines(record: RecordData): string[] {
  const low = scenario(record, "low"), high = scenario(record, "high"), sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const unknownWeeks = record.capacity.flatMap((c, i) => c === null ? [i + 1] : []);
  const lines = [
    `Effort assumptions: low ${low.total}, high ${high.total} minutes; these are scenarios, not probabilities or guaranteed bounds on actual work.`,
    `Known-capacity allocations: low ${sum(low.load)}, high ${sum(high.load)} minutes.`,
    `Known-window overflow: low ${sum(low.overflow)}, high ${sum(high.overflow)} minutes.`,
    `Unassessed remainder with unknown eligible capacity: low ${sum(low.unknown)}, high ${sum(high.unknown)} minutes.`,
    unknownWeeks.length ? `Unknown capacity weeks: ${unknownWeeks.join(", ")}. Allocations use known buckets only and are provisional; unknown is neither zero nor free time.` : "Every week's capacity is explicitly supplied.",
    "Heuristic: independently allocate low/high effort, stable earliest eligible week then entered package order, using earliest known free minutes. Work is divisible across weeks; no people, dependencies, or within-week schedule modeled. Not an optimal feasibility proof.",
  ];
  for (let w = 0; w < record.weeks; w++) lines.push(`Week ${w + 1} (${addCivilDays(record.start, w * 7)}–${addCivilDays(record.start, w * 7 + 6)}): capacity ${record.capacity[w] ?? "unknown"}; ${record.capacity[w] === null ? "load unassessed" : `load low/high ${low.load[w]}/${high.load[w]}`}; overflow due low/high ${low.overflow[w]}/${high.overflow[w]}; unassessed due ${low.unknown[w]}/${high.unknown[w]}.`);
  for (const p of record.packages) {
    const l = low.packages.find(x => x.id === p.id)!, h = high.packages.find(x => x.id === p.id)!;
    lines.push(`${p.id} · ${p.label}`, `Allowed weeks ${p.earliest}–${p.latest}; effort ${p.low}–${p.high}. Low allocations [${l.allocations.join(", ")}]; high [${h.allocations.join(", ")}]. Unknown weeks in these vectors are unallocated, not zero capacity.`);
    lines.push(`Finish-window result: low ${l.remaining ? `${l.remaining} ${l.unassessed ? "unassessed" : "overflow"} minutes` : "fits known capacity"}; high ${h.remaining ? `${h.remaining} ${h.unassessed ? "unassessed" : "overflow"} minutes` : "fits known capacity"}.`);
  }
  return lines;
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [titleInput, startInput, weeksInput] = fields(rest, 162, 16, 16), title = text(titleInput, "Title", 160), start = monday(startInput), weeks = integer(weeksInput, 2, 8, "Weeks");
    checked(() => addCivilDays(start, weeks * 7 - 1));
    const record: RecordData = { ...base(context, "forecast", title), start, weeks, capacity: Array(weeks).fill(null), packages: [] };
    return mutate(context, undefined, state => { state.records.push(record); return saved(record.id, `${weeks} Monday-start weeks created. All capacities are unknown until entered.`, `forecast ${record.id}`); });
  }
  if (verb === "edit") {
    const [id, titleInput, startInput, weeksInput] = fields(rest, 80, 162, 16, 16), title = text(titleInput, "Title", 160), start = monday(startInput), weeks = integer(weeksInput, 2, 8, "Weeks");
    checked(() => addCivilDays(start, weeks * 7 - 1));
    return mutate(context, id, (_, r) => {
      if (r!.packages.some(p => p.latest > weeks)) fail("A package extends beyond the new horizon. Edit/remove that package first.");
      if (r!.capacity.slice(weeks).some(c => c !== null)) fail("Shortening would remove supplied capacity. Use capacity-clear FORECAST WEEK confirm on removed weeks first.");
      r!.title = title; r!.start = start; r!.capacity = Array.from({ length: weeks }, (_, i) => r!.capacity[i] ?? null); r!.weeks = weeks;
      return saved(id, "Title/start/horizon updated; retained week-number capacities and packages are unchanged.", `forecast ${id}`);
    });
  }
  if (verb === "capacity") {
    const [id, weekInput, minutesInput] = fields(rest, 80, 16, 16), week = integer(weekInput, 1, 8, "Week"), minutes = integer(minutesInput, 0, 10080);
    return mutate(context, id, (_, r) => { if (week > r!.weeks) fail("Week is outside this forecast."); r!.capacity[week - 1] = minutes; return saved(id, `Week ${week} capacity explicitly set to ${minutes} minutes.`, `forecast ${id}`); });
  }
  if (verb === "capacity-clear") {
    const [id, weekInput, confirm] = words(rest, 3), week = integer(weekInput, 1, 8, "Week"); if (confirm !== "confirm") fail("Use capacity-clear FORECAST WEEK confirm.");
    return mutate(context, id, (_, r) => { if (week > r!.weeks) fail("Week is outside this forecast."); r!.capacity[week - 1] = null; return saved(id, `Week ${week} capacity is unknown again.`, `forecast ${id}`); }, "remove");
  }
  if (verb === "package") {
    const match = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!match) fail("Use package FORECAST add LABEL | LOW | HIGH | EARLIEST-WEEK | LATEST-WEEK.");
    const [, id, mode, input] = match;
    if (mode === "remove") {
      const [child, confirm] = words(input, 2); if (confirm !== "confirm") fail("Use package FORECAST remove PACKAGE confirm.");
      return mutate(context, id, (_, r) => { if (!r!.packages.some(p => p.id === child)) fail("Package ID not found in this forecast."); r!.packages = r!.packages.filter(p => p.id !== child); return saved(id, "Package removed.", `forecast ${id}`); }, "remove");
    }
    const values = fields(input, ...(mode === "edit" ? [80] : []), 402, 16, 16, 16, 16), child = mode === "edit" ? values.shift()! : `package-${randomUUID()}`;
    const item: Package = { id: child, label: text(values[0], "Package", 400), low: integer(values[1], 0, 80640, "Low effort"), high: integer(values[2], 1, 80640, "High effort"), earliest: integer(values[3], 1, 8, "Earliest week"), latest: integer(values[4], 1, 8, "Latest week") };
    if (item.low > item.high) fail("Low effort must not exceed high effort."); if (item.earliest > item.latest) fail("Earliest week must not exceed latest week.");
    return mutate(context, id, (_, r) => {
      if (item.latest > r!.weeks) fail("Package window is outside this forecast.");
      if (mode === "add") { if (r!.packages.length >= 24) fail("Maximum 24 packages per forecast."); r!.packages.push(item); }
      else { const old = r!.packages.find(p => p.id === child); if (!old) fail("Package ID not found in this forecast."); Object.assign(old, item); }
      return saved(id, `Package ${child} · ${item.low}–${item.high} minutes in weeks ${item.earliest}–${item.latest}.`, `forecast ${id}`);
    });
  }
  if (verb === "forecast") {
    const [id, page] = words(rest, 1, 2), record = find(await read(context), id);
    return report([...forecastLines(record), `Next: ${ROUTE} show ${id}`], `forecast ${id}`, checked(() => parsePage(page)), `Private · unsaved forecast · ${id} · revision ${record.revision}`);
  }
  if (verb === "what-if") {
    const [head, weekInput, tail] = fields(rest, 100, 16, 32), [id, kind] = words(head, 2), [minutesInput, page] = words(tail, 1, 2);
    if (kind !== "capacity") fail("Use what-if FORECAST capacity | WEEK | MINUTES [page].");
    const week = integer(weekInput, 1, 8, "Week"), minutes = integer(minutesInput, 0, 10080), record = find(await read(context), id);
    if (week > record.weeks) fail("Week is outside this forecast.");
    const hypothetical = structuredClone(record); hypothetical.capacity[week - 1] = minutes;
    const baseLow = scenario(record, "low"), baseHigh = scenario(record, "high"), altLow = scenario(hypothetical, "low"), altHigh = scenario(hypothetical, "high");
    const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
    return report([`Overflow comparison low/high: ${total(baseLow.overflow)}/${total(baseHigh.overflow)} → ${total(altLow.overflow)}/${total(altHigh.overflow)} minutes.`, `Unassessed comparison low/high: ${total(baseLow.unknown)}/${total(baseHigh.unknown)} → ${total(altLow.unknown)}/${total(altHigh.unknown)} minutes.`, `Unsaved what-if: week ${week} capacity ${record.capacity[week - 1] ?? "unknown"} → ${minutes}. Saved capacities/packages unchanged.`, "Saved baseline:", ...forecastLines(record), "Hypothetical capacity:", ...forecastLines(hypothetical), `Next: ${ROUTE} forecast ${id}`],
      `what-if ${id} capacity | ${week} | ${minutes}`, checked(() => parsePage(page)), `Private · unsaved comparison · ${id} · revision ${record.revision}`);
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
