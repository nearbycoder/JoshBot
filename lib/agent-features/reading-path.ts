import { createHash, randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext, AgentContextItem } from "./types.js";
import metadata from "./reading-path.metadata.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { normalizeInstant } from "./feature-kit/civil-time.js";
import { captureEvidence } from "./feature-kit/evidence.js";
import { contextCapacityMessage } from "./budgets.js";
const route = "/nobo-help agent reading-path", MAX_REV = 999_999_999;
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const text = (bytes: number) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, trim: false }); return !!s.trim(); } catch { return false; } }));
const item = v.strictObject({ id, title: text(160), minutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1440)), sourceLabel: text(200), completed: v.boolean(), completedAt: v.nullable(v.string()) });
const edge = v.strictObject({ id, dependent: id, prerequisite: id });
const attachment = v.strictObject({ id, itemId: id, capturedAt: v.string(), evidence: v.strictObject({ version: v.literal(1), sources: v.pipe(v.array(v.unknown()), v.length(1)), fingerprint: v.pipe(v.string(), v.regex(/^e1:[a-f0-9]{64}$/)) }) });
const record = v.strictObject({ id, goal: text(160), revision: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_REV)), items: v.pipe(v.array(item), v.maxLength(24)), edges: v.pipe(v.array(edge), v.maxLength(48)), attachments: v.pipe(v.array(attachment), v.maxLength(10)) });
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(record), v.maxLength(10)) });
type ReadingPath = v.InferOutput<typeof record>;
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
const envelope = (r: ReadingPath) => ({ feature: metadata.id, version: 1, record: r });
function evidence(items: readonly unknown[]) {
  const snapshot = captureEvidence(items, { kinds: ["bookmark"], maxItems: 1, maxBytes: 65536, metadataKeys: ["source", "createdAt", "url", "note", "read"] });
  for (const s of snapshot.sources) {
    if (!/^toolbox:bookmarks:[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s.id) || s.metadata?.source !== "Personal toolbox / bookmarks") throw new Error("Bookmark provenance is not the supported owned toolbox adapter.");
    if ((s.metadata.url !== undefined && typeof s.metadata.url !== "string") || (s.metadata.note !== undefined && typeof s.metadata.note !== "string") || (s.metadata.read !== undefined && typeof s.metadata.read !== "boolean")) throw new Error("Malformed bookmark metadata; no selection saved.");
  }
  return snapshot;
}
function safeUri(s: AgentContextItem) {
  const url = s.sourceUrl;
  if (!url || (s.metadata?.url !== undefined && s.metadata.url !== url) || /[\\<>"`]/u.test(url) || /%(?![0-9a-fA-F]{2})/.test(url)) throw new Error("Bookmark needs an exact credential-free HTTP(S) source URL with valid URI escapes; correct it in the owning bookmark tool.");
  // captureEvidence validates the protocol, credentials, whitespace and 2048-byte
  // ceiling. Preserve query order, escaping and fragment; never normalize/fetch.
}
function topological(r: ReadingPath) {
  const done = new Set<string>(), order: ReadingPath["items"] = [];
  for (let count = 0; count < r.items.length; count++) {
    const next = r.items.find(i => !done.has(i.id) && r.edges.filter(e => e.dependent === i.id).every(e => done.has(e.prerequisite)));
    if (!next) throw new Error("Prerequisite cycle rejected atomically; remove/reorient a requires edge.");
    done.add(next.id); order.push(next);
  }
  return order;
}
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); serializedBytes(raw); const p = v.safeParse(schema, raw); if (!p.success) throw new Error("Invalid saved reading fields; data preserved. Ask the operator for scoped recovery.");
  const ids: string[] = [];
  for (const r of p.output.records) {
    ids.push(r.id, ...r.items.map(i => i.id), ...r.edges.map(e => e.id), ...r.attachments.map(a => a.id));
    const known = new Set(r.items.map(i => i.id));
    for (const i of r.items) if (i.completed ? !i.completedAt || normalizeInstant(i.completedAt) !== i.completedAt : i.completedAt !== null) throw new Error("Invalid saved reading completion; data preserved.");
    if (r.edges.some(e => e.dependent === e.prerequisite || !known.has(e.dependent) || !known.has(e.prerequisite)) || new Set(r.edges.map(e => `${e.dependent}/${e.prerequisite}`)).size !== r.edges.length) throw new Error("Prerequisites need distinct existing readings and unique edges; nothing changed.");
    topological(r);
    let bytes = 0;
    for (const a of r.attachments) {
      if (!known.has(a.itemId) || normalizeInstant(a.capturedAt) !== a.capturedAt) throw new Error("Invalid saved bookmark reference/time; data preserved.");
      const rebuilt = evidence(a.evidence.sources);
      if (rebuilt.fingerprint !== a.evidence.fingerprint || JSON.stringify(rebuilt.sources) !== JSON.stringify(a.evidence.sources)) throw new Error("Invalid saved bookmark evidence; data preserved.");
      safeUri(rebuilt.sources[0]); bytes += Buffer.byteLength(rebuilt.sources[0].text);
    }
    if (bytes > 10000 || new Set(r.attachments.map(a => a.itemId)).size !== r.attachments.length) throw new Error("Maximum 10 selected bookmark snapshots/10000 text bytes, one per reading; replace using attach-edit.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved IDs; data preserved."); return p.output;
}
const get = (s: State, key: string) => { const r = s.records.find(r => r.id === key); if (!r) throw new Error(`Item not found in your private records. Use ${route} list`); return r; };
const getItem = (r: ReadingPath, key: string) => { const i = r.items.find(i => i.id === key); if (!i) throw new Error("Reading not found; inspect show for full IDs."); return i; };
const fields = (s: string, sizes: number[]) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i] }));
function render(r: ReadingPath, command: string, body: string, page: number, expected?: string, suffix = "") {
  if ((page > 1 && !expected) || (expected !== undefined && String(r.revision) !== expected)) throw new Error(`Reading path changed or revision missing. Restart: ${route} ${command} page 1`);
  return pageAt(paginateParts(body.split(/(https?:\/\/[^\s"\\]+|toolbox:bookmarks:[A-Za-z0-9:._/-]+|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[es]1:[a-f0-9]{64})/g).map((text, i) => ({ text, atomic: i % 2 === 1 })), { mode: "plain", title: `Reading path ${r.id} · revision ${r.revision}`, command: p => `${route} ${command} page ${p} rev ${r.revision}${suffix}` }), page).text;
}
function quota(s: State, content: boolean) {
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REV, items: r.items.map(i => ({ ...i, completed: true, completedAt: "9999-12-31T23:59:59.999Z" })) })) }, limits = { maxRecords: 10 };
  assertQuota(s, content ? { kind: "content", records: s.records.map(envelope), limits, future: { value: future, records: future.records.map(envelope) } } : { kind: "lifecycle", records: s.records.map(envelope), limits });
  assertQuota(future, { kind: "lifecycle", records: future.records.map(envelope), limits });
  for (const r of s.records) render(r, `show ${r.id}`, JSON.stringify(envelope(r), null, 2), 1);
}
function invalidate(r: ReadingPath, seeds: string[]) {
  const affected = new Set(seeds), queue = [...seeds];
  for (let i = 0; i < queue.length; i++) for (const e of r.edges.filter(e => e.prerequisite === queue[i])) if (!affected.has(e.dependent)) { affected.add(e.dependent); queue.push(e.dependent); }
  let count = 0; for (const i of r.items) if (affected.has(i.id)) { if (i.completed) count++; i.completed = false; i.completedAt = null; } return count;
}
function plan(r: ReadingPath, budget: number) {
  const order = topological(r), selected = new Set<string>(), deferred: string[] = []; let used = 0;
  for (const item of order) {
    if (item.completed || selected.has(item.id)) continue;
    const closure = new Set<string>(), queue = [item.id];
    for (let i = 0; i < queue.length; i++) { const key = queue[i], reading = getItem(r, key); if (closure.has(key)) continue; closure.add(key); if (!reading.completed) for (const e of r.edges.filter(e => e.dependent === key)) queue.push(e.prerequisite); }
    const needed = order.filter(i => closure.has(i.id) && !i.completed && !selected.has(i.id)), cost = needed.reduce((n, i) => n + i.minutes, 0);
    if (used + cost <= budget) { for (const i of needed) selected.add(i.id); used += cost; }
    else deferred.push(`${item.id} · ${item.title}: deferred; unread prerequisite closure needs ${cost} additional whole minutes, ${budget - used} remain. No partial reading. Missing prerequisite allocations: ${needed.filter(i => i.id !== item.id).map(i => i.id).join(", ") || "none; this reading itself exceeds remaining budget"}.\n`);
  }
  const out = [`Goal: ${r.goal}\nWhole-reading route: ${used}/${budget} minutes. Stable topological/insertion order; greedy, not a global optimizer. Shared unread prerequisites counted once. User-reported reading is not mastery.\n`];
  for (const i of order.filter(i => selected.has(i.id))) out.push(`${i.id} · ${i.title} · ${i.minutes} minutes\nSource label: ${i.sourceLabel}\nPrerequisites: ${r.edges.filter(e => e.dependent === i.id).map(e => e.prerequisite).join(", ") || "none"}\n`);
  if (!selected.size) out.push("No whole unread reading fits this budget.\n");
  out.push("\nDeferred materials:\n", ...deferred, "\nPreviously reported read (not mastery):\n");
  for (const i of order.filter(i => i.completed)) out.push(`${i.id} · ${i.title} · reported ${i.completedAt}\n`);
  out.push("Bookmark references are historical snapshots; bookmarks explicitly checks current availability. Full source URLs and annotations are in show/export.\n"); return out.join("");
}
async function readBookmarks(ctx: AgentFeatureContext) {
  let items: AgentContextItem[];
  try { items = await ctx.services.readContext(["bookmark"]); }
  catch (error) { ctx.signal?.throwIfAborted(); throw new Error(contextCapacityMessage(error, "Reduce the owned bookmark collection or an oversized bookmark in its owning tool; query changes do not reduce the read.") ?? "Owned bookmarks could not be read completely; saved snapshots remain unchanged. Check the owning source before retrying."); }
  if (items.length > 100) throw new Error("Bookmark capacity exceeded: maximum 100 adapter items; no clipping. Reduce the owning collection.");
  const seen = new Set<string>(); const rows = items.map(s => { if (seen.has(s.id)) throw new Error("Duplicate bookmark reference; selection refused."); seen.add(s.id); const snapshot = evidence([s]); return { source: snapshot.sources[0], fingerprint: snapshot.fingerprint }; }).sort((a, b) => a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0);
  return { rows, fingerprint: `s1:${createHash("sha256").update(JSON.stringify(rows.map(r => [r.source.id, r.fingerprint]))).digest("hex")}` };
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID(), now = normalizeInstant(ctx.now.toISOString());
  const save = (key: string | undefined, change: (s: State, r?: ReadingPath) => string, content = true) => {
    const expected = key === undefined ? undefined : get(s, key).revision;
    return ctx.store.update("state", initial, raw => { const state = validate(raw), r = key === undefined ? undefined : get(state, key); if (r) assertRevision(r.revision, expected); const detail = change(state, r); if (r && state.records.includes(r)) r.revision++; validate(state); quota(state, content); return { value: state, result: `${detail}\nNext: ${route} ${key && state.records.some(r => r.id === key) ? `show ${key}` : "list"}` }; });
  };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { if (parsePage(m[1]) !== 1) throw new Error(`Restart: ${route} list 1`); return `Private current list · 1/1\n${s.records.map(r => `${r.id} · ${r.goal.replace(/[\r\n]/g, " ")} · revision ${r.revision}`).join("\n") || `No reading paths. Start: ${metadata.example}`}`; }
  if ((m = command.match(/^show (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const r = get(s, m[1]); return render(r, `show ${r.id}`, `Reading reports are not mastery; bookmark snapshots are historical, freshness unverified.\n${JSON.stringify(envelope(r), null, 2)}`, parsePage(m[2]), m[3]); }
  if ((m = command.match(/^route (\S+)\s*\|\s*(\d+)(?: page (\d+))?(?: rev (\d+))?$/))) { const r = get(s, m[1]), minutes = parseInteger(m[2], { min: 1, max: 10080, label: "Minute budget" }); return render(r, `route ${r.id} | ${minutes}`, plan(r, minutes), parsePage(m[3]), m[4]); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Record exceeds export limit; use show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const key = get(s, m[1]).id; if (!m[2]) return `Delete path and owned readings/edges/bookmark snapshots: ${route} delete ${key} confirm`; return save(key, state => { state.records = state.records.filter(r => r.id !== key); return `Deleted privately: ${key}`; }, false); }
  if (command.startsWith("create ")) { const [goal] = fields(command.slice(7), [160]); return save(undefined, state => { if (state.records.length === 10) throw new Error("Maximum ten paths. Export/delete one explicitly."); state.records.push({ id: newId, goal, revision: 1, items: [], edges: [], attachments: [] }); return `Saved privately: ${newId}\nInspect: ${route} show ${newId}`; }); }
  if ((m = command.match(/^edit (\S+)\s*\|([\s\S]+)$/))) { const [, key, input] = m, [goal] = fields(input, [160]); return save(key, (_, r) => { r!.goal = goal; return `Updated goal: ${key}. Reading reports concern unchanged material, not achievement of this goal.`; }); }
  if ((m = command.match(/^item (\S+) (add|edit) ([\s\S]+)$/))) { const [, key, action, input] = m, f = fields(input, action === "add" ? [160, 4, 200] : [36, 160, 4, 200]), iid = action === "edit" ? f.shift()! : newId, minutes = parseInteger(f[1], { min: 1, max: 1440, label: "Reading minutes" }); return save(key, (_, r) => { let reset = 0; if (action === "add") { if (r!.items.length === 24) throw new Error("Maximum 24 readings."); r!.items.push({ id: iid, title: f[0], minutes, sourceLabel: f[2], completed: false, completedAt: null }); } else { const item = getItem(r!, iid); if (item.title !== f[0] || item.sourceLabel !== f[2]) reset = invalidate(r!, [iid]); Object.assign(item, { title: f[0], minutes, sourceLabel: f[2] }); } return `Saved reading: ${iid}. ${reset} completion report(s) cleared for changed material/dependents; minutes-only edits retain reports.`; }); }
  if ((m = command.match(/^(requires|requires-edit) (\S+) ([\s\S]+)$/))) { const [, action, key, input] = m, f = fields(input, action === "requires" ? [36, 36] : [36, 36, 36]), eid = action === "requires-edit" ? f.shift()! : newId; return save(key, (_, r) => { getItem(r!, f[0]); getItem(r!, f[1]); let reset = 0; const next = { id: eid, dependent: f[0], prerequisite: f[1] }; if (action === "requires") { if (r!.edges.length === 48) throw new Error("Maximum 48 prerequisite edges."); r!.edges.push(next); } else { const e = r!.edges.find(e => e.id === eid); if (!e) throw new Error("Prerequisite edge not found."); reset += invalidate(r!, [e.dependent]); Object.assign(e, next); } reset += invalidate(r!, [f[0]]); return `Saved prerequisite edge: ${eid}. ${reset} affected completion report(s) cleared; re-report after reviewing changed prerequisites.`; }); }
  if ((m = command.match(/^read (\S+) (\S+)$/))) { const [, key, iid] = m; return save(key, (_, r) => { const item = getItem(r!, iid); if (item.completed) throw new Error(`Already reported read. To remove that report: ${route} unread ${key} ${iid} confirm`); item.completed = true; item.completedAt = now; return `Reading ${iid} reported read; this is not mastery or evidence that prerequisites were read. Recompute a route with your chosen minute budget.`; }, false); }
  if ((m = command.match(/^unread (\S+) (\S+) confirm$/))) { const [, key, iid] = m; return save(key, (_, r) => { getItem(r!, iid); const count = invalidate(r!, [iid]); return `Cleared ${count} reading report(s), including dependents; material remains saved.`; }, false); }
  if ((m = command.match(/^bookmarks (\S+)([\s\S]*)$/))) {
    const r = get(s, m[1]); let rest = m[2].trim(), page = 1, rev: string | undefined, expected: string | undefined;
    const tail = rest.match(/(?:^| )page (\d+) rev (\d+) fingerprint (s1:[a-f0-9]{64})$/); if (tail) { page = parsePage(tail[1]); rev = tail[2]; expected = tail[3]; rest = rest.slice(0, tail.index).trim(); } else { const p = rest.match(/(?:^| )page (\d+)$/); if (p) { page = parsePage(p[1]); rest = rest.slice(0, p.index).trim(); } }
    const selected = rest.match(/^--source (\S+)$/); if (rest.startsWith("--") && !selected) throw new Error("Use bookmarks PATH [QUERY or --source SOURCE_ID] [page N rev R fingerprint F].");
    boundedText(rest, { label: "Query/source selector", maxBytes: 300, allowEmpty: true }); const commandBase = `bookmarks ${r.id}${rest ? ` ${rest}` : ""}`;
    if ((page > 1 && !rev) || (rev && rev !== String(r.revision))) throw new Error(`Path changed; restart: ${route} ${commandBase} page 1`);
    const sourceSet = await readBookmarks(ctx); if (expected && expected !== sourceSet.fingerprint) throw new Error(`Bookmark snapshot changed; restart: ${route} ${commandBase} page 1`);
    assertRevision(get(validate(await ctx.store.read("state") ?? initial), r.id).revision, r.revision);
    const rows = sourceSet.rows.filter(row => selected ? row.source.id === selected[1] : rest.toLowerCase().split(/\s+/).every(token => `${row.source.title} ${row.source.text}`.toLowerCase().includes(token)));
    const out = [`Owned permitted bookmarks: ${rows.length} matches of ${sourceSet.rows.length}; selection only, no article fetch or invented time estimate.\n`];
    for (const a of r.attachments) { const src = a.evidence.sources[0] as AgentContextItem, current = sourceSet.rows.find(row => row.source.id === src.id); out.push(`Attachment ${a.id}: ${!current ? "absent/unavailable in this permitted snapshot, not proven deleted everywhere" : current.fingerprint !== a.evidence.fingerprint ? "STALE: bookmark changed; saved reference is historical" : "unchanged within adapter coverage"}.\n`); }
    for (const row of rows) { const src = row.source; out.push(`${src.id}\nFingerprint: ${row.fingerprint}\n`); if (selected) out.push(`${JSON.stringify(src, null, 2)}\n`); else out.push(`Title preview: ${Array.from(src.title).slice(0, 80).join("")}\nURL: ${src.sourceUrl ?? "unavailable/unsupported; cannot attach"}\nOpen: ${route} bookmarks ${r.id} --source ${src.id}\n`); }
    return render(r, commandBase, out.join(""), page, rev, ` fingerprint ${sourceSet.fingerprint}`);
  }
  if ((m = command.match(/^(attach|attach-edit) (\S+) ([\s\S]+)$/))) {
    const [, action, key, input] = m, f = fields(input, action === "attach" ? [36, 256, 67, 9] : [36, 36, 256, 67, 9]), aid = action === "attach-edit" ? f.shift()! : newId, [iid, sourceId, expectedFingerprint, expectedRevision] = f, r = get(s, key); getItem(r, iid);
    if (expectedRevision !== String(r.revision)) throw new Error(`Path changed; reopen ${route} bookmarks ${key}`);
    const sourceSet = await readBookmarks(ctx), row = sourceSet.rows.find(row => row.source.id === sourceId); if (!row || row.fingerprint !== expectedFingerprint) throw new Error(`Bookmark selection is stale or absent from this permitted snapshot. Reopen ${route} bookmarks ${key}`); safeUri(row.source);
    const snapshot = evidence([row.source]);
    return save(key, (_, path) => { const next = { id: aid, itemId: iid, capturedAt: now, evidence: snapshot }; let reset = 0; if (action === "attach") { if (path!.attachments.length === 10) throw new Error("Maximum ten bookmark snapshots."); path!.attachments.push(next); } else { const a = path!.attachments.find(a => a.id === aid); if (!a) throw new Error("Attachment not found."); reset += invalidate(path!, [a.itemId]); Object.assign(a, next); } reset += invalidate(path!, [iid]); return `Saved selected bookmark: ${aid}; exact URL/metadata retained. ${reset} affected completion report(s) cleared. Owning bookmark read flags do not mark this reading complete.`; });
  }
  if ((m = command.match(/^remove (\S+) (item|edge|attachment) (\S+) confirm$/))) { const [, key, kind, child] = m; return save(key, (_, r) => { let reset = 0; if (kind === "item") { getItem(r!, child); reset = invalidate(r!, [child]); r!.items = r!.items.filter(i => i.id !== child); r!.edges = r!.edges.filter(e => e.dependent !== child && e.prerequisite !== child); r!.attachments = r!.attachments.filter(a => a.itemId !== child); } else if (kind === "edge") { const e = r!.edges.find(e => e.id === child); if (!e) throw new Error("Edge not found."); reset = invalidate(r!, [e.dependent]); r!.edges = r!.edges.filter(e => e.id !== child); } else { const a = r!.attachments.find(a => a.id === child); if (!a) throw new Error("Attachment not found."); reset = invalidate(r!, [a.itemId]); r!.attachments = r!.attachments.filter(a => a.id !== child); } return `Removed ${kind}: ${child}; ${reset} affected completion report(s) cleared. Item removal also removes incident edges/bookmark snapshot.`; }, false); }
  throw new Error(`Unknown/incomplete command. Use ${route} help`);
}
export default { ...metadata, async execute(command, ctx) { try { return await execute(command, ctx); } catch (error) { ctx.signal?.throwIfAborted(); return `${error instanceof Error ? error.message : "Command failed safely; inspect before retrying."}\nNext: ${route} help`; } } } satisfies AgentFeature;
