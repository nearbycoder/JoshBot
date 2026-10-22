import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./decision-journal.metadata.js";
import { boundedText, pipeFields, parseDecimal, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, dateInZone, normalizeInstant } from "./feature-kit/civil-time.js";
const route = "/nobo-help agent decision-journal";
const text = (max: number) => v.pipe(v.string(), v.check(s => { try { return boundedText(s, { label: "Text", maxBytes: max }) === s; } catch { return false; } }));
const instant = v.pipe(v.string(), v.check(s => { try { return normalizeInstant(s) === s; } catch { return false; } }));
const date = v.pipe(v.string(), v.check(s => { try { return civilDate(s) === s; } catch { return false; } }));
const idSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/));
const numeric = v.pipe(v.number(), v.minValue(-1_000_000), v.maxValue(1_000_000), v.check(n => Number.isFinite(n) && Math.abs(n * 1000 - Math.round(n * 1000)) < 0.00001));
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const expectation = v.strictObject({ id: idSchema, metric: text(96), predictedValue: numeric, unit: text(48) });
const outcome = v.strictObject({ id: idSchema, expectationId: idSchema, actualValue: numeric, date, recordedAt: instant });
const lesson = v.strictObject({ id: idSchema, text: text(768), recordedAt: instant });
const entrySchema = v.strictObject({ id: idSchema, revision, createdAt: instant, choice: text(120), rationale: text(768), reviewDate: date, lockedAt: v.nullable(instant), expectations: v.pipe(v.array(expectation), v.maxLength(8)), outcomes: v.pipe(v.array(outcome), v.maxLength(8)), lessons: v.pipe(v.array(lesson), v.maxLength(5)) });
type Entry = v.InferOutput<typeof entrySchema>;
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(entrySchema), v.maxLength(20)) });
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw); if (!p.success) throw new Error("Invalid saved decision data; nothing changed.");
  const ids: string[] = [];
  for (const r of p.output.records) {
    ids.push(r.id, ...r.expectations.map(x => x.id), ...r.outcomes.map(x => x.id), ...r.lessons.map(x => x.id));
    if (new Set(r.expectations.map(e => e.metric)).size !== r.expectations.length || new Set(r.outcomes.map(o => o.expectationId)).size !== r.outcomes.length || r.outcomes.some(o => !r.expectations.some(e => e.id === o.expectationId)) || (!r.lockedAt && (r.outcomes.length || r.lessons.length)) || (r.lockedAt && !r.expectations.length)) throw new Error("Invalid saved expectation/outcome relationship or lock; nothing changed.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved identities; nothing changed."); return p.output;
}
const envelope = (r: Entry) => ({ feature: metadata.id, version: 1, record: r });
function admit(s: State, lifecycle: boolean) {
  // One bounded outcome per expectation, including its own ID/date/time, is reserved.
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: Number.MAX_SAFE_INTEGER, lockedAt: "9999-12-31T23:59:59.999Z", outcomes: r.expectations.map(e => ({ id: "ffffffff-ffff-ffff-ffff-ffffffffffff", expectationId: e.id, actualValue: -999999.999, date: "9999-12-31", recordedAt: "9999-12-31T23:59:59.999Z" })) })) };
  assertQuota(s, { records: s.records.map(envelope), limits: { maxRecords: 20 }, ...(lifecycle ? { kind: "lifecycle" as const } : { kind: "content" as const, future: { value: future, records: future.records.map(envelope) } }) });
}
const fields = (input: string, sizes: number[]) => pipeFields(input, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32 }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i] }));
const number = (s: string) => { if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(s)) throw new Error("Use a plain number with at most 3 decimal places."); return parseDecimal(s, { min: -1_000_000, max: 1_000_000 }); };
const get = (s: State, id: string) => { const r = s.records.find(r => r.id === id); if (!r) throw new Error(`Decision not found. Use ${route} list`); return r; };
const unlocked = (r: Entry) => { if (r.lockedAt) throw new Error("Original reasoning and expectations are locked. Record a new decision for a changed prediction; outcomes and lessons stay separate."); };
const fmt = (n: number) => Number(n.toFixed(6)).toString();
function render(r: Entry, verb: "show" | "review", page: number, expected?: string) {
  if (expected) assertRevision(r.revision, Number(expected));
  const lines = verb === "show" ? JSON.stringify(envelope(r), null, 2).split(/(?<=\n)/) : [
    `Choice: ${r.choice}\nOriginal rationale: ${r.rationale}\nReview date: ${r.reviewDate}; ${r.lockedAt ? `locked ${r.lockedAt}` : "draft, not locked"}.\n`,
    ...r.expectations.flatMap(e => { const o = r.outcomes.find(o => o.expectationId === e.id); return [`Expectation ${e.id}: ${e.metric}\nPredicted ${e.predictedValue} ${e.unit}.\n`, o ? `Outcome ${o.id}: ${o.actualValue} ${e.unit}, measurement date ${o.date}, recorded ${o.recordedAt}.\nActual minus predicted: ${fmt(o.actualValue - e.predictedValue)} ${["percent", "%"].includes(e.unit) ? "percentage points" : e.unit}.\n` : `MISSING outcome for ${e.metric}.\n`]; }),
    ...r.lessons.map(l => `Later lesson ${l.id} (${l.recordedAt}): ${l.text}\n`),
    `These are entered expectations and outcomes, not evidence of causation. No hindsight rewrite of locked originals.\nNext: ${route} show ${r.id}\n`,
  ];
  return pageAt(paginateParts(lines.map(text => ({ text, atomic: true })), { mode: "plain", title: `Decision ${r.id} · revision ${r.revision}`, command: p => `${route} ${verb} ${r.id} page ${p} rev ${r.revision}` }), page).text;
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 }); if (command === "help") return metadata.help;
  const s = validate(await ctx.store.read("state") ?? initial), now = normalizeInstant(ctx.now.toISOString()), newId = randomUUID();
  const save = (change: (state: State) => { record: Entry; child?: string } | null, kind: "content" | "lifecycle" | "remove" = "content") => ctx.store.update("state", initial, raw => {
    const current = validate(raw), result = change(current); validate(current); if (kind !== "remove") admit(current, kind === "lifecycle");
    return { value: current, result: result ? `Saved privately: ${result.record.id} · revision ${result.record.revision}${result.child ? `\nChild: ${result.child}` : ""}\nNext: ${route} ${result.record.lockedAt ? "review" : "show"} ${result.record.id}` : `Deleted privately.\nNext: ${route} list` };
  });
  const edit = (id: string, change: (r: Entry) => string | void, kind: "content" | "lifecycle" | "remove" = "content") => { const expected = get(s, id).revision; return save(state => { const r = get(state, id); assertRevision(r.revision, expected); const child = change(r); r.revision++; return { record: r, child: child || undefined }; }, kind); };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^(list|due)(?: (?:page )?(\d+))?$/))) {
    const p = parsePage(m[2]), due = m[1] === "due", today = due ? dateInZone(ctx.now, ctx.timezone) : "";
    const rows = s.records.filter(r => !due || r.reviewDate <= today).sort((a, b) => (due ? a.reviewDate.localeCompare(b.reviewDate) : a.createdAt.localeCompare(b.createdAt)) || a.id.localeCompare(b.id));
    if (!rows.length) return `${due ? `No reviews due as of ${today} (${ctx.timezone}).` : "No saved decisions."}\nStart: ${metadata.example}`; if ((p - 1) * 10 >= rows.length) throw new Error(`Page out of range. Use ${route} ${m[1]}`);
    return `Current ${due ? `due reviews as of ${today} (${ctx.timezone})` : "decisions"} ${(p - 1) * 10 + 1}–${Math.min(p * 10, rows.length)} of ${rows.length}\n` + rows.slice((p - 1) * 10, p * 10).map(r => `${r.id} · ${r.choice} · ${r.reviewDate} · ${r.lockedAt ? "locked" : "draft"}, ${r.outcomes.length}/${r.expectations.length} outcomes`).join("\n") + `\n${p * 10 < rows.length ? `Next: ${route} ${m[1]} page ${p + 1}` : `Open: ${route} review ${rows[(p - 1) * 10].id}`}`;
  }
  if ((m = command.match(/^(show|review) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?$/))) return render(get(s, m[2]), m[1] as "show" | "review", parsePage(m[3]), m[4]);
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Export exceeds 24576 bytes; use show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const r = get(s, m[1]); if (!m[2]) return `Delete decision ${r.id}, expectations, outcomes and lessons?\n${route} delete ${r.id} confirm`; return save(state => { assertRevision(get(state, r.id).revision, r.revision); state.records = state.records.filter(x => x.id !== r.id); return null; }, "remove"); }
  if (command.startsWith("record ")) { const [choice, rationale, inputDate] = fields(command.slice(7), [120, 768, 10]); const r: Entry = { id: newId, revision: 1, createdAt: now, choice, rationale, reviewDate: civilDate(inputDate), lockedAt: null, expectations: [], outcomes: [], lessons: [] }; return save(state => { state.records.push(r); return { record: r }; }); }
  if (command.startsWith("expect ")) { const [id, metric, value, unit] = fields(command.slice(7), [36, 96, 24, 48]), predictedValue = number(value); return edit(id, r => { unlocked(r); if (r.expectations.some(e => e.metric === metric)) throw new Error("Metric already exists; use expect-edit with its ID."); r.expectations.push({ id: newId, metric, predictedValue, unit }); return newId; }); }
  if ((m = command.match(/^expect-edit (\S+) ([\s\S]+)$/))) { const [eid, metric, value, unit] = fields(m[2], [36, 96, 24, 48]), predictedValue = number(value); return edit(m[1], r => { unlocked(r); const e = r.expectations.find(e => e.id === eid); if (!e) throw new Error("Expectation not found."); Object.assign(e, { metric, predictedValue, unit }); return eid; }); }
  if ((m = command.match(/^lock (\S+)$/))) return edit(m[1], r => { unlocked(r); if (!r.expectations.length) throw new Error("Add at least one expectation before locking: expect DECISION | metric | value | unit"); r.lockedAt = now; }, "lifecycle");
  if (command.startsWith("outcome ")) { const [id, metric, value, unit, inputDate] = fields(command.slice(8), [36, 96, 24, 48, 10]), actualValue = number(value), date = civilDate(inputDate); return edit(id, r => {
    if (!r.lockedAt) throw new Error(`Lock expectations before recording outcomes: ${route} lock ${r.id}`);
    const e = r.expectations.find(e => e.metric === metric); if (!e) throw new Error("No locked expectation for that exact metric."); if (e.unit !== unit) throw new Error(`Unit must match the recorded unit exactly: ${e.unit}`);
    const existing = r.outcomes.find(o => o.expectationId === e.id); if (existing) { Object.assign(existing, { actualValue, date, recordedAt: now }); return existing.id; }
    r.outcomes.push({ id: newId, expectationId: e.id, actualValue, date, recordedAt: now }); return newId;
  }, "lifecycle"); }
  if (command.startsWith("lesson ")) { const [id, value] = fields(command.slice(7), [36, 768]); return edit(id, r => { if (!r.lockedAt) throw new Error("Lock the original decision before adding later lessons."); r.lessons.push({ id: newId, text: value, recordedAt: now }); return newId; }); }
  if ((m = command.match(/^lesson-edit (\S+) ([\s\S]+)$/))) { const [lid, value] = fields(m[2], [36, 768]); return edit(m[1], r => { const l = r.lessons.find(l => l.id === lid); if (!l) throw new Error("Lesson not found."); l.text = value; l.recordedAt = now; return lid; }); }
  if ((m = command.match(/^edit (\S+) (choice|rationale|reviewDate) ([\s\S]+)$/))) { const [, id, field, input] = m; const [value] = fields(input, [field === "choice" ? 120 : field === "rationale" ? 768 : 10]); const parsed = field === "reviewDate" ? civilDate(value) : value; return edit(id, r => { unlocked(r); r[field as "choice" | "rationale" | "reviewDate"] = parsed; }); }
  if ((m = command.match(/^remove (\S+) (expectation|outcome|lesson) (\S+) confirm$/))) { const [, id, kind, cid] = m; return edit(id, r => {
    if (kind === "expectation") { unlocked(r); if (!r.expectations.some(e => e.id === cid)) throw new Error("Expectation not found."); r.expectations = r.expectations.filter(e => e.id !== cid); }
    else if (kind === "outcome") { if (!r.outcomes.some(o => o.id === cid)) throw new Error("Outcome not found."); r.outcomes = r.outcomes.filter(o => o.id !== cid); }
    else { if (!r.lessons.some(l => l.id === cid)) throw new Error("Lesson not found."); r.lessons = r.lessons.filter(l => l.id !== cid); } return cid;
  }, "remove"); }
  throw new Error(`Unknown or incomplete command. Syntax: ${route} help`);
}
export default { ...metadata, execute } satisfies AgentFeature;
