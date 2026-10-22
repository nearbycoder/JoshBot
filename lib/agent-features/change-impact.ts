import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./change-impact.metadata.js";
const MAX_RECORDS = 8, STATE_BYTES = 49_152, CONTENT_BYTES = 32_768;
const TYPES = ["assumption", "document", "routine", "commitment", "other"] as const;
type Item = { id: string; label: string; type: typeof TYPES[number]; ownerLabel: string };
type Edge = { id: string; dependent: string; prerequisite: string; reason: string };
type Disposition = { itemId: string; state: "reviewed" | "not-affected"; reason: string };
type Change = { id: string; sourceId: string; sourceSnapshot: Item; description: string; graphId: string; graphRevision: number; fingerprint: string; affected: string[]; dispositions: Disposition[]; status: "open" | "closed" };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; graphId: string; items: Item[]; edges: Edge[]; changes: Change[] };
type State = { version: 1; records: RecordData[] };
function validItem(i: unknown): asserts i is Item { object(i, ["id", "label", "type", "ownerLabel"]); validId(i.id, "item"); validText(i.label, 160, true); enumValue(i.type, TYPES); validText(i.ownerLabel, 96, true); }
function item(r: RecordData, id: string): Item { const i = r.items.find(x => x.id === id); if (!i) fail("Item not found in this map."); return i; }
function edge(r: RecordData, id: string): Edge { const e = r.edges.find(x => x.id === id); if (!e) fail("Edge not found in this map."); return e; }
function change(r: RecordData, id: string): Change { const c = r.changes.find(x => x.id === id); if (!c) fail("Change not found in this map."); return c; }
function fingerprint(r: RecordData): string { return createHash("sha256").update(JSON.stringify({ items: r.items, edges: r.edges })).digest("hex"); }
type Path = { nodes: string[]; edges: string[] };
function paths(r: RecordData, source: string): Map<string, Path> {
  item(r, source); const reverse = new Map(r.items.map(i => [i.id, [] as Edge[]]));
  for (const e of r.edges) reverse.get(e.prerequisite)!.push(e);
  for (const list of reverse.values()) list.sort((a, b) => a.dependent.localeCompare(b.dependent) || a.id.localeCompare(b.id));
  const seen = new Set([source]), queue = [source], result = new Map<string, Path>([[source, { nodes: [source], edges: [] }]]);
  for (let i = 0; i < queue.length; i++) for (const e of reverse.get(queue[i])!) {
    if (seen.has(e.dependent)) continue; seen.add(e.dependent); const previous = result.get(queue[i])!;
    result.set(e.dependent, { nodes: [e.dependent, ...previous.nodes], edges: [e.id, ...previous.edges] }); queue.push(e.dependent);
  }
  result.delete(source); return result; // the changed source is input, not its own downstream review item
}
function snapshot(r: RecordData, sourceId: string, description: string, id: string): Change { return { id, sourceId, sourceSnapshot: structuredClone(item(r, sourceId)), description, graphId: r.graphId, graphRevision: r.revision, fingerprint: fingerprint(r), affected: [...paths(r, sourceId).keys()], dispositions: [], status: "open" }; }
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "graphId", "items", "edges", "changes"]); validBase(v); validId(v.graphId, "graph"); array(v.items, 40); v.items.forEach(validItem); unique(v.items.map((i: Item) => i.id)); array(v.edges, 80);
  for (const e of v.edges) { object(e, ["id", "dependent", "prerequisite", "reason"]); validId(e.id, "edge"); validId(e.dependent, "item"); validId(e.prerequisite, "item"); validText(e.reason, 160); if (!v.items.some((i: Item) => i.id === e.dependent) || !v.items.some((i: Item) => i.id === e.prerequisite)) throw new Error("Dangling edge."); }
  unique(v.edges.map((e: Edge) => e.id)); unique(v.edges.map((e: Edge) => `${e.dependent}/${e.prerequisite}`)); array(v.changes, 5); unique(v.changes.map((c: Change) => c.id));
  for (const c of v.changes) {
    object(c, ["id", "sourceId", "sourceSnapshot", "description", "graphId", "graphRevision", "fingerprint", "affected", "dispositions", "status"]); validId(c.id, "change"); validId(c.sourceId, "item"); validId(c.graphId, "graph"); validNumber(c.graphRevision, 1, v.revision); validItem(c.sourceSnapshot); validText(c.description, 400); enumValue(c.status, ["open", "closed"]); array(c.affected, 39); c.affected.forEach((id: unknown) => validId(id, "item")); unique(c.affected); array(c.dispositions, 39);
    if (typeof c.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(c.fingerprint) || c.sourceSnapshot.id !== c.sourceId || c.affected.includes(c.sourceId) || !v.items.some((i: Item) => i.id === c.sourceId)) throw new Error("Invalid change provenance.");
    for (const d of c.dispositions) { object(d, ["itemId", "state", "reason"]); validId(d.itemId, "item"); enumValue(d.state, ["reviewed", "not-affected"]); validText(d.reason, 96); if (!c.affected.includes(d.itemId)) throw new Error("Disposition outside captured queue."); }
    unique(c.dispositions.map((d: Disposition) => d.itemId)); if (c.status === "closed" && c.dispositions.length !== c.affected.length) throw new Error("Closed queue has unresolved items.");
    if (c.graphId === v.graphId && (c.fingerprint !== fingerprint(v as RecordData) || JSON.stringify(c.affected) !== JSON.stringify([...paths(v as RecordData, c.sourceId).keys()]) || JSON.stringify(c.sourceSnapshot) !== JSON.stringify(item(v as RecordData, c.sourceId)))) throw new Error("Invalid current graph snapshot.");
  }
}
function projectLifecycle(s: State): State {
  return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION, changes: r.changes.map(c => {
    const projected = (affected: string[], sourceSnapshot: Item): Change => ({ ...c, graphRevision: MAX_REVISION, status: "closed", sourceSnapshot, affected, dispositions: affected.map(itemId => ({ itemId, state: "not-affected", reason: "\\".repeat(96) })) });
    // Both historical erasure/close and a current-graph refresh must fit. New
    // graph edits reserve the larger queue before they can make a change stale.
    const old = projected(c.affected, c.sourceSnapshot), current = projected([...paths(r, c.sourceId).keys()], item(r, c.sourceId));
    return serializedBytes(old) >= serializedBytes(current) ? old : current;
  }) })) };
}
async function graph(context: AgentFeatureContext, id: string, edit: (r: RecordData) => string, kind: "content" | "remove" = "content"): Promise<string> {
  const graphId = `graph-${randomUUID()}`; return mutate(context, id, (_, r) => { const reply = edit(r!); r!.graphId = graphId; return saved(id, reply + " Existing change reviews now refer to historical graphs; refresh explicitly before resolving/closing."); }, kind);
}
function current(r: RecordData, c: Change): void { if (c.graphId !== r.graphId || c.fingerprint !== fingerprint(r)) fail(`Graph changed. Inspect impact, then refresh ${r.id} ${c.id} confirm to discard old dispositions and review the current queue.`); }
function impact(r: RecordData, c: Change): string {
  const stale = c.graphId !== r.graphId, lines = [`${c.id} · ${c.description}`, `Changed source ${c.sourceId} (${c.sourceSnapshot.label}); source itself is excluded from downstream review, including cycles back to source.`, `Captured graph ${c.graphId} · revision ${c.graphRevision} · ${c.fingerprint}`, stale ? `STALE: historical status ${c.status} does not certify the current graph. Historical dispositions remain in show/export; original graph paths were not retained. Refresh explicitly to replace the queue and clear dispositions.` : `Current graph · ${c.status} · ${c.dispositions.length}/${c.affected.length} affected items have user-reported dispositions.`, "Directed edges mean dependent depends-on prerequisite. Reverse BFS finds shortest downstream paths; ties follow dependent ID then edge ID. Cycles are allowed; every node is visited once. No external document or routine was changed."];
  if (stale) { lines.push(`Next review: ${ROUTE} refresh ${r.id} ${c.id} confirm`); return lines.join("\n"); }
  for (const [id, path] of paths(r, c.sourceId)) {
    const d = c.dispositions.find(d => d.itemId === id), target = item(r, id);
    lines.push(`\n${id} · ${target.label} · ${target.type} · owner label ${target.ownerLabel || "unknown"}\n${d ? `${d.state}: ${d.reason}` : "UNRESOLVED: add reviewed/not-affected with a reason."}\nShortest path (${path.edges.length} edges): ${path.edges.map((e, i) => `${path.nodes[i]} -[${e}]-> `).join("")}${c.sourceId}\nReasons: ${ROUTE} path ${r.id} ${c.id} ${id}`);
  }
  if (!c.affected.length) lines.push("No downstream items in the entered graph; source-only changes have an empty review queue.");
  return lines.join("\n");
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") { const [title] = fields(rest, 160), r: RecordData = { ...base(context, "map", text(title, "Title", 160)), graphId: `graph-${randomUUID()}`, items: [], edges: [], changes: [] }; return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Local dependency map created."); }); }
  if (verb === "edit" || verb === "clear") { const f = verb === "edit" ? fields(rest, 80, 16, 160) : words(rest, 3); if (f[1] !== "title" || (verb === "clear" && f[2] !== "confirm")) fail("Use edit MAP | title | TEXT, or clear MAP title confirm."); const title = verb === "clear" ? "" : text(f[2], "Title", 160); return graph(context, f[0], r => { r.title = title; return "Map title updated."; }, verb === "clear" ? "remove" : "content"); }
  if (verb === "item") {
    const m = /^(\S+)\s+(add|edit|clear|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use item MAP add LABEL | TYPE | OWNER; see help for edit/remove."); const [, id, mode, input] = m;
    if (mode === "add") { const [label, type, ownerLabel] = fields(input, 160, 16, 96), i: Item = { id: `item-${randomUUID()}`, label: text(label, "Label", 160), type: enumValue(type, TYPES), ownerLabel: text(ownerLabel, "Owner label", 96) }; return graph(context, id, r => { if (r.items.length === 40) fail("Maximum 40 items."); r.items.push(i); return `Item ${i.id} saved.`; }); }
    if (mode === "remove") { const [iid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Item removal requires confirm; incident edges and changes sourced at this item are removed too."); return graph(context, id, r => { item(r, iid); r.items = r.items.filter(i => i.id !== iid); r.edges = r.edges.filter(e => e.dependent !== iid && e.prerequisite !== iid); const n = r.changes.length; r.changes = r.changes.filter(c => c.sourceId !== iid); return `Item, incident edges and ${n - r.changes.length} source change(s) removed. Other historical dispositions retain their IDs until refresh/remove.`; }, "remove"); }
    const f = mode === "edit" ? fields(input, 80, 16, 160) : words(input, 3), key = enumValue(f[1], ["label", "type", "ownerLabel"] as const);
    if (mode === "clear" && (key === "type" || f[2] !== "confirm")) fail("Clear label/ownerLabel with confirm; remove the item to erase its required type."); const value = mode === "clear" ? "" : key === "type" ? enumValue(f[2], TYPES) : text(f[2], key, key === "label" ? 160 : 96);
    return graph(context, id, r => { const i = item(r, f[0]); if (key === "type") i.type = value as Item["type"]; else i[key] = value; return "Item field updated."; }, mode === "clear" ? "remove" : "content");
  }
  if (verb === "depends" || verb === "edge-edit") { const [head, other, reason, extra] = verb === "depends" ? fields(rest, 170, 80, 160) : fields(rest, 170, 80, 80, 160), [id, local] = words(head, 2), eid = verb === "depends" ? `edge-${randomUUID()}` : local, dependent = verb === "depends" ? local : other, prerequisite = verb === "depends" ? other : reason, explanation = text(verb === "depends" ? reason : extra, "Dependency reason", 160); return graph(context, id, r => { item(r, dependent); item(r, prerequisite); if (r.edges.some(e => e.id !== eid && e.dependent === dependent && e.prerequisite === prerequisite)) fail("That directed dependency already exists; edit its reason by edge ID."); const next: Edge = { id: eid, dependent, prerequisite, reason: explanation }; if (verb === "depends") { if (r.edges.length === 80) fail("Maximum 80 edges."); r.edges.push(next); } else Object.assign(edge(r, eid), next); return `Dependency ${eid} saved; cycles are permitted.`; }); }
  if (verb === "edge-remove") { const [id, eid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use edge-remove MAP EDGE confirm."); return graph(context, id, r => { edge(r, eid); r.edges = r.edges.filter(e => e.id !== eid); return "Dependency and its reason removed."; }, "remove"); }
  if (verb === "change" || verb === "change-edit") {
    const f = verb === "change" ? fields(rest, 170, 400) : fields(rest, 180, 80, 400), head = words(f[0], verb === "change" ? 2 : 3), id = head[0], cid = verb === "change" ? `change-${randomUUID()}` : head[1], source = verb === "change" ? head[1] : f[1], description = text(verb === "change" ? f[1] : f[2], "Change description", 400);
    if (verb === "change-edit" && head[2] !== "confirm") fail("Use change-edit MAP CHANGE confirm | SOURCE_ITEM | DESCRIPTION; this replaces the queue and erases old dispositions.");
    return mutate(context, id, (_, r) => { const c = snapshot(r!, source, description, cid); if (verb === "change") { if (r!.changes.length === 5) fail("Maximum 5 changes."); r!.changes.push(c); } else Object.assign(change(r!, cid), c); return saved(id, `Change ${cid}: ${c.affected.length} downstream items need explicit review; no external changes occurred.`, `impact ${id} ${cid}`); });
  }
  if (verb === "refresh") { const [id, cid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use refresh MAP CHANGE confirm to replace the graph snapshot/queue and erase previous dispositions."); return mutate(context, id, (_, r) => { const c = change(r!, cid); Object.assign(c, snapshot(r!, c.sourceId, c.description, cid)); return saved(id, "Current graph captured; old dispositions erased and change reopened explicitly.", `impact ${id} ${cid}`); }, "lifecycle"); }
  if (verb === "change-remove") { const [id, cid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use change-remove MAP CHANGE confirm."); return mutate(context, id, (_, r) => { change(r!, cid); r!.changes = r!.changes.filter(c => c.id !== cid); return saved(id, "Change, source snapshot, queue and dispositions removed."); }, "remove"); }
  if (verb === "resolve") { const [head, state, reason] = fields(rest, 250, 16, 96), [id, cid, iid] = words(head, 3), status = enumValue(state, ["reviewed", "not-affected"] as const), explanation = text(reason, "Review reason", 96); return mutate(context, id, (_, r) => { const c = change(r!, cid); current(r!, c); if (c.status !== "open") fail("Reopen the change before editing a disposition."); if (!c.affected.includes(iid)) fail("Item is not in the affected queue; the changed source is excluded."); const next = { itemId: iid, state: status, reason: explanation }, d = c.dispositions.find(d => d.itemId === iid); if (d) Object.assign(d, next); else c.dispositions.push(next); return saved(id, "User-reported disposition recorded; no external document was edited.", `impact ${id} ${cid}`); }, "lifecycle"); }
  if (verb === "resolve-remove") { const [id, cid, iid, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Use resolve-remove MAP CHANGE ITEM confirm."); return mutate(context, id, (_, r) => { const c = change(r!, cid); if (!c.dispositions.some(d => d.itemId === iid)) fail("Disposition not found."); c.dispositions = c.dispositions.filter(d => d.itemId !== iid); c.status = "open"; return saved(id, "Disposition erased; change reopened. Historical graphs still require refresh.", `impact ${id} ${cid}`); }, "remove"); }
  if (verb === "close" || verb === "reopen") { const [id, cid] = words(rest, 2); return mutate(context, id, (_, r) => { const c = change(r!, cid); current(r!, c); if (verb === "close" && c.dispositions.length !== c.affected.length) fail("Every affected item needs reviewed/not-affected and a reason before close."); c.status = verb === "close" ? "closed" : "open"; return saved(id, `Local change ${c.status}; dispositions remain user-reported, not evidence of external updates.`, `impact ${id} ${cid}`); }, "lifecycle"); }
  if (verb === "impact" || verb === "path") { const args = words(rest, verb === "path" ? 3 : 2, verb === "path" ? 6 : 5), [id, cid] = args, r = find(await read(context), id), c = change(r, cid); if (verb === "impact") return report(impact(r, c), `impact ${id} ${cid}`, r, args.slice(2)); current(r, c); const p = paths(r, c.sourceId).get(args[2]); if (!p) fail("No downstream path for this item in the current queue."); const lines = [`Shortest saved path from ${args[2]} to changed source ${c.sourceId}:`]; for (const [i, eid] of p.edges.entries()) { const e = edge(r, eid); lines.push(`${p.nodes[i]} depends-on ${p.nodes[i + 1]} via ${eid}: ${e.reason}`); } return report(lines.join("\n"), `path ${id} ${cid} ${args[2]}`, r, args.slice(3)); }
  fail("Unknown command. Use help for exact grammar.");
}

const ROOT_PREFIX = "map";
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
