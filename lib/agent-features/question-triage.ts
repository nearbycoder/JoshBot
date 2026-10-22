import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import metadata from "./question-triage.metadata.js";
import { boundedText, pipeFields, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertRevision, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, dateInZone } from "./feature-kit/civil-time.js";
const route = "/nobo-help agent question-triage", MAX_REV = 999_999_999;
const id = v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const text = (bytes: number, empty = false) => v.pipe(v.string(), v.check(s => { try { boundedText(s, { label: "Text", maxBytes: bytes, trim: false, allowEmpty: empty }); return empty || !!s.trim(); } catch { return false; } }));
const kind = v.picklist(["blocking", "optional"]);
const answer = v.strictObject({ text: text(256), sourceLabel: text(128), reviewDate: v.nullable(v.pipe(v.string(), v.check(s => { try { return civilDate(s) === s; } catch { return false; } }))), stale: v.boolean() });
const challenge = v.strictObject({ id, note: text(128) });
const question = v.strictObject({ id, question: text(320), kind, consequence: text(256), acceptableEvidence: text(256, true), answer: v.nullable(answer), challenges: v.pipe(v.array(challenge), v.maxLength(3)) });
const record = v.strictObject({ id, decision: text(160), revision: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_REV)), questions: v.pipe(v.array(question), v.maxLength(24)) });
const schema = v.strictObject({ version: v.literal(1), records: v.pipe(v.array(record), v.maxLength(12)) });
type Board = v.InferOutput<typeof record>;
type Question = v.InferOutput<typeof question>;
type State = v.InferOutput<typeof schema>;
const initial: State = { version: 1, records: [] };
const envelope = (r: Board) => ({ feature: metadata.id, version: 1, record: r });
function validate(raw: unknown): State {
  assertStateVersion(raw, 1); const p = v.safeParse(schema, raw);
  if (!p.success) throw new Error("Invalid saved question fields; data preserved. Ask the operator for scoped recovery.");
  const ids = p.output.records.flatMap(r => [r.id, ...r.questions.flatMap(q => [q.id, ...q.challenges.map(c => c.id)])]);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved IDs; data preserved.");
  return p.output;
}
function quota(s: State, content: boolean) {
  // All admitted questions reserve a full answer/source/review date and all three
  // challenge slots. Optional criteria/wording changes are new content. Maximum
  // escaped bytes, UUID width and revision width are included, not just a margin.
  const future = { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REV, questions: r.questions.map(q => ({ ...q, answer: { text: '"'.repeat(256), sourceLabel: '"'.repeat(128), reviewDate: "9999-12-31", stale: false }, challenges: Array.from({ length: 3 }, () => ({ id: "00000000-0000-4000-8000-000000000000", note: '"'.repeat(128) })) })) })) };
  assertQuota(s, content ? { kind: "content", records: s.records.map(envelope), future: { value: future, records: future.records.map(envelope) } } : { kind: "lifecycle", records: s.records.map(envelope) });
  assertQuota(future, { kind: "lifecycle", records: future.records.map(envelope) });
  for (const r of s.records) render(r, "show", JSON.stringify(envelope(r), null, 2), 1);
}
const fields = (s: string, sizes: number[], empty = false) => pipeFields(s, sizes.map(maxBytes => ({ label: "Field", maxBytes: maxBytes + 32, allowEmpty: empty }))).map((s, i) => boundedText(s, { label: "Field", maxBytes: sizes[i], allowEmpty: empty }));
const get = (s: State, key: string) => { const r = s.records.find(r => r.id === key); if (!r) throw new Error(`Item not found in your private records. Use ${route} list`); return r; };
const getQuestion = (r: Board, key: string) => { const q = r.questions.find(q => q.id === key); if (!q) throw new Error("Question not found; inspect show for full IDs."); return q; };
function render(r: Board, verb: string, body: string, page: number, expected?: string, today?: string) {
  if ((page > 1 && !expected) || (expected !== undefined && String(r.revision) !== expected)) throw new Error(`Board changed or revision missing. Restart: ${route} ${verb} ${r.id} page 1`);
  return pageAt(paginateParts(body.split(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g).map((text, i) => ({ text, atomic: i % 2 === 1 })), { mode: "plain", title: `Question board ${r.id} · revision ${r.revision}${today ? ` · as of ${today}` : ""}`, command: p => `${route} ${verb} ${r.id} page ${p} rev ${r.revision}${today ? ` as-of ${today}` : ""}` }), page).text;
}
function status(q: Question) {
  if (q.challenges.length) return "challenged (uncertainty reopened)";
  if (!q.answer) return "unanswered";
  if (q.answer.stale) return "stale answer (requirements changed)";
  if (!q.acceptableEvidence.trim()) return "answer recorded; evidence criterion missing, unresolved";
  return "answered against user-defined criterion; user report, not verified";
}
function queue(r: Board, today: string) {
  const rank = (q: Question) => q.kind === "blocking" && (!q.answer || q.answer.stale || q.challenges.length || !q.acceptableEvidence.trim()) ? 0 : q.answer?.reviewDate ? 1 : !q.answer || q.challenges.length || q.answer.stale || !q.acceptableEvidence.trim() ? 2 : 3;
  const questions = r.questions.map((q, index) => ({ q, index })).sort((a, b) => rank(a.q) - rank(b.q) || (rank(a.q) === 1 ? a.q.answer!.reviewDate!.localeCompare(b.q.answer!.reviewDate!) : 0) || a.index - b.index);
  return `Decision: ${r.decision}\nReview as of civil date ${today}. Blocking uncertainty first, dated reviews next (earliest first), optional uncertainty, then answered/no dated review. No unknown review date is invented.\n` + questions.map(({ q }) => `${q.id} · ${q.kind} · ${status(q)}\nQuestion: ${q.question}\nConsequence: ${q.consequence}\nEvidence request: ${q.acceptableEvidence || "MISSING — define acceptable evidence before treating an answer as resolved"}\n${q.answer ? `Prior/current answer: ${q.answer.text}\nUser source label: ${q.answer.sourceLabel}\nReview: ${q.answer.reviewDate ?? "unknown"}${q.answer.reviewDate ? q.answer.reviewDate <= today ? " (due)" : " (upcoming)" : ""}\n` : "Answer: none\n"}${q.challenges.map(c => `Challenge ${c.id}: ${c.note}\n`).join("")}`).join("\n");
}
async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  boundedText(command, { label: "Command", maxBytes: 16000 });
  const s = validate(await ctx.store.read("state") ?? initial), newId = randomUUID();
  const save = (key: string | undefined, change: (s: State, r?: Board) => string, content = true) => {
    const expected = key === undefined ? undefined : get(s, key).revision;
    return ctx.store.update("state", initial, raw => {
      const state = validate(raw), r = key === undefined ? undefined : get(state, key); if (r) assertRevision(r.revision, expected);
      const detail = change(state, r); if (r && state.records.includes(r)) r.revision++;
      validate(state); quota(state, content);
      return { value: state, result: `${detail}\nNext: ${route} ${key && state.records.some(r => r.id === key) ? `queue ${key}` : "list"}` };
    });
  };
  let m: RegExpMatchArray | null;
  if ((m = command.match(/^list(?: (?:page )?(\d+))?$/))) { const p = parsePage(m[1]), total = Math.max(1, Math.ceil(s.records.length / 10)); if (p > total) throw new Error(`Restart: ${route} list 1`); return `Private current list · ${p}/${total}\n${s.records.slice((p - 1) * 10, p * 10).map(r => `${r.id} · ${r.decision.replace(/[\r\n]/g, " ")} · revision ${r.revision}`).join("\n") || `No boards. Start: ${metadata.example}`}\n${p < total ? `Next: ${route} list ${p + 1}` : ""}`; }
  if ((m = command.match(/^(show|queue) (\S+)(?: (?:page )?(\d+))?(?: rev (\d+))?(?: as-of (\S+))?$/))) { const [, verb, key, p, rev, date] = m, r = get(s, key); if (verb === "show" && date) throw new Error("as-of applies only to queue."); const today = date ? civilDate(date) : dateInZone(ctx.now, ctx.timezone); if (verb === "queue" && parsePage(p) > 1 && !date) throw new Error(`Review date missing; restart: ${route} queue ${key} page 1`); return render(r, verb, verb === "show" ? JSON.stringify(envelope(r), null, 2) : queue(r, today), parsePage(p), rev, verb === "queue" ? today : undefined); }
  if ((m = command.match(/^export (\S+)$/))) { const out = envelope(get(s, m[1])); if (serializedBytes(out) > 24576) throw new Error("Record exceeds export limit; use show pages."); return JSON.stringify(out); }
  if ((m = command.match(/^delete (\S+)(?: (confirm))?$/))) { const key = get(s, m[1]).id; if (!m[2]) return `Delete board and all questions/answers/challenges: ${route} delete ${key} confirm`; return save(key, state => { state.records = state.records.filter(r => r.id !== key); return `Deleted privately: ${key}`; }, false); }
  if (command.startsWith("create ")) { const [decision] = fields(command.slice(7), [160]); return save(undefined, state => { state.records.push({ id: newId, decision, revision: 1, questions: [] }); return `Saved privately: ${newId}\nInspect: ${route} queue ${newId}`; }); }
  if ((m = command.match(/^edit (\S+)\s*\|([\s\S]+)$/))) { const [, key, input] = m, [decision] = fields(input, [160]); return save(key, (_, r) => { if (r!.decision !== decision) for (const q of r!.questions) if (q.answer) q.answer.stale = true; r!.decision = decision; return `Updated decision: ${key}. Changed decisions mark existing answers stale.`; }); }
  if ((m = command.match(/^ask (\S+) (add|edit) ([\s\S]+)$/))) {
    const [, key, action, input] = m, f = fields(input, action === "add" ? [320, 8, 256] : [36, 320, 8, 256]), qid = action === "edit" ? f.shift()! : newId;
    if (!v.is(kind, f[1])) throw new Error("Question kind must be blocking or optional."); const priority = f[1];
    return save(key, (_, r) => { if (action === "add") { if (r!.questions.length === 24) throw new Error("Maximum 24 questions; remove one explicitly."); r!.questions.push({ id: qid, question: f[0], kind: priority, consequence: f[2], acceptableEvidence: "", answer: null, challenges: [] }); } else { const q = getQuestion(r!, qid); if ((q.question !== f[0] || q.consequence !== f[2]) && q.answer) q.answer.stale = true; Object.assign(q, { question: f[0], kind: priority, consequence: f[2] }); } return `Saved question: ${qid}. Changed wording/consequences mark the prior answer stale.`; });
  }
  if ((m = command.match(/^evidence-needed (\S+) ([\s\S]+)$/))) { const [, key, input] = m, [qid, criterion] = fields(input, [36, 256]); return save(key, (_, r) => { const q = getQuestion(r!, qid); if (q.acceptableEvidence !== criterion && q.answer) q.answer.stale = true; q.acceptableEvidence = criterion; return `Saved evidence criterion for ${qid}. Existing answers need explicit re-reporting after a change.`; }); }
  if ((m = command.match(/^(answer|answer-edit) (\S+) ([\s\S]+)$/))) { const [, action, key, input] = m, [qid, value, label, date] = fields(input, [36, 256, 128, 10]), reviewDate = date === "unknown" ? null : civilDate(date); return save(key, (_, r) => { const q = getQuestion(r!, qid); if ((action === "answer") !== (q.answer === null)) throw new Error("Use answer for a first report, answer-edit to explicitly replace/reaffirm it."); q.answer = { text: value, sourceLabel: label, reviewDate, stale: false }; return `Saved user-reported answer for ${qid}; criteria and challenges remain visible. ${status(q)}`; }, false); }
  if ((m = command.match(/^(challenge|challenge-edit) (\S+) ([\s\S]+)$/))) { const [, action, key, input] = m, f = fields(input, action === "challenge" ? [36, 128] : [36, 36, 128]), qid = f.shift()!, cid = action === "challenge-edit" ? f.shift()! : newId; return save(key, (_, r) => { const q = getQuestion(r!, qid); if (action === "challenge") { if (q.challenges.length === 3) throw new Error("Maximum three challenges; edit or explicitly remove a note."); q.challenges.push({ id: cid, note: f[0] }); } else { const c = q.challenges.find(c => c.id === cid); if (!c) throw new Error("Challenge not found."); c.note = f[0]; } return `Saved challenge: ${cid}. Prior answer/source retained; uncertainty reopened.`; }, false); }
  if ((m = command.match(/^remove (\S+) (question|evidence|answer|challenge) (\S+) confirm$/))) { const [, key, kind, child] = m; return save(key, (_, r) => { if (kind === "challenge") { const q = r!.questions.find(q => q.challenges.some(c => c.id === child)); if (!q) throw new Error("Challenge not found."); q.challenges = q.challenges.filter(c => c.id !== child); } else { const q = getQuestion(r!, child); if (kind === "question") r!.questions = r!.questions.filter(q => q.id !== child); else if (kind === "answer") q.answer = null; else { q.acceptableEvidence = ""; if (q.answer) q.answer.stale = true; } } return `Removed ${kind}: ${child}. Other evidence is retained.`; }, false); }
  throw new Error(`Unknown/incomplete command. Use ${route} help`);
}
export default { ...metadata, async execute(command, ctx) { try { return await execute(command, ctx); } catch (error) { ctx.signal?.throwIfAborted(); return `${error instanceof Error ? error.message : "Command failed safely; inspect before retrying."}\nNext: ${route} help`; } } } satisfies AgentFeature;
