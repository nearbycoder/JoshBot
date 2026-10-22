import { createHash, randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext, AgentContextItem, AgentContextKind } from "./types.js";
import metadata from "./concept-links.metadata.js";
import { boundedText as kitBoundedText, pipeFields as kitPipeFields, parsePage as kitParsePage, paginateParts as kitPaginateParts, pageAt as kitPageAt } from "./feature-kit/command-and-display.js";
import { assertQuota as kitAssertQuota, assertRevision as kitAssertRevision, assertStateVersion as kitAssertStateVersion, serializedBytes as kitSerializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant as kitNormalizeInstant } from "./feature-kit/civil-time.js";
import { captureEvidence as kitCaptureEvidence, type EvidenceSnapshot } from "./feature-kit/evidence.js";
import { contextCapacityMessage } from "./budgets.js";

class CommandError extends Error {}
// Only pure local validation is trusted as guidance. Never wrap backend/service I/O.
function checked<T>(work: () => T): T {
  try { return work(); }
  catch (error) { throw new CommandError(error instanceof Error ? error.message : "Invalid input."); }
}
const boundedText: typeof kitBoundedText = (...args) => checked(() => kitBoundedText(...args));
const pipeFields: typeof kitPipeFields = (...args) => checked(() => kitPipeFields(...args));
const parsePage: typeof kitParsePage = (...args) => checked(() => kitParsePage(...args));
const paginateParts: typeof kitPaginateParts = (...args) => checked(() => kitPaginateParts(...args));
const pageAt: typeof kitPageAt = (...args) => checked(() => kitPageAt(...args));
const assertQuota: typeof kitAssertQuota = (...args) => checked(() => kitAssertQuota(...args));
const assertRevision: typeof kitAssertRevision = (...args) => checked(() => kitAssertRevision(...args));
const assertStateVersion: typeof kitAssertStateVersion = (...args) => checked(() => kitAssertStateVersion(...args));
const serializedBytes: typeof kitSerializedBytes = (...args) => checked(() => kitSerializedBytes(...args));
const normalizeInstant: typeof kitNormalizeInstant = (...args) => checked(() => kitNormalizeInstant(...args));
const captureEvidence: typeof kitCaptureEvidence = (...args) => checked(() => kitCaptureEvidence(...args));

const route = "/nobo-help agent concept-links", MAX_REV = 999_999_999;
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const text = (bytes: number, empty = false) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, trim: false, allowEmpty: empty }); return empty || !!s.trim(); } catch { return false; } }));
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_REV));
const relation = v.picklist(["supports", "contrasts", "example", "depends-on"]);
const node = v.strictObject({ id, title: text(160), annotation: text(600) });
const edge = v.strictObject({ id, from: id, type: relation, to: id, label: text(400) });
const fingerprint = v.pipe(v.string(), v.regex(/^e1:[a-f0-9]{64}$/));
const attachment = v.strictObject({ id, nodeId: id, sourceFingerprint: fingerprint, capturedAt: v.string(), evidence: v.strictObject({ version: v.literal(1), sources: v.pipe(v.array(v.unknown()), v.length(1)), fingerprint }) });
const record = v.strictObject({ id, title: text(160), revision, nodes: v.pipe(v.array(node), v.maxLength(40)), edges: v.pipe(v.array(edge), v.maxLength(80)), attachments: v.pipe(v.array(attachment), v.maxLength(10)) });
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(record), v.maxLength(8)) });
type ConceptMap = v.InferOutput<typeof record>;
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
const keys = ["source", "createdAt", "featureId", "cardId", "revision", "subject", "key", "confirmedAt", "expiresOn", "expiryTimezone", "confidence", "origin"];
function evidence(items: readonly unknown[], kinds: readonly AgentContextKind[]) {
  const snapshot = captureEvidence(items, { kinds, maxItems: 1, maxBytes: 65536, metadataKeys: keys });
  for (const source of snapshot.sources) {
    if (source.kind === "note") {
      if (!/^toolbox:notes:[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(source.id) || source.metadata?.source !== "Personal toolbox / notes") throw new CommandError("Note provenance is not the supported owned toolbox adapter.");
    } else if (source.kind === "memory") {
      if (!/^memory-review:mr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(source.id) || source.metadata?.featureId !== "memory-review" || source.id !== `memory-review:${source.metadata.cardId}`) throw new CommandError("Memory provenance is not the supported approved-card adapter.");
    } else throw new CommandError("Only owned notes and approved memory are supported.");
  }
  return snapshot;
}
const envelope = (r: ConceptMap) => ({ feature: metadata.id, version: 1, record: r });
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); serializedBytes(raw);
  const p = v.safeParse(schema, raw); if (!p.success) throw new CommandError("Invalid saved concept fields; data preserved. Ask the operator for scoped recovery.");
  const ids: string[] = [];
  for (const r of p.output.records) {
    ids.push(r.id, ...r.nodes.map(n => n.id), ...r.edges.map(e => e.id), ...r.attachments.map(a => a.id));
    const nodes = new Set(r.nodes.map(n => n.id));
    if (r.edges.some(e => !nodes.has(e.from) || !nodes.has(e.to)) || new Set(r.edges.map(e => `${e.from}/${e.type}/${e.to}`)).size !== r.edges.length) throw new CommandError("Invalid or duplicate graph edge; use existing node IDs.");
    let bytes = 0;
    for (const a of r.attachments) {
      if (!nodes.has(a.nodeId) || normalizeInstant(a.capturedAt) !== a.capturedAt) throw new CommandError("Invalid saved attachment reference/time; data preserved.");
      const src = a.evidence.sources[0] as AgentContextItem;
      if (!src || (src.kind !== "note" && src.kind !== "memory")) throw new CommandError("Invalid source kind; data preserved.");
      const rebuilt = evidence(a.evidence.sources, [src.kind]);
      if (rebuilt.fingerprint !== a.evidence.fingerprint || JSON.stringify(rebuilt.sources) !== JSON.stringify(a.evidence.sources)) throw new CommandError("Invalid saved evidence/metadata; data preserved.");
      boundedText(src.text, { label: "Selected excerpt", maxUnits: 600, maxBytes: 2400, trim: false }); bytes += Buffer.byteLength(src.text);
    }
    if (bytes > 12000 || new Set(r.attachments.map(a => `${a.nodeId}/${(a.evidence.sources[0] as AgentContextItem).id}`)).size !== r.attachments.length) throw new CommandError("Selected source quota or duplicate attachment; maximum 10 excerpts/12000 text bytes.");
  }
  if (new Set(ids).size !== ids.length) throw new CommandError("Duplicate saved IDs; data preserved.");
  return p.output;
}
const fields = (s: string, sizes: number[]) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i] }));
const get = (s: State, key: string) => { const r = s.records.find(r => r.id === key); if (!r) throw new CommandError(`Item not found in your private records. Use ${route} list`); return r; };
const getNode = (r: ConceptMap, key: string) => { const n = r.nodes.find(n => n.id === key); if (!n) throw new CommandError("Node not found; inspect show for full IDs."); return n; };
function render(r: ConceptMap, command: string, body: string, page: number, expected?: string, suffix = "") {
  if ((page > 1 && !expected) || (expected !== undefined && String(r.revision) !== expected)) throw new CommandError(`Map changed or revision missing. Restart: ${route} ${command} page 1`);
  const parts = body.split(/(https?:\/\/[^\s"\\]+|"(?:id|cardId)"\s*:\s*"(?:\\.|[^"\\])*"|(?:toolbox:notes:|memory-review:)[A-Za-z0-9:._/-]+|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[es]1:[a-f0-9]{64})/g).map((text, i) => ({ text, atomic: i % 2 === 1 }));
  return pageAt(paginateParts(parts, { mode: "plain", title: `Concept map ${r.id} · revision ${r.revision}`, command: p => `${route} ${command} page ${p} rev ${r.revision}${suffix}` }), page).text;
}
function quota(s: State, content: boolean) {
  // No mandatory growing status/history; optional annotations/snapshots are content.
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REV })) }, limits = { maxRecords: 8 };
  assertQuota(s, content ? { kind: "content", records: s.records.map(envelope), limits, future: { value: future, records: future.records.map(envelope) } } : { kind: "lifecycle", records: s.records.map(envelope), limits });
  assertQuota(future, { kind: "lifecycle", records: future.records.map(envelope), limits });
  for (const r of s.records) render(r, `show ${r.id}`, JSON.stringify(envelope(r), null, 2), 1);
}
function path(r: ConceptMap, from: string, to: string) {
  getNode(r, from); getNode(r, to);
  const reached = new Set([from]), queue = [from], previous = new Map<string, ConceptMap["edges"][number]>();
  // Directed BFS, insertion-order ties, one expansion per node. Cycles/self-links are safe.
  for (let i = 0; i < queue.length && !reached.has(to); i++) for (const e of r.edges.filter(e => e.from === queue[i])) if (!reached.has(e.to)) { reached.add(e.to); queue.push(e.to); previous.set(e.to, e); }
  if (!reached.has(to)) return `No directed path from ${from} to ${to}. Connections are directed user labels; reverse relationships are not invented.`;
  const steps: ConceptMap["edges"] = [];
  for (let current = to; current !== from;) { const e = previous.get(current)!; steps.push(e); current = e.from; }
  return `Shortest directed path: ${steps.length} hop(s). Stable insertion-order ties. User-entered relations do not establish causation or truth.\n` + [getNode(r, from).title, ...steps.reverse().map(e => `Edge ${e.id}: ${e.from} --${e.type}--> ${e.to}\n${getNode(r, e.to).title}\nUser evidence/annotation: ${e.label}`), "Attached sources remain historical snapshots; use sources to check current provenance."].join("\n");
}
async function readSources(ctx: AgentFeatureContext, kinds: AgentContextKind[]) {
  let items: AgentContextItem[];
  try { items = await ctx.services.readContext(kinds); }
  catch (error) { ctx.signal?.throwIfAborted(); throw new CommandError(contextCapacityMessage(error, "Narrow sources with --kind note or --kind memory; reduce an oversized source in its owning tool.") ?? "Owned note/memory sources could not be read completely; saved snapshots remain unchanged. Check the owning source and retry sources."); }
  if (items.length > 200) throw new CommandError("Source capacity exceeded: maximum 200 adapter items; no clipping. Narrow --kind or reduce the owning collection.");
  const seen = new Set<string>();
  const rows = items.map(item => {
    if (!kinds.includes(item.kind) || seen.has(item.id)) throw new CommandError("Invalid or duplicate source scope; selection refused."); seen.add(item.id);
    const snapshot = evidence([item], [item.kind]); return { source: snapshot.sources[0], fingerprint: snapshot.fingerprint };
  }).sort((a, b) => a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0);
  const fingerprint = `s1:${createHash("sha256").update(JSON.stringify(rows.map(r => [r.source.id, r.fingerprint]))).digest("hex")}`;
  return { rows, fingerprint };
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 });
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID(), now = normalizeInstant(ctx.now.toISOString());
  // Whole-root erasure is a separate operation, never an admission flag. Each
  // root has independent lifecycle reservations, so retaining an exact subset
  // strictly reduces actual bytes and cannot increase any projected quota.
  const deleteRoot = (key: string) => {
    const expected = JSON.stringify(get(s, key));
    return ctx.store.update("state", initial, raw => {
      const state = validate(raw), target = get(state, key);
      if (JSON.stringify(target) !== expected) throw new CommandError("Record changed; inspect before deleting again.");
      const beforeBytes = serializedBytes(state);
      state.records = state.records.filter(r => r.id !== key);
      validate(state);
      if (serializedBytes(state) >= beforeBytes) throw new CommandError("Removal did not reduce saved data; nothing changed.");
      return { value: state, result: `Deleted privately: ${key}\nNext: ${route} list` };
    });
  };
  const save = (key: string | undefined, change: (s: State, r?: ConceptMap) => string, content = true) => {
    const expected = key === undefined ? undefined : get(s, key).revision;
    return ctx.store.update("state", initial, raw => {
      const state = validate(raw), r = key === undefined ? undefined : get(state, key); if (r) assertRevision(r.revision, expected);
      const detail = change(state, r); if (r && state.records.includes(r)) { if (r.revision === MAX_REV) throw new CommandError("Revision limit reached; export then delete the record explicitly."); r.revision++; }
      validate(state); quota(state, content);
      return { value: state, result: `${detail}\nNext: ${route} ${key && state.records.some(r => r.id === key) ? `show ${key}` : "list"}` };
    });
  };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { if (parsePage(m[1]) !== 1) throw new CommandError(`Restart: ${route} list 1`); return `Private current list · 1/1\n${s.records.map(r => `${r.id} · ${r.title.replace(/[\r\n]/g, " ")} · revision ${r.revision}`).join("\n") || `No maps. Start: ${metadata.example}`}`; }
  if ((m = command.match(/^show (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const r = get(s, m[1]); return render(r, `show ${r.id}`, `Historical snapshots; freshness unverified until sources is explicitly read.\n${JSON.stringify(envelope(r), null, 2)}`, parsePage(m[2]), m[3]); }
  if ((m = command.match(/^path (\S+) (\S+)\s*\|\s*(\S+?)(?: page (\d+))?(?: rev (\d+))?$/))) { const [, key, from, to, p, rev] = m, r = get(s, key); return render(r, `path ${key} ${from} | ${to}`, path(r, from, to), parsePage(p), rev); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new CommandError("Record exceeds export limit; use show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const key = get(s, m[1]).id; if (!m[2]) return `Delete map and owned nodes/edges/snapshots: ${route} delete ${key} confirm`; return deleteRoot(key); }
  if (command.startsWith("create ")) { const [title] = fields(command.slice(7), [160]); return save(undefined, state => { if (state.records.length === 8) throw new CommandError("Maximum eight maps. Export/delete one explicitly."); state.records.push({ id: newId, title, revision: 1, nodes: [], edges: [], attachments: [] }); return `Saved privately: ${newId}\nInspect: ${route} show ${newId}`; }); }
  if ((m = command.match(/^edit (\S+)\s*\|([\s\S]+)$/))) { const [, key, input] = m, [title] = fields(input, [160]); return save(key, (_, r) => { r!.title = title; return `Updated map: ${key}`; }); }
  if ((m = command.match(/^concept (\S+) (add|edit) ([\s\S]+)$/))) { const [, key, action, input] = m, f = fields(input, action === "add" ? [160, 600] : [36, 160, 600]), nid = action === "edit" ? f.shift()! : newId; return save(key, (_, r) => { if (action === "add") { if (r!.nodes.length === 40) throw new CommandError("Maximum 40 concepts; remove one explicitly."); r!.nodes.push({ id: nid, title: f[0], annotation: f[1] }); } else Object.assign(getNode(r!, nid), { title: f[0], annotation: f[1] }); return `Saved concept: ${nid}. Edges and historical attachments retained as user annotations.`; }); }
  if ((m = command.match(/^(connect|connect-edit) (\S+) ([\s\S]+)$/))) { const [, action, key, input] = m, f = fields(input, action === "connect" ? [36, 10, 36, 400] : [36, 36, 10, 36, 400]), eid = action === "connect-edit" ? f.shift()! : newId; if (!v.is(relation, f[1])) throw new CommandError("Relation must be supports, contrasts, example, or depends-on."); const type = f[1]; return save(key, (_, r) => { const next = { id: eid, from: f[0], type, to: f[2], label: f[3] }; if (action === "connect") { if (r!.edges.length === 80) throw new CommandError("Maximum 80 edges; remove one explicitly."); r!.edges.push(next); } else { const e = r!.edges.find(e => e.id === eid); if (!e) throw new CommandError("Edge not found."); Object.assign(e, next); } return `Saved edge: ${eid}`; }); }
  if ((m = command.match(/^sources (\S+)([\s\S]*)$/))) {
    const r = get(s, m[1]); let rest = m[2].trim(), page = 1, rev: string | undefined, expected: string | undefined;
    const tail = rest.match(/(?:^| )page (\d+) rev (\d+) fingerprint (s1:[a-f0-9]{64})$/);
    if (tail) { page = parsePage(tail[1]); rev = tail[2]; expected = tail[3]; rest = rest.slice(0, tail.index).trim(); }
    else { const p = rest.match(/(?:^| )page (\d+)$/); if (p) { page = parsePage(p[1]); rest = rest.slice(0, p.index).trim(); } }
    const scope = rest.match(/^--kind (note|memory)(?:\s+|$)/), kinds: AgentContextKind[] = scope ? [scope[1] as "note" | "memory"] : ["note", "memory"]; if (scope) rest = rest.slice(scope[0].length).trim();
    const selected = rest.match(/^--source (\S+)$/); if (rest.startsWith("--") && !selected) throw new CommandError("Use sources MAP [--kind note|memory] [QUERY or --source SOURCE_ID] [page N rev R fingerprint F].");
    boundedText(rest, { label: "Query/source selector", maxBytes: 300, allowEmpty: true });
    const commandBase = `sources ${r.id}${scope ? ` --kind ${scope[1]}` : ""}${rest ? ` ${rest}` : ""}`;
    if ((page > 1 && !rev) || (rev && rev !== String(r.revision))) throw new CommandError(`Map changed; restart: ${route} ${commandBase} page 1`);
    const sourceSet = await readSources(ctx, kinds);
    if (expected && expected !== sourceSet.fingerprint) throw new CommandError(`Source snapshot changed; restart: ${route} ${commandBase} page 1`);
    const current = get(validate(await ctx.store.read("state") ?? initial), r.id); assertRevision(current.revision, r.revision);
    const rows = sourceSet.rows.filter(row => selected ? row.source.id === selected[1] : rest.toLowerCase().split(/\s+/).every(token => `${row.source.title} ${row.source.text}`.toLowerCase().includes(token)));
    const out = [`Owned permitted snapshot: ${rows.length} matches of ${sourceSet.rows.length}; explicit selection only. No source becomes an edge automatically.\n`];
    for (const a of r.attachments) { const src = a.evidence.sources[0] as AgentContextItem; if (!kinds.includes(src.kind)) { out.push(`Attachment ${a.id}: outside requested scope; unverified.\n`); continue; } const current = sourceSet.rows.find(row => row.source.id === src.id); out.push(`Attachment ${a.id}: ${!current ? "absent/unavailable in this permitted snapshot, not proven deleted everywhere" : current.fingerprint !== a.sourceFingerprint ? "STALE: source changed; saved excerpt is historical" : "unchanged within adapter coverage"}.\n`); }
    for (const row of rows) {
      const src = row.source;
      out.push(`${src.kind} ${src.id}\nFingerprint: ${row.fingerprint}\n`);
      if (selected) out.push(`${JSON.stringify(src, null, 2)}\n`);
      else out.push(`Title preview: ${Array.from(src.title).slice(0, 80).join("")}\nText preview: ${Array.from(src.text).slice(0, 80).join("")}\nOpen: ${route} sources ${r.id} --kind ${src.kind} --source ${src.id}\n`);
    }
    return render(r, commandBase, out.join(""), page, rev, ` fingerprint ${sourceSet.fingerprint}`);
  }
  if ((m = command.match(/^(attach|attach-edit) (\S+) ([\s\S]+)$/))) {
    const [, action, key, input] = m, f = fields(input, action === "attach" ? [36, 6, 256, 67, 9, 2400] : [36, 36, 6, 256, 67, 9, 2400]), aid = action === "attach-edit" ? f.shift()! : newId;
    const [nid, kind, sourceId, expectedFingerprint, expectedRevision, excerpt] = f, r = get(s, key); getNode(r, nid);
    if (expectedRevision !== String(r.revision)) throw new CommandError(`Map changed; reopen ${route} sources ${key}`);
    if (kind !== "note" && kind !== "memory") throw new CommandError("Only owned note/memory sources may be selected.");
    boundedText(excerpt, { label: "Excerpt", maxBytes: 2400, maxUnits: 600 });
    const sourceSet = await readSources(ctx, [kind]), row = sourceSet.rows.find(row => row.source.id === sourceId);
    if (!row || row.fingerprint !== expectedFingerprint) throw new CommandError(`Selection is stale or absent from this permitted snapshot. Reopen ${route} sources ${key} --kind ${kind}`);
    if (!row.source.text.includes(excerpt)) throw new CommandError("Excerpt must be an exact nonempty span of current source text.");
    const snapshot = evidence([{ ...row.source, text: excerpt }], [kind]);
    return save(key, (_, map) => { const next = { id: aid, nodeId: nid, sourceFingerprint: row.fingerprint, capturedAt: now, evidence: snapshot }; if (action === "attach") { if (map!.attachments.length === 10) throw new CommandError("Maximum ten selected excerpts; remove one explicitly."); map!.attachments.push(next); } else { const a = map!.attachments.find(a => a.id === aid); if (!a) throw new CommandError("Attachment not found."); Object.assign(a, next); } return `Saved selected historical excerpt: ${aid}. Reference/metadata retained; no edge inferred.`; });
  }
  if ((m = command.match(/^remove (\S+) (concept|edge|attachment) (\S+) confirm$/))) { const [, key, kind, child] = m; return save(key, (_, r) => { if (kind === "concept") { getNode(r!, child); r!.nodes = r!.nodes.filter(n => n.id !== child); r!.edges = r!.edges.filter(e => e.from !== child && e.to !== child); r!.attachments = r!.attachments.filter(a => a.nodeId !== child); } else if (kind === "edge") { if (!r!.edges.some(e => e.id === child)) throw new CommandError("Edge not found."); r!.edges = r!.edges.filter(e => e.id !== child); } else { if (!r!.attachments.some(a => a.id === child)) throw new CommandError("Attachment not found."); r!.attachments = r!.attachments.filter(a => a.id !== child); } return `Removed ${kind}: ${child}. Concept removal also removes incident edges/attachments.`; }, false); }
  throw new CommandError(`Unknown/incomplete command. Use ${route} help`);
}
export default { ...metadata, async execute(command, ctx) { try { return await execute(command, ctx); } catch (error) { ctx.signal?.throwIfAborted(); if (error instanceof CommandError) return `${error.message}\nNext: ${route} help`;
    return `Saved work could not be read or confirmed safely. Inspect before retrying; a dispatched save may have completed. Help remains available; ask the operator about scoped state recovery if this persists.\nNext: ${route} list`; } } } satisfies AgentFeature;
