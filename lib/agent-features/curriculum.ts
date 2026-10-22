import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./curriculum.metadata.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt, type DisplayPart } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, dateInZone } from "./feature-kit/civil-time.js";
const route = "/nobo-help agent curriculum";
const id = v.pipe(v.string(), v.uuid());
const integer = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max));
const rev = integer(Number.MAX_SAFE_INTEGER);
const text = (bytes: number) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, trim: false, allowEmpty: true }); return true; } catch { return false; } }));
const day = v.pipe(v.string(), v.check(s => { try { civilDate(s); return true; } catch { return false; } }));
const demonstration = v.strictObject({ evidence: text(240), date: day, unitRevision: rev });
const unit = v.strictObject({ id, revision: rev, label: text(120), estimateSessions: v.nullable(integer(168)), readinessTest: text(240), prerequisites: v.pipe(v.array(id), v.maxLength(23)), demonstration: v.nullable(demonstration) });
const course = v.strictObject({ id, revision: rev, target: text(120), sessionsPerWeek: v.nullable(integer(14)), sessionMinutes: v.nullable(integer(180)), units: v.pipe(v.array(unit), v.maxLength(24)) });
type Course = v.InferOutput<typeof course>;
type Unit = v.InferOutput<typeof unit>;
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(course), v.maxLength(8)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
function topological(c: Course): Unit[] {
  const byId = new Map(c.units.map(u => [u.id, u])), colors = new Map<string, number>(), out: Unit[] = [];
  const visit = (u: Unit) => {
    if (colors.get(u.id) === 1) throw new Error("Prerequisite cycle; change was not saved.");
    if (colors.get(u.id) === 2) return;
    colors.set(u.id, 1);
    for (const pid of u.prerequisites) { const p = byId.get(pid); if (!p) throw new Error("Missing prerequisite ID; use show for full unit IDs."); visit(p); }
    colors.set(u.id, 2); out.push(u);
  };
  [...c.units].sort((a, b) => a.id.localeCompare(b.id)).forEach(visit); return out;
}
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw);
  if (!p.success) throw new Error("Invalid saved curriculum data; preserved. Ask a maintainer to repair state; help remains available.");
  const ids: string[] = [];
  for (const c of p.output.records) {
    ids.push(c.id, ...c.units.map(u => u.id));
    if (c.units.reduce((n, u) => n + u.prerequisites.length, 0) > 60) throw new Error("Maximum 60 prerequisite edges per course.");
    for (const u of topological(c)) {
      if (u.revision > c.revision || new Set(u.prerequisites).size !== u.prerequisites.length || (u.demonstration && (!u.demonstration.evidence.trim() || u.demonstration.unitRevision > u.revision))) throw new Error("Invalid saved unit revision, evidence or duplicate prerequisite; preserved.");
      if (u.demonstration?.unitRevision === u.revision && (!u.label.trim() || !u.readinessTest.trim() || !u.prerequisites.every(p => { const x = c.units.find(x => x.id === p)!; return x.demonstration?.unitRevision === x.revision; }))) throw new Error("Invalid demonstration of unknown or blocked work; preserved.");
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved IDs; preserved."); return p.output;
}
const get = (s: State, key: string) => { const c = s.records.find(c => c.id === key); if (!c) throw new Error(`Course not found. Use ${route} list`); return c; };
const getUnit = (c: Course, key: string) => { const u = c.units.find(u => u.id === key); if (!u) throw new Error("Unit not found; use show for full IDs."); return u; };
const mastered = (u: Unit) => u.demonstration?.unitRevision === u.revision;
function invalidate(c: Course, seeds: string[]) {
  const affected = new Set(seeds);
  // A visited closure, capped at 24 nodes; shared prerequisites are processed once.
  for (let pass = 0; pass < c.units.length; pass++) { const before = affected.size; for (const u of c.units) if (u.prerequisites.some(p => affected.has(p))) affected.add(u.id); if (affected.size === before) break; }
  for (const u of c.units) if (affected.has(u.id)) u.revision++;
}
const envelope = (c: Course) => ({ feature: metadata.id, version: 1, record: c });
function parts(s: string): DisplayPart[] { return s.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g).map((text, i) => ({ text, atomic: i % 2 === 1 })); }
function page(c: Course, verb: string, body: string, n = 1, expected?: string) {
  if (expected) assertRevision(c.revision, Number(expected));
  return pageAt(paginateParts(parts(body), { mode: "plain", title: `${c.id} · revision ${c.revision}`, command: p => `${route} ${verb} ${c.id} page ${p} rev ${c.revision}` }), n).text;
}
function plan(c: Course) {
  const ordered = topological(c), cap = (c.sessionsPerWeek ?? 0) * 12, planned = new Set<string>(), rows: string[] = [];
  let used = 0, remaining = 0;
  const next = ordered.find(u => !mastered(u) && u.label.trim() && u.readinessTest.trim() && u.prerequisites.every(p => mastered(getUnit(c, p))));
  for (const u of ordered) {
    const blocked = u.prerequisites.filter(p => !mastered(getUnit(c, p)));
    const state = mastered(u) ? "USER-DEMONSTRATED" : !u.label.trim() || !u.readinessTest.trim() ? "UNKNOWN: missing label/readiness criterion" : blocked.length ? "BLOCKED" : "READY for practice/demonstration";
    rows.push(`Unit ${u.id}: ${u.label || "Untitled"} · ${state}\nReadiness: ${u.readinessTest || "unknown"}\nPrerequisites: ${u.prerequisites.join(", ") || "none"}\n`);
    if (u.demonstration) rows.push(`Evidence (${mastered(u) ? "current user report" : "STALE"}) on civil date ${u.demonstration.date}: ${u.demonstration.evidence}\n`);
    if (mastered(u)) { planned.add(u.id); rows.push("No study sessions allocated; current user demonstration retained.\n"); continue; }
    if (!c.target.trim() || !c.sessionsPerWeek || !c.sessionMinutes || !u.estimateSessions || !u.label.trim() || !u.readinessTest.trim() || u.prerequisites.some(p => !planned.has(p))) {
      remaining += u.estimateSessions ?? 0; rows.push("Unallocated: unknown configuration/estimate/readiness, or prerequisite not fully allocated.\n"); continue;
    }
    const allocate = Math.min(u.estimateSessions, cap - used), weeks = new Map<number, number>();
    for (let i = 0; i < allocate; i++) { const week = Math.floor((used + i) / c.sessionsPerWeek) + 1; weeks.set(week, (weeks.get(week) ?? 0) + 1); }
    used += allocate; remaining += u.estimateSessions - allocate;
    if (allocate === u.estimateSessions) planned.add(u.id);
    rows.push(`${blocked.length ? "CONDITIONAL future allocation (prerequisites still need evidence)" : "Allocation"}: ${[...weeks].map(([w, n]) => `week ${w}: ${n} whole sessions/${n * c.sessionMinutes!} min`).join("; ") || "none; 12-week horizon full"}. Remaining ${u.estimateSessions - allocate} sessions.\n`);
  }
  return `Study plan: ${c.target || "target unknown"}\n12 weeks; ${c.sessionsPerWeek ?? "unknown"} sessions/week; ${c.sessionMinutes ?? "unknown"} minutes/session. ${used}/${cap} whole sessions allocated, ${used * (c.sessionMinutes ?? 0)} minutes; ${remaining} known sessions unallocated.\nElapsed time and allocation never unlock a unit; no certification. Unknown estimates are additional unquantified work.\nNext eligible unit: ${next ? `${next.id} — ${next.label}` : "none; supply criteria or demonstrate prerequisites"}\n` + rows.join("");
}
function future(s: State): State { return { version: 1, records: s.records.map(c => ({ ...c, revision: Number.MAX_SAFE_INTEGER, units: c.units.map(u => ({ ...u, revision: Number.MAX_SAFE_INTEGER, demonstration: { evidence: "\\".repeat(240), date: "9999-12-31", unitRevision: Number.MAX_SAFE_INTEGER } })) })) }; }
function admit(s: State, lifecycle: boolean) {
  for (const c of s.records) { page(c, "show", JSON.stringify(envelope(c), null, 2)); page(c, "plan", plan(c)); }
  const projected = future(s), limits = { maxRecords: 8 };
  if (lifecycle) assertQuota(s, { kind: "lifecycle", records: s.records.map(envelope), limits });
  else assertQuota(s, { kind: "content", records: s.records.map(envelope), limits, future: { value: projected, records: projected.records.map(envelope) } });
}
const fields = (s: string, sizes: number[]) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((x, i) => boundedText(x, { label: "Field", maxBytes: sizes[i], trim: false }));
const number = (s: string, max: number) => parseInteger(s, { min: 1, max });
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID(), date = dateInZone(ctx.now, ctx.timezone);
  const usage = (state: State) => `${state.records.length}/8 courses; ${serializedBytes(state)}/49152 saved bytes; ${serializedBytes(future(state))}/49152 projected lifecycle bytes (32768 content admission). Free space: ${route} list, then delete ID confirm.`;
  const save = (change: (s: State) => Course | null, mode: "content" | "lifecycle" | "remove" = "content") => ctx.store.update("state", initial, raw => {
    const state = validate(raw), c = change(state); validate(state); if (mode !== "remove") admit(state, mode === "lifecycle");
    return { value: state, result: `${c ? `Saved privately: ${c.id} · revision ${c.revision}\nNext: ${route} plan ${c.id}` : "Deleted privately."}\n${usage(state)}` };
  });
  const edit = (key: string, change: (c: Course) => void, mode: "content" | "lifecycle" | "remove" = "content") => { const expected = get(s, key).revision; return save(state => { const c = get(state, key); assertRevision(c.revision, expected); change(c); c.revision++; return c; }, mode); };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { if (parsePage(m[1]) !== 1) throw new Error("Page out of range; use list."); return `${usage(s)}\nCurrent list 1/1\n${[...s.records].sort((a, b) => a.id.localeCompare(b.id)).map(c => `${c.id} · ${c.target || "Untitled"} · ${c.units.length}/24 units`).join("\n") || `No saved items. Start: ${metadata.example}`}\nOpen: ${route} show ID`; }
  if ((m = command.match(/^(show|plan) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) { const c = get(s, m[2]); return page(c, m[1], m[1] === "show" ? JSON.stringify(envelope(c), null, 2) : plan(c), parsePage(m[3]), m[4]); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Legacy export too large; use show pages then delete."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const c = get(s, m[1]); if (!m[2]) return `Deletes course, units and evidence: ${route} delete ${c.id} confirm`; return save(state => { assertRevision(get(state, c.id).revision, c.revision); state.records = state.records.filter(x => x.id !== c.id); return null; }, "remove"); }
  if (command.startsWith("create ")) { const [target, sessions, minutes] = fields(command.slice(7), [120, 3, 3]); const sessionsPerWeek = number(sessions, 14), sessionMinutes = number(minutes, 180); return save(state => { const c: Course = { id: newId, revision: 1, target, sessionsPerWeek, sessionMinutes, units: [] }; state.records.push(c); return c; }); }
  if ((m = command.match(/^edit (\S+) (target|sessionsPerWeek|sessionMinutes)\s*\|([\s\S]*)$/))) { const [, key, field, input] = m, [value] = fields(input, [field === "target" ? 120 : 3]); return edit(key, c => { if (field === "target") { c.target = value; invalidate(c, c.units.map(u => u.id)); } else c[field as "sessionsPerWeek" | "sessionMinutes"] = number(value, field === "sessionsPerWeek" ? 14 : 180); }); }
  if ((m = command.match(/^clear (\S+) (target|sessionsPerWeek|sessionMinutes) confirm$/))) { const [, key, field] = m; return edit(key, c => { if (field === "target") { c.target = ""; invalidate(c, c.units.map(u => u.id)); } else c[field as "sessionsPerWeek" | "sessionMinutes"] = null; }, "remove"); }
  if ((m = command.match(/^unit (\S+) add ([\s\S]+)$/))) { const key = m[1], [label, estimate, readinessTest] = fields(m[2], [120, 3, 240]), estimateSessions = number(estimate, 168); const result = await edit(key, c => { if (c.units.length === 24) throw new Error("Maximum 24 units; remove a unit first."); c.units.push({ id: newId, revision: 1, label, estimateSessions, readinessTest, prerequisites: [], demonstration: null }); }); return `Unit ${newId} added.\n${result}`; }
  if ((m = command.match(/^unit (\S+) edit (\S+)\s*\|([\s\S]*)$/))) { const [, key, uid, input] = m, [label, estimate, readinessTest] = fields(input, [120, 3, 240]), estimateSessions = number(estimate, 168); return edit(key, c => { Object.assign(getUnit(c, uid), { label, estimateSessions, readinessTest }); invalidate(c, [uid]); }); }
  if ((m = command.match(/^unit (\S+) clear (\S+) (label|estimateSessions|readinessTest) confirm$/))) { const [, key, uid, field] = m; return edit(key, c => { const u = getUnit(c, uid); if (field === "estimateSessions") u.estimateSessions = null; else u[field as "label" | "readinessTest"] = ""; invalidate(c, [uid]); }, "remove"); }
  if ((m = command.match(/^unit (\S+) remove (\S+) confirm$/))) { const [, key, uid] = m; return edit(key, c => { getUnit(c, uid); invalidate(c, [uid]); c.units = c.units.filter(u => u.id !== uid); for (const u of c.units) u.prerequisites = u.prerequisites.filter(p => p !== uid); }, "remove"); }
  if ((m = command.match(/^requires (\S+) (\S+)\s*\|([\s\S]*)$/))) { const [, key, uid, input] = m, [value] = fields(input, [900]); const prerequisites = value.split(",").map(s => s.trim()); return edit(key, c => { getUnit(c, uid).prerequisites = prerequisites; topological(c); invalidate(c, [uid]); }); }
  if ((m = command.match(/^requires (\S+) (\S+) clear confirm$/))) { const [, key, uid] = m; return edit(key, c => { getUnit(c, uid).prerequisites = []; invalidate(c, [uid]); }, "remove"); }
  if ((m = command.match(/^(demonstrate|evidence) (\S+) (\S+)\s*\|([\s\S]*)$/))) { const [, verb, key, uid, input] = m, f = fields(input, verb === "evidence" ? [10, 240] : [240]); const day = verb === "evidence" ? civilDate(f[0]) : date, evidence = f.at(-1)!;
    return edit(key, c => { const u = getUnit(c, uid); if (!u.label.trim() || !u.readinessTest.trim()) throw new Error("Unknown readiness: supply a label and readiness criterion first."); if (u.prerequisites.some(p => !mastered(getUnit(c, p)))) throw new Error("Blocked: demonstrate prerequisites first."); u.demonstration = { evidence, date: day, unitRevision: u.revision }; }, "lifecycle"); }
  if ((m = command.match(/^reopen (\S+) (\S+) confirm$/))) { const [, key, uid] = m; return edit(key, c => { getUnit(c, uid).demonstration = null; invalidate(c, [uid]); }, "remove"); }
  throw new Error(`Unknown or incomplete command. Use ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
