import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./assumption-tests.metadata.js";
import { boundedText, pipeFields, parseDecimal, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, normalizeInstant } from "./feature-kit/civil-time.js";
const route = "/nobo-help agent assumption-tests";
const text = (max: number) => v.pipe(v.string(), v.check(s => { try { return boundedText(s, { label: "Text", maxBytes: max }) === s; } catch { return false; } }));
const instant = v.pipe(v.string(), v.check(s => { try { return normalizeInstant(s) === s; } catch { return false; } }));
const date = v.pipe(v.string(), v.check(s => { try { return civilDate(s) === s; } catch { return false; } }));
const idSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/));
const numeric = v.pipe(v.number(), v.minValue(-1_000_000), v.maxValue(1_000_000), v.check(n => Number.isFinite(n) && Math.abs(n * 1000 - Math.round(n * 1000)) < 0.00001));
const nonnegative = v.pipe(numeric, v.minValue(0));
const minimum = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20));
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const observation = v.strictObject({ id: idSchema, date, value: numeric, effortMinutes: nonnegative, note: v.nullable(text(256)), recordedAt: instant });
const resultSchema = v.strictObject({ criterion: v.picklist(["insufficient", "met", "not-met"]), count: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20)), mean: v.nullable(v.pipe(v.number(), v.minValue(-1_000_000), v.maxValue(1_000_000))), effortMinutes: v.pipe(v.number(), v.minValue(0), v.maxValue(20_000_000)), effortExceeded: v.boolean(), evaluatedAt: instant });
const designSchema = v.strictObject({ id: idSchema, createdAt: instant, revisionReason: v.nullable(text(256)), belief: text(120), metricLabel: text(96), direction: v.picklist(["at-least", "at-most"]), threshold: numeric, sampleMinimum: minimum, effortCapMinutes: v.pipe(nonnegative, v.minValue(0.001)), method: v.nullable(text(768)), lockedAt: v.nullable(instant), observations: v.pipe(v.array(observation), v.maxLength(20)), result: v.nullable(resultSchema) });
type Design = v.InferOutput<typeof designSchema>;
const experimentSchema = v.strictObject({ id: idSchema, revision, createdAt: instant, versions: v.pipe(v.array(designSchema), v.minLength(1), v.maxLength(3)) });
type Experiment = v.InferOutput<typeof experimentSchema>;
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(experimentSchema), v.maxLength(12)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
function calculate(d: Design, at: string): v.InferOutput<typeof resultSchema> {
  const count = d.observations.length, sumUnits = d.observations.reduce((sum, o) => sum + Math.round(o.value * 1000), 0);
  const mean = count ? sumUnits / count / 1000 : null;
  const effortUnits = d.observations.reduce((sum, o) => sum + Math.round(o.effortMinutes * 1000), 0), effortMinutes = effortUnits / 1000;
  const boundary = Math.round(d.threshold * 1000) * count;
  return { criterion: count < d.sampleMinimum ? "insufficient" : (d.direction === "at-least" ? sumUnits >= boundary : sumUnits <= boundary) ? "met" : "not-met", count, mean, effortMinutes, effortExceeded: effortUnits > Math.round(d.effortCapMinutes * 1000), evaluatedAt: at };
}
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw); if (!p.success) throw new Error("Invalid saved experiment data; nothing changed."); const ids: string[] = [];
  for (const r of p.output.records) {
    ids.push(r.id); if (r.versions.reduce((n, d) => n + d.observations.length, 0) > 20) throw new Error("Experiment observation limit is 20 across all versions.");
    for (const [i, d] of r.versions.entries()) {
      ids.push(d.id, ...d.observations.map(o => o.id));
      if ((!d.lockedAt && (d.observations.length || d.result)) || (d.lockedAt && !d.method) || (i < r.versions.length - 1 && !d.lockedAt)) throw new Error("Invalid saved design lock; nothing changed.");
      if (d.result && JSON.stringify(d.result) !== JSON.stringify(calculate(d, d.result.evaluatedAt))) throw new Error("Saved evaluation does not match its observations; nothing changed.");
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved identities; nothing changed."); return p.output;
}
const envelope = (r: Experiment) => ({ feature: metadata.id, version: 1, record: r });
const active = (r: Experiment) => r.versions[r.versions.length - 1];
function admit(s: State, lifecycle: boolean) {
  // Reserve a missing procedure, minimum numeric observations WITHOUT optional notes, and lock/evaluation.
  const future = { ...s, records: s.records.map(r => {
    const current = active(r), missing = Math.max(0, current.sampleMinimum - current.observations.length), total = r.versions.reduce((n, d) => n + d.observations.length, 0);
    if (total + missing > 20) throw new Error("The remaining observation slots cannot meet this version's sample minimum; lower it before lock or start a new experiment.");
    return { ...r, revision: Number.MAX_SAFE_INTEGER, versions: r.versions.map((d, i) => ({ ...d, method: d.method ?? "\n".repeat(768), lockedAt: "9999-12-31T23:59:59.999Z", observations: [...d.observations.map(o => ({ ...o, value: -999999.999, effortMinutes: 999999.999 })), ...(i === r.versions.length - 1 ? Array.from({ length: missing }, () => ({ id: "ffffffff-ffff-ffff-ffff-ffffffffffff", date: "9999-12-31", value: -999999.999, effortMinutes: 999999.999, note: null, recordedAt: "9999-12-31T23:59:59.999Z" })) : [])], result: { criterion: "insufficient" as const, count: 20, mean: -0.00005263157894736842, effortMinutes: 19999999.999, effortExceeded: false, evaluatedAt: "9999-12-31T23:59:59.999Z" } })) };
  }) };
  assertQuota(s, { records: s.records.map(envelope), ...(lifecycle ? { kind: "lifecycle" as const } : { kind: "content" as const, future: { value: future, records: future.records.map(envelope) } }) });
}
const fields = (input: string, sizes: number[]) => pipeFields(input, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i] }));
const number = (s: string, min = -1_000_000) => { if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(s)) throw new Error("Use a plain number with at most 3 decimals."); return parseDecimal(s, { min, max: 1_000_000 }); };
const direction = (s: string): Design["direction"] => { if (s !== "at-least" && s !== "at-most") throw new Error("Direction must be at-least or at-most."); return s; };
const get = (s: State, id: string) => { const r = s.records.find(r => r.id === id); if (!r) throw new Error(`Experiment not found. Use ${route} list`); return r; };
const fmt = (n: number) => Number(n.toFixed(6)).toString();
function summary(r: Experiment) {
  const d = active(r), result = d.result;
  if (!result) return `Version ${d.id}: ${d.lockedAt ? "locked; evaluation not recorded" : "draft; lock before observations"}.\nNext: ${route} show ${r.id}`;
  return `Experiment ${r.id} · version ${d.id}\nPredeclared arithmetic mean rule: ${d.metricLabel} ${d.direction} ${d.threshold}; at least ${d.sampleMinimum} observations.\nObserved n=${result.count}; mean ${result.mean === null ? "unknown" : fmt(result.mean)}. ${result.criterion === "insufficient" ? "Insufficient observations — no success conclusion." : result.criterion === "met" ? "Criterion met for this test." : "Criterion not met for this test."}\nEffort ${fmt(result.effortMinutes)}/${d.effortCapMinutes} minutes: ${result.effortExceeded ? "EXCEEDED effort cap; this was not a within-budget test." : "within entered cap"}\nNo scientific proof or causal attribution; sample selection, measurement quality and independence are not verified.\nNext: ${route} show ${r.id}`;
}
function render(r: Experiment, page: number, expected?: string) {
  if (expected) assertRevision(r.revision, Number(expected));
  return pageAt(paginateParts(JSON.stringify(envelope(r), null, 2).split(/(?<=\n)/).map(text => ({ text, atomic: true })), { mode: "plain", title: `Experiment ${r.id} · revision ${r.revision}`, command: p => `${route} show ${r.id} page ${p} rev ${r.revision}` }), page).text;
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial), now = normalizeInstant(ctx.now.toISOString()), newId = randomUUID(), versionId = randomUUID();
  const save = (change: (state: State) => { record: Experiment; child?: string; evaluated?: boolean } | null, kind: "content" | "lifecycle" | "remove" = "content") => ctx.store.update("state", initial, raw => {
    const current = validate(raw), result = change(current); validate(current); if (kind !== "remove") admit(current, kind === "lifecycle");
    return { value: current, result: result ? result.evaluated ? summary(result.record) : `Saved privately: ${result.record.id} · revision ${result.record.revision}\nDesign: ${active(result.record).id}${result.child ? `\nObservation: ${result.child}` : ""}\nNext: ${route} show ${result.record.id}` : `Deleted privately.\nNext: ${route} list` };
  });
  const edit = (id: string, change: (r: Experiment) => string | void, kind: "content" | "lifecycle" | "remove" = "content", evaluated = false) => { const expected = get(s, id).revision; return save(state => { const r = get(state, id); assertRevision(r.revision, expected); const child = change(r); r.revision++; return { record: r, child: child || undefined, evaluated }; }, kind); };
  const fork = (r: Experiment, reason: string) => { const d = active(r); if (!d.lockedAt) throw new Error("Edit the current draft before creating another design version."); if (r.versions.length >= 3) throw new Error("Three retained design versions reached; start a separate experiment."); const next: Design = { ...d, id: versionId, createdAt: now, revisionReason: reason, lockedAt: null, observations: [], result: null }; r.versions.push(next); return next; };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) {
    const p = parsePage(m[1]), rows = [...s.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (!rows.length) return `No saved experiments.\nStart: ${metadata.example}`; if ((p - 1) * 10 >= rows.length) throw new Error(`Page out of range. Use ${route} list`);
    return `Current experiments ${(p - 1) * 10 + 1}–${Math.min(p * 10, rows.length)} of ${rows.length}\n` + rows.slice((p - 1) * 10, p * 10).map(r => `${r.id} · ${active(r).belief} · ${r.versions.length} designs, ${active(r).lockedAt ? "locked" : "draft"}`).join("\n") + `\n${p * 10 < rows.length ? `Next: ${route} list page ${p + 1}` : `Open: ${route} show ${rows[(p - 1) * 10].id}`}`;
  }
  if ((m = command.match(/^show (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) return render(get(s, m[1]), parsePage(m[2]), m[3]);
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Export exceeds 24576 bytes; use show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const r = get(s, m[1]); if (!m[2]) return `Delete experiment ${r.id}, all versions and observations?\n${route} delete ${r.id} confirm`; return save(state => { assertRevision(get(state, r.id).revision, r.revision); state.records = state.records.filter(x => x.id !== r.id); return null; }, "remove"); }
  if (command.startsWith("create ")) {
    const [belief, metricLabel, inputDirection, t, min, cap] = fields(command.slice(7), [120, 96, 16, 24, 8, 24]);
    const d: Design = { id: versionId, createdAt: now, revisionReason: null, belief, metricLabel, direction: direction(inputDirection), threshold: number(t), sampleMinimum: parseInteger(min, { min: 1, max: 20 }), effortCapMinutes: number(cap, 0.001), method: null, lockedAt: null, observations: [], result: null };
    const r: Experiment = { id: newId, revision: 1, createdAt: now, versions: [d] }; return save(state => { state.records.push(r); return { record: r }; });
  }
  if (command.startsWith("method ")) { const [id, method] = fields(command.slice(7), [36, 768]); const firstMethod = active(get(s, id)).method === null; return edit(id, r => { const d = active(r).lockedAt ? fork(r, "Changed method") : active(r); d.method = method; }, firstMethod ? "lifecycle" : "content"); }
  if ((m = command.match(/^lock (\S+)$/))) return edit(m[1], r => { const d = active(r); if (d.lockedAt) throw new Error("Design already locked; revise or edit to create a separate version."); if (!d.method) throw new Error(`Enter a test procedure first: ${route} method ${r.id} | Describe the procedure`); d.lockedAt = now; }, "lifecycle");
  if ((m = command.match(/^(observe|observe-edit) ([\s\S]+)$/))) {
    const verb = m[1], f = fields(m[2], verb === "observe" ? [36, 10, 24, 24, 256] : [36, 36, 10, 24, 24, 256]);
    const id = f[0], [inputDate, value, effort, inputNote] = f.slice(verb === "observe" ? 1 : 2), date = civilDate(inputDate), n = number(value), effortMinutes = number(effort, 0), note = inputNote === "-" ? null : inputNote;
    const before = get(s, id), existing = verb === "observe-edit" ? active(before).observations.find(o => o.id === f[1]) : null;
    const numericCompletion = note === null && (verb === "observe-edit" || active(before).observations.length < active(before).sampleMinimum);
    return edit(id, r => { const d = active(r); if (!d.lockedAt) throw new Error(`Lock the design before observations: ${route} lock ${r.id}`);
      if (verb === "observe") d.observations.push({ id: newId, date, value: n, effortMinutes, note, recordedAt: now });
      else { if (!existing) throw new Error("Observation not found in the current design."); const o = d.observations.find(o => o.id === existing.id)!; Object.assign(o, { date, value: n, effortMinutes, note, recordedAt: now }); }
      d.result = null; return verb === "observe" ? newId : f[1];
    }, numericCompletion ? "lifecycle" : "content");
  }
  if ((m = command.match(/^evaluate (\S+)$/))) return edit(m[1], r => { const d = active(r); if (!d.lockedAt) throw new Error(`Lock before evaluating: ${route} lock ${r.id}`); d.result = calculate(d, now); }, "lifecycle", true);
  if (command.startsWith("revise ")) { const [id, reason] = fields(command.slice(7), [36, 256]); return edit(id, r => { fork(r, reason); }); }
  if ((m = command.match(/^edit (\S+) (belief|metric|direction|threshold|sampleMinimum|effortCapMinutes|revisionReason) ([\s\S]+)$/))) {
    const [, id, field, input] = m, [value] = fields(input, [field === "belief" ? 120 : field === "metric" ? 96 : field === "revisionReason" ? 256 : 24]);
    const parsed = field === "direction" ? direction(value) : field === "threshold" ? number(value) : field === "sampleMinimum" ? parseInteger(value, { min: 1, max: 20 }) : field === "effortCapMinutes" ? number(value, 0.001) : value;
    return edit(id, r => { const d = active(r).lockedAt ? fork(r, `Changed ${field}`) : active(r);
      if (field === "belief") d.belief = parsed as string; else if (field === "metric") d.metricLabel = parsed as string; else if (field === "direction") d.direction = parsed as Design["direction"]; else if (field === "threshold") d.threshold = parsed as number; else if (field === "sampleMinimum") d.sampleMinimum = parsed as number; else if (field === "effortCapMinutes") d.effortCapMinutes = parsed as number; else d.revisionReason = parsed as string;
    });
  }
  if ((m = command.match(/^remove (\S+) (observation|note) (\S+) confirm$/))) { const [, id, kind, oid] = m; return edit(id, r => { const d = active(r), o = d.observations.find(o => o.id === oid); if (!o) throw new Error("Observation not found in the current design."); if (kind === "observation") d.observations = d.observations.filter(o => o.id !== oid); else o.note = null; d.result = null; }, "remove"); }
  if ((m = command.match(/^remove (\S+) (method|revisionReason) confirm$/))) { const [, id, field] = m; return edit(id, r => { const d = active(r); if (d.lockedAt) throw new Error("Revise the locked design first; archived designs stay immutable."); d[field as "method" | "revisionReason"] = null; }, "remove"); }
  throw new Error(`Unknown or incomplete command. Syntax: ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
