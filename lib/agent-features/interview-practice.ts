import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, dateInZone, normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./interview-practice.metadata.js";

const MAX_RECORDS = 10;
const SECTIONS = ["situation", "task", "action", "result"] as const;
const TYPES = ["behavioral", "technical", "situational", "general"] as const;
const RATING_KEYS = ["clarity", "relevance", "evidence"] as const;
type Section = typeof SECTIONS[number];
type Attempt = { id: string; createdAt: string; text: string; questionText: string; questionType: typeof TYPES[number]; annotations: { section: Section; start: number; end: number }[]; ratings: Record<typeof RATING_KEYS[number], string> };
type Question = { id: string; text: string; type: typeof TYPES[number]; attempts: Attempt[] };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; answerSeconds: string; wordsPerMinute: string; questions: Question[] };
type State = { version: 1; records: RecordData[] };
const ratings = () => ({ clarity: "", relevance: "", evidence: "" });
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "answerSeconds", "wordsPerMinute", "questions"]); validBase(v);
  for (const key of ["answerSeconds", "wordsPerMinute"]) { validText(v[key], 3, true); if (v[key]) integer(v[key], key === "answerSeconds" ? 15 : 40, key === "answerSeconds" ? 600 : 300); }
  array(v.questions, 8);
  for (const q of v.questions) {
    object(q, ["id", "text", "type", "attempts"]); validId(q.id); validText(q.text, 1000); enumValue(q.type, TYPES); array(q.attempts, 2);
    for (const a of q.attempts) {
      object(a, ["id", "createdAt", "text", "questionText", "questionType", "annotations", "ratings"]); validId(a.id); if (normalizeInstant(a.createdAt) !== a.createdAt) throw new Error("Invalid instant.");
      validText(a.text, 8000, false, 2000); validText(a.questionText, 1000); enumValue(a.questionType, TYPES); array(a.annotations, 4);
      for (const mark of a.annotations) { object(mark, ["section", "start", "end"]); enumValue(mark.section, SECTIONS); validNumber(mark.start, 0, a.text.length - 1); validNumber(mark.end, mark.start + 1, a.text.length); if (!a.text.slice(mark.start, mark.end).isWellFormed() || !a.text.slice(mark.start, mark.end).trim()) throw new Error("Invalid exact span."); }
      unique(a.annotations.map((m: { section: string }) => m.section)); object(a.ratings, [...RATING_KEYS]);
      for (const key of RATING_KEYS) enumValue(a.ratings[key], ["", "0", "1", "2", "3", "4"]);
    }
  }
  unique(v.questions.flatMap((q: Question) => [q.id, ...q.attempts.map(a => a.id)]));
}
function projectLifecycle(s: State): State {
  // Reserve all four longest section keys with four-digit start/end coordinates,
  // all three one-digit self-ratings, and revision growth for every saved attempt.
  // Projection is a size bound (coordinates need not denote a real short answer).
  return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION, questions: r.questions.map(q => ({ ...q, attempts: q.attempts.map(a => ({ ...a, annotations: SECTIONS.map(section => ({ section, start: 1999, end: 2000 })), ratings: { clarity: "4", relevance: "4", evidence: "4" } })) })) })) };
}
function question(r: RecordData, id: string): Question { const q = r.questions.find(q => q.id === id); if (!q) fail("Question not found in this session."); return q; }
function attempt(r: RecordData, id: string): { q: Question; a: Attempt } { for (const q of r.questions) { const a = q.attempts.find(a => a.id === id); if (a) return { q, a }; } fail("Attempt not found in this session."); }
function review(r: RecordData, a: Attempt): string {
  const count = a.text.trim().split(/\s+/u).length, missing = SECTIONS.filter(s => !a.annotations.some(m => m.section === s));
  const seconds = r.wordsPerMinute ? count * 60 / Number(r.wordsPerMinute) : null;
  const lines = [`${r.id} · ${r.title}`, `Attempt ${a.id} · ${a.createdAt}`, `Question snapshot (${a.questionType}): ${a.questionText}`, `Answer: ${a.text}`, `${count} whitespace-delimited words. ${seconds === null ? "Speaking-time estimate unknown: words/minute cleared." : `Approximate speaking-time estimate: ${seconds.toFixed(1)} seconds at ${r.wordsPerMinute} words/minute; not measured duration.`}`, `Target: ${r.answerSeconds || "unknown"} seconds.${seconds !== null && r.answerSeconds ? ` Estimated difference ${(seconds - Number(r.answerSeconds)).toFixed(1)} seconds (estimate − target).` : ""}`, "STAR coverage is based only on your exact annotations:"];
  for (const s of SECTIONS) { const m = a.annotations.find(m => m.section === s); lines.push(`${s}: ${m ? `[${m.start},${m.end}) “${a.text.slice(m.start, m.end)}”` : "missing annotation"}`); }
  lines.push(`Missing sections: ${missing.join(", ") || "none"}.`, missing.length ? `Next practice prompt: add an exact ${missing[0]} span if your answer contains one; otherwise revise with your own facts.` : "All four sections are annotated; annotation is not proof of achievement.", `User self-ratings (0–4; unknown stays unknown): ${RATING_KEYS.map(k => `${k} ${a.ratings[k] || "unknown"}`).join(", ")}.`, "No hiring outcome, official score or employer fact inferred.");
  return lines.join("\n");
}
const CRITIQUES = { structure: "Review whether your annotated sections form a clear sequence.", specificity: "Check whether your own evidence supports the detail you chose.", relevance: "Check the connection to the entered question; no employer expectations were researched.", timing: "Rehearse aloud to check the approximate word-based timing." } as const;
const FOLLOWUPS = { situation: "What situation would you describe in your own words?", task: "What responsibility did you personally have?", action: "Which actions did you personally take, and which belonged to collaborators?", result: "What result can you support with your own evidence, including uncertainty?" } as const;
async function coach(context: AgentFeatureContext, id: string, aid: string): Promise<string> {
  const r = find(await read(context), id), { q, a } = attempt(r, aid);
  const render = (p: { quote: string; critique: keyof typeof CRITIQUES; followUp: Section }) => `Unsaved practice suggestion · ${a.id}\nSource question ${q.id}; exact attempt quote: “${p.quote}”\nSuggested critique: ${CRITIQUES[p.critique]}\nFollow-up question: ${FOLLOWUPS[p.followUp]}\nThese are prompts for your own factual revision, not candidate achievements or a hiring score.\nNext: ${ROUTE} review ${id} ${aid}`;
  const quoteChoices = Array.from(a.text).filter(ch => ch.trim());
  const quote = quoteChoices.reduce((best, ch) => JSON.stringify(ch).length < JSON.stringify(best).length ? ch : best);
  const shortestDisplayQuote = quoteChoices.reduce((best, ch) => ch.length < best.length ? ch : best);
  const variants = Object.keys(CRITIQUES).flatMap(critique => SECTIONS.map(followUp => ({ questionId: q.id, attemptId: a.id, quote, critique: critique as keyof typeof CRITIQUES, followUp })));
  const input = JSON.stringify({ role: r.title, targetSeconds: r.answerSeconds, wordsPerMinute: r.wordsPerMinute, questionId: q.id, attempt: a });
  const instructions = 'Return exact JSON {questionId,attemptId,quote,critique,followUp}. IDs must match input. quote must be a nonblank exact answer substring, at most 500 string units. critique is structure|specificity|relevance|timing. followUp is situation|task|action|result. No other keys or prose. The renderer supplies finite coaching questions; do not invent candidate or employer claims.';
  if (Math.min(...variants.map(p => render({ ...p, quote: shortestDisplayQuote }).length)) > 3500 || Math.min(...variants.map(p => JSON.stringify(p).length)) > 4000 || Buffer.byteLength(input) > 16000) fail(`This complete coaching request cannot fit. Shorten the answer or use review ${id} ${aid}; no model call was made.`);
  if (Buffer.byteLength(instructions) > 4000) fail("Assistance instructions exceed capacity; use review.");
  const raw = await context.services.generate({ instructions, input }); context.signal?.throwIfAborted();
  if (stamp(find(await read(context), id)) !== stamp(r)) fail("Session changed while coaching ran; unsaved output discarded. Reopen the attempt.");
  let p: any;
  try {
    if (typeof raw !== "string" || raw.length > 4000 || !raw.isWellFormed()) throw new Error();
    p = JSON.parse(raw); object(p, ["questionId", "attemptId", "quote", "critique", "followUp"]);
    if (p.questionId !== q.id || p.attemptId !== a.id) throw new Error(); validText(p.quote, 2000, false, 500); if (!a.text.includes(p.quote)) throw new Error();
    enumValue(p.critique, Object.keys(CRITIQUES)); enumValue(p.followUp, SECTIONS); if (render({ quote: p.quote, critique: p.critique, followUp: p.followUp }).length > 3500) throw new Error();
  } catch { fail(`Invalid coaching output; nothing was saved. Use review ${id} ${aid} or explicitly request coaching again.`); }
  return render({ quote: p.quote, critique: p.critique, followUp: p.followUp });
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [title, secs, wpm] = fields(rest, 160, 3, 3); integer(secs, 15, 600, "Target seconds"); integer(wpm, 40, 300, "Words/minute");
    const r: RecordData = { ...base(context, "session", text(title, "Role", 160)), answerSeconds: secs, wordsPerMinute: wpm, questions: [] };
    return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Role and timing assumptions saved. Add your own question."); });
  }
  if (verb === "edit" || verb === "clear") {
    const v = verb === "edit" ? fields(rest, 80, 20, 160) : words(rest, 3), [id, key] = v, clear = verb === "clear";
    if (clear && v[2] !== "confirm") fail("Use clear SESSION FIELD confirm.");
    return mutate(context, id, (_, r) => { if (key === "title") r!.title = text(clear ? "" : v[2], "Role", 160, clear); else if (key === "answerSeconds" || key === "wordsPerMinute") { if (!clear) integer(v[2], key === "answerSeconds" ? 15 : 40, key === "answerSeconds" ? 600 : 300); r![key] = clear ? "" : v[2]; } else fail("Fields: title, answerSeconds, wordsPerMinute."); return saved(id, "Session field updated. Timing remains an estimate; cleared settings are unknown."); }, clear ? "remove" : "content");
  }
  if (verb === "question") {
    const m = /^(\S+)\s+(add|edit|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use question SESSION add TEXT | TYPE, edit QUESTION | TEXT | TYPE, or remove QUESTION confirm.");
    const [, id, mode, input] = m;
    if (mode === "remove") { const [qid, confirm] = words(input, 2); if (confirm !== "confirm") fail("Question removal requires confirm."); return mutate(context, id, (_, r) => { question(r!, qid); r!.questions = r!.questions.filter(q => q.id !== qid); return saved(id, "Question and its attempts removed."); }, "remove"); }
    const v = fields(input, ...(mode === "add" ? [1000, 16] : [80, 1000, 16])), content = text(v[mode === "add" ? 0 : 1], "Question"), type = enumValue(v.at(-1), TYPES), qid = mode === "add" ? `question-${randomUUID()}` : v[0];
    return mutate(context, id, (_, r) => { if (mode === "add") { if (r!.questions.length >= 8) fail("Maximum 8 questions. Remove one explicitly first."); r!.questions.push({ id: qid, text: content, type, attempts: [] }); } else { const q = question(r!, qid); q.text = content; q.type = type; } return saved(id, `Question ${qid} saved. Existing attempts keep their original question snapshot.`); });
  }
  if (verb === "answer" || verb === "revise") {
    const [head, value] = fields(rest, 170, 8000), [id, child] = words(head, 2), content = text(value, "Answer", 8000, false, 2000), aid = `attempt-${randomUUID()}`, createdAt = context.now.toISOString();
    return mutate(context, id, (_, r) => { const q = verb === "answer" ? question(r!, child) : attempt(r!, child).q; if (q.attempts.length >= 2) fail("Maximum 2 attempts per question. Export/show then explicitly remove one before another revision."); q.attempts.push({ id: aid, createdAt, text: content, questionText: q.text, questionType: q.type, annotations: [], ratings: ratings() }); return saved(id, `Distinct attempt ${aid} saved. No annotations or ratings were copied.`, `review ${id} ${aid}`); });
  }
  if (verb === "attempt-edit") {
    const [head, value] = fields(rest, 170, 8000), [id, aid] = words(head, 2), content = text(value, "Answer", 8000, false, 2000);
    return mutate(context, id, (_, r) => { const { a } = attempt(r!, aid); a.text = content; a.annotations = []; a.ratings = ratings(); return saved(id, "Attempt text updated; exact annotations and dependent self-ratings cleared.", `review ${id} ${aid}`); });
  }
  if (verb === "attempt-remove") {
    const [id, aid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Attempt removal requires confirm.");
    return mutate(context, id, (_, r) => { const { q } = attempt(r!, aid); q.attempts = q.attempts.filter(a => a.id !== aid); return saved(id, "Attempt, annotations and self-ratings removed."); }, "remove");
  }
  if (verb === "annotate" || verb === "annotate-span") {
    const v = fields(rest, ...(verb === "annotate" ? [170, 9, 8000] : [170, 9, 4, 4])), [id, aid] = words(v[0], 2), section = enumValue(v[1], SECTIONS);
    return mutate(context, id, (_, r) => {
      const { a } = attempt(r!, aid); let start: number, end: number;
      if (verb === "annotate") { const quote = text(v[2], "Exact span", 8000, false, 2000); start = a.text.indexOf(quote); if (start < 0) fail("Annotation must be an exact current answer span."); if (a.text.indexOf(quote, start + 1) >= 0) fail("Span occurs more than once; use annotate-span with explicit UTF-16 start/end offsets."); end = start + quote.length; }
      else { start = integer(v[2], 0, a.text.length - 1); end = integer(v[3], start + 1, a.text.length); if (!a.text.slice(start, end).isWellFormed() || !a.text.slice(start, end).trim()) fail("Choose a nonblank span with complete Unicode characters."); }
      a.annotations = a.annotations.filter(m => m.section !== section); a.annotations.push({ section, start, end }); return saved(id, `Exact ${section} span saved; no missing result was inferred.`, `review ${id} ${aid}`);
    }, "lifecycle");
  }
  if (verb === "rate") {
    const [head, key, level] = fields(rest, 170, 9, 1), [id, aid] = words(head, 2), rating = enumValue(key, RATING_KEYS); integer(level, 0, 4);
    return mutate(context, id, (_, r) => { attempt(r!, aid).a.ratings[rating] = level; return saved(id, "User self-rating saved; this is not an official score.", `review ${id} ${aid}`); }, "lifecycle");
  }
  if (verb === "annotation-remove" || verb === "rating-remove") {
    const [id, aid, key, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Removal requires confirm.");
    return mutate(context, id, (_, r) => { const { a } = attempt(r!, aid); if (verb === "annotation-remove") { enumValue(key, SECTIONS); a.annotations = a.annotations.filter(m => m.section !== key); } else a.ratings[enumValue(key, RATING_KEYS)] = ""; return saved(id, "Selected annotation/self-rating removed.", `review ${id} ${aid}`); }, "remove");
  }
  if (verb === "review") { const args = words(rest, 2, 5), r = find(await read(context), args[0]), { a } = attempt(r, args[1]); return report(review(r, a), `review ${r.id} ${a.id}`, r, args.slice(2)); }
  if (verb === "coach") { const [id, aid] = words(rest, 2); return coach(context, id, aid); }
  fail("Unknown command. Use help for supported grammar.");
}

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
function validId(value: unknown): void {
  if (typeof value !== "string" || !/^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid ID.");
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
    if (typeof value !== "string" || checked(() => normalizeInstant(value)) !== value || !/^\d{4}-.*\.\d{3}Z$/.test(value)) throw new Error("Invalid saved instant.");
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
    const limits = { maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: MAX_RECORDS };
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
  kind: "content" | "lifecycle" | "remove" = "content", expected?: RecordData): Promise<string> {
  const intended = id === undefined ? undefined : JSON.stringify(expected ?? find(await read(context), id));
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, raw => {
    const s = structuredClone(decode(raw)), r = id === undefined ? undefined : find(s, id);
    if (r && JSON.stringify(r) !== intended) fail(`This item changed; inspect it before retrying: ${ROUTE} show ${id}`);
    if (r && r.revision === MAX_REVISION && kind !== "remove") fail("Revision limit reached. Export/show, then delete this whole record and create a new one; edits and lifecycle writes are unavailable.");
    const reply = change(s, r);
    if (s.records.length > MAX_RECORDS) fail(`Maximum ${MAX_RECORDS} records. Use list, then delete ID confirm to free space.`);
    if (r && s.records.includes(r)) {
      if (kind !== "remove") { r.revision++; r.updatedAt = timestamp; }
      // Removal is content-stamped. Keeping the clock prevents byte-growing numeric
      // rollover from blocking a one-byte deletion, including at the revision ceiling.
    }
    decode(s);
    if (kind === "remove") {
      if (serializedBytes(s) >= serializedBytes(raw)) fail("Nothing was removed. Choose a populated field or an existing child; removal must reduce saved bytes.");
    } else {
      quota(s, kind);
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
  const pattern = /(?:[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolbox:goals:[A-Za-z0-9_.:-]+|e1:[a-f0-9]{64})/g;
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
    }, "remove");
  }
  return undefined;
}
export default {
  ...metadata,
  async execute(command: string, context: AgentFeatureContext): Promise<string> {
    if (!command.trim() || command.trim() === "help") return metadata.help;
    try {
      text(command, "Command", 16_000); context.signal?.throwIfAborted();
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim())!;
      return await common(match[1], match[2] ?? "", context) ?? await executeDomain(match[1], match[2] ?? "", context);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof CommandError) return `${error.message}\nNext: ${ROUTE} help`;
      return `This command could not be completed safely. Any dispatched save may have completed; inspect your private records before repeating it.\nNext: ${ROUTE} list`;
    }
  },
} satisfies AgentFeature;
