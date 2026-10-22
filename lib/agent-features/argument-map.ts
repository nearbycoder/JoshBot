import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./argument-map.metadata.js";
import { boundedText, pipeFields, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
const route = "/nobo-help agent argument-map";
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/));
const rev = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const text = (bytes: number, empty = false) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, trim: false, allowEmpty: empty }); return empty || !!s.trim(); } catch { return false; } }));
const kind = v.picklist(["claim", "reason", "objection", "rebuttal", "evidence"]), relation = v.picklist(["supports", "challenges", "rebuts", "evidences"]);
const node = v.strictObject({ id, kind, text: text(600), label: text(200, true) });
const edge = v.strictObject({ id, from: id, relation, to: id });
const map = v.strictObject({ id, rootId: id, revision: rev, nodes: v.pipe(v.array(node), v.minLength(1), v.maxLength(32)), edges: v.pipe(v.array(edge), v.maxLength(64)) });
type MapRecord = v.InferOutput<typeof map>;
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(map), v.maxLength(10)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
function typed(m: MapRecord, e: MapRecord["edges"][number]) {
  const from = m.nodes.find(n => n.id === e.from), to = m.nodes.find(n => n.id === e.to);
  if (!from || !to || from.id === to.id) return false;
  if (e.relation === "supports") return ["claim", "reason", "rebuttal"].includes(from.kind) && ["claim", "reason", "rebuttal"].includes(to.kind);
  if (e.relation === "challenges") return from.kind === "objection" && to.kind !== "objection";
  if (e.relation === "rebuts") return from.kind === "rebuttal" && to.kind === "objection";
  return from.kind === "evidence" && to.kind !== "evidence";
}
function cyclic(m: MapRecord) {
  const degree = new Map(m.nodes.map(n => [n.id, 0])), outgoing = new Map(m.nodes.map(n => [n.id, [] as string[]]));
  for (const e of m.edges) { degree.set(e.to, degree.get(e.to)! + 1); outgoing.get(e.from)!.push(e.to); }
  const queue = m.nodes.filter(n => degree.get(n.id) === 0).map(n => n.id); let seen = 0;
  for (let i = 0; i < queue.length; i++) { seen++; for (const to of outgoing.get(queue[i])!) { degree.set(to, degree.get(to)! - 1); if (degree.get(to) === 0) queue.push(to); } }
  return seen !== m.nodes.length;
}
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw); if (!p.success) throw new Error("Invalid saved argument data; preserved. Ask a maintainer to repair this scoped state; help remains available.");
  const ids: string[] = [];
  for (const m of p.output.records) {
    ids.push(m.id, ...m.nodes.map(n => n.id), ...m.edges.map(e => e.id));
    if (!m.nodes.some(n => n.id === m.rootId && n.kind === "claim") || m.nodes.some(n => n.kind !== "evidence" && n.label !== "") || m.edges.some(e => !typed(m, e)) || new Set(m.edges.map(e => `${e.from}/${e.relation}/${e.to}`)).size !== m.edges.length) throw new Error("Invalid typed edge, root, label or duplicate link; nothing changed. Use help for edge rules.");
    if (cyclic(m)) throw new Error("Cycle rejected: a directed loop is circular dependence, not independent support or proof of falsehood. Remove/reorient a link; nothing changed.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved IDs; data preserved."); return p.output;
}
const envelope = (m: MapRecord) => ({ feature: metadata.id, version: 1, record: m });
function admit(s: State) {
  const future = { ...s, records: s.records.map(m => ({ ...m, revision: Number.MAX_SAFE_INTEGER })) };
  assertQuota(s, { kind: "content", records: s.records.map(envelope), limits: { maxRecords: 10 }, future: { value: future, records: future.records.map(envelope) } });
  for (const m of future.records) { render(m, "show", JSON.stringify(envelope(m), null, 2), 1); render(m, "view", view(m), 1); render(m, "audit", audit(m), 1); }
}
const fields = (s: string, sizes: number[]) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((x, i) => boundedText(x, { label: "Field", maxBytes: sizes[i] }));
const get = (s: State, key: string) => { const m = s.records.find(x => x.id === key); if (!m) throw new Error(`Map not found. Use ${route} list`); return m; };
const getNode = (m: MapRecord, key: string) => { const n = m.nodes.find(x => x.id === key); if (!n) throw new Error("Node not found; use show for full IDs."); return n; };
function render(m: MapRecord, verb: string, body: string, p: number, expected?: string) {
  if (expected) assertRevision(m.revision, Number(expected));
  return pageAt(paginateParts(body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g).map((text, i) => ({ text, atomic: i % 2 === 1 })), { mode: "plain", title: `Map ${m.id} · revision ${m.revision}`, command: p => `${route} ${verb} ${m.id} page ${p} rev ${m.revision}` }), p).text;
}
function view(m: MapRecord) {
  const incoming = new Map(m.nodes.map(n => [n.id, m.edges.filter(e => e.to === n.id)])), seen = new Set<string>(), out = ["Adjacency breadth-first from the position; arrows point from reasons/evidence/objections toward their targets. Shared references keep their IDs; each node expands once.\n"];
  for (const seed of [m.rootId, ...m.nodes.filter(n => n.id !== m.rootId).map(n => n.id)]) {
    if (seen.has(seed)) continue;
    if (seed !== m.rootId) out.push("Disconnected from position (following incoming edges):\n");
    const queue = [{ id: seed, depth: 0 }]; seen.add(seed);
    for (let i = 0; i < queue.length; i++) {
      const { id, depth } = queue[i], n = getNode(m, id), indent = "  ".repeat(depth);
      out.push(`${indent}${n.id} [${n.kind}] ${n.text}${n.label ? `; supplied evidence label: ${n.label}` : ""}\n`);
      for (const e of incoming.get(id)!) { const shared = seen.has(e.from); out.push(`${indent}  Edge ${e.id}: ${e.from} --${e.relation}--> ${e.to}${shared ? " (shared reference; expanded once)" : ""}\n`); if (!shared) { seen.add(e.from); queue.push({ id: e.from, depth: depth + 1 }); } }
    }
  }
  return out.join("");
}
function audit(m: MapRecord) {
  const out = ["Cycles: none in this validated map. Cyclic links are rejected; a cycle means circular dependence, not proof that a position is false. Evidence labels do not establish truth.\n"];
  for (const n of m.nodes) {
    if (["claim", "reason", "rebuttal"].includes(n.kind) && !m.edges.some(e => e.to === n.id && ["supports", "evidences"].includes(e.relation))) out.push(`UNSUPPORTED LEAF ${n.id} [${n.kind}]: ${n.text}\n`);
    if (n.kind === "objection" && !m.edges.some(e => e.to === n.id && e.relation === "rebuts")) out.push(`UNANSWERED OBJECTION ${n.id}: ${n.text}\n`);
    if (n.kind === "evidence" && !n.label) out.push(`UNLABELED EVIDENCE ${n.id}: supplied content has no evidence label.\n`);
  }
  out.push(`Inspect all branches: ${route} view ${m.id}\n`); return out.join("");
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID(), rootId = randomUUID();
  const usage = (state: State) => `${state.records.length}/10 maps; ${serializedBytes(state)}/49152 UTF-8 bytes (32768 content admission). Export/delete to free space: ${route} list`;
  const save = (change: (state: State) => { record: MapRecord; detail?: string } | null, remove = false) => ctx.store.update("state", initial, raw => { const state = validate(raw), result = change(state); validate(state); if (!remove) admit(state); return { value: state, result: `${result ? `Saved privately: ${result.record.id} · revision ${result.record.revision}\n${result.detail ?? ""}\nNext: ${route} audit ${result.record.id}` : "Deleted privately."}\n${usage(state)}` }; });
  const edit = (key: string, change: (m: MapRecord) => string | void, remove = false) => { const expected = get(s, key).revision; return save(state => { const m = get(state, key); assertRevision(m.revision, expected); const detail = change(m); m.revision++; return { record: m, detail: detail || undefined }; }, remove); };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { if (parsePage(m[1]) !== 1) throw new Error("Page out of range; use list."); return `${usage(s)}\n${s.records.map(m => `${m.id} · position preview: ${Array.from(getNode(m, m.rootId).text).slice(0, 80).join("")} · ${m.nodes.length} nodes/${m.edges.length} edges · revision ${m.revision}`).join("\n") || `No maps. Start: ${metadata.example}`}`; }
  if ((m = command.match(/^(show|view|audit) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const r = get(s, m[2]); return render(r, m[1], m[1] === "show" ? JSON.stringify(envelope(r), null, 2) : m[1] === "view" ? view(r) : audit(r), parsePage(m[3]), m[4]); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Legacy record exceeds export limit; use show pages then delete."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const r = get(s, m[1]); if (!m[2]) return `Delete map and all nodes/edges: ${route} delete ${r.id} confirm`; return save(state => { assertRevision(get(state, r.id).revision, r.revision); state.records = state.records.filter(x => x.id !== r.id); return null; }, true); }
  if (command.startsWith("create ")) { const [position] = fields(command.slice(7), [600]); return save(state => { const r: MapRecord = { id: newId, revision: 1, rootId, nodes: [{ id: rootId, kind: "claim", text: position, label: "" }], edges: [] }; state.records.push(r); return { record: r, detail: `Root: ${rootId}` }; }); }
  if ((m = command.match(/^node (\S+) (add|edit) ([\s\S]+)$/))) { const [, key, action, input] = m, f = fields(input, action === "add" ? [10, 600] : [36, 10, 600]); const nodeId = action === "edit" ? f.shift()! : newId, nodeKind = v.parse(kind, f[0]), value = f[1]; return edit(key, r => { if (action === "add") r.nodes.push({ id: nodeId, kind: nodeKind, text: value, label: "" }); else { const n = getNode(r, nodeId); if (n.kind === "evidence" && nodeKind !== "evidence" && n.label) throw new Error("Remove the evidence label explicitly before changing its type."); Object.assign(n, { kind: nodeKind, text: value }); } return `Node: ${nodeId}`; }); }
  if ((m = command.match(/^position (\S+)\s*\|([\s\S]+)$/))) { const [, key, input] = m, [value] = fields(input, [600]); return edit(key, r => { getNode(r, r.rootId).text = value; }); }
  if ((m = command.match(/^label (\S+) ([\s\S]+)$/))) { const [, key, input] = m, [nid, value] = fields(input, [36, 200]); return edit(key, r => { const n = getNode(r, nid); if (n.kind !== "evidence") throw new Error("Only evidence nodes accept evidence labels."); n.label = value; }); }
  if ((m = command.match(/^(link|link-edit) (\S+) ([\s\S]+)$/))) { const [, action, key, input] = m, f = fields(input, action === "link" ? [36, 10, 36] : [36, 36, 10, 36]), eid = action === "link-edit" ? f.shift()! : newId, rel = v.parse(relation, f[1]); return edit(key, r => { const next = { id: eid, from: f[0], relation: rel, to: f[2] }; if (action === "link") r.edges.push(next); else { const e = r.edges.find(x => x.id === eid); if (!e) throw new Error("Edge not found; use show."); Object.assign(e, next); } return `Edge: ${eid}`; }); }
  if ((m = command.match(/^remove (\S+) (node|edge|label) (\S+) confirm$/))) { const [, key, kind, cid] = m; return edit(key, r => { if (kind === "edge") { if (!r.edges.some(e => e.id === cid)) throw new Error("Edge not found."); r.edges = r.edges.filter(e => e.id !== cid); return `Removed edge: ${cid}`; } const n = getNode(r, cid); if (kind === "label") { if (n.kind !== "evidence") throw new Error("Only evidence nodes have labels."); n.label = ""; return; } if (cid === r.rootId) throw new Error("The root position cannot be removed alone. Use delete MAP confirm for the whole map."); const removed = r.edges.filter(e => e.from === cid || e.to === cid); r.nodes = r.nodes.filter(n => n.id !== cid); r.edges = r.edges.filter(e => e.from !== cid && e.to !== cid); return `Removed node ${cid} and ${removed.length} attached edges. Other nodes preserved; inspect show/view.`; }, true); }
  throw new Error(`Unknown or incomplete command. Use ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
