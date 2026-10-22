import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, dateInZone, normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./achievement-portfolio.metadata.js";

const MAX_RECORDS = 20;
type Evidence = { id: string; label: string; text: string };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; challenge: string; action: string; result: string; metric: { value: string; unit: string; baseline: string }; collaborators: string; privacy: string; evidence: Evidence[] };
type State = { version: 1; records: RecordData[] };
const TEXT_FIELDS = ["title", "challenge", "action", "result", "collaborators", "privacy"] as const;
function metricNumber(v: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(v) || /^-0(?:\.0+)?$/.test(v)) fail("Metric must be a plain decimal with up to 12 integer and 6 fractional digits, without negative zero.");
  const neg = v.startsWith("-"), [whole, fractional = ""] = (neg ? v.slice(1) : v).split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"))) * (neg ? -1n : 1n);
}
function decimal(n: bigint): string { const sign = n < 0n ? "-" : "", v = n < 0n ? -n : n; return sign + `${v / 1_000_000n}.${String(v % 1_000_000n).padStart(6, "0")}`.replace(/\.?0+$/, ""); }
function measurement(r: RecordData): string {
  const m = r.metric;
  if (!m.value || !m.unit) return "User measurement: incomplete; value/unit not both supplied. No metric inferred.";
  if (!m.baseline) return `User measurement: ${m.value} ${m.unit}; baseline unknown. No change inferred.`;
  const end = metricNumber(m.value), start = metricNumber(m.baseline), delta = end - start, magnitude = delta < 0n ? -delta : delta;
  let percent = "Percentage unknown: zero baseline.";
  if (start !== 0n) {
    const denominator = start < 0n ? -start : start, scaled = (magnitude * 10_000n + denominator / 2n) / denominator;
    percent = `${scaled / 100n}${scaled % 100n ? `.${String(scaled % 100n).padStart(2, "0")}` : ""}% using denominator |${m.baseline}|; rounded to 0.01 percentage points.`;
  }
  return `User measurement: ${m.baseline} → ${m.value} ${m.unit}. ${delta < 0n ? "Decrease" : delta > 0n ? "Increase" : "Change"}: ${decimal(magnitude)} ${m.unit}; ${percent} Entered measurement, not proof of causation.`;
}
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "challenge", "action", "result", "metric", "collaborators", "privacy", "evidence"]); validBase(v);
  for (const key of TEXT_FIELDS.filter(k => k !== "title")) validText(v[key], 1000, true);
  object(v.metric, ["value", "unit", "baseline"]); validText(v.metric.unit, 160, true);
  for (const key of ["value", "baseline"]) { validText(v.metric[key], 20, true); if (v.metric[key]) metricNumber(v.metric[key]); }
  array(v.evidence, 8);
  for (const e of v.evidence) { object(e, ["id", "label", "text"]); validId(e.id, "evidence"); validText(e.label, 160); validText(e.text, 2000, false, 500); }
  unique(v.evidence.map((e: Evidence) => e.id));
}
function projectLifecycle(s: State): State {
  // Stories and optional rewrites are unsaved; no model preview/history is retained.
  // All user-authored fields are new content. Only numeric revision growth remains.
  return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION })) };
}
function story(r: RecordData, layout = "challenge-first", audience?: string): string {
  const sections: Record<string, string> = { challenge: `Challenge (entered): ${r.challenge || "missing"}`, action: `Personal action (entered): ${r.action || "missing"}`, result: `Result (entered): ${r.result || "missing"}` };
  const order = layout === "action-first" ? ["action", "challenge", "result"] : layout === "result-first" ? ["result", "challenge", "action"] : ["challenge", "action", "result"];
  const lines = [audience ? `Unsaved ${audience} structural rewrite · review attribution and metrics before use.` : "Deterministic accomplishment story · entered facts", `${r.id} · ${r.title}`, ...order.map(k => sections[k]), measurement(r), `Collaborators / team contribution (entered): ${r.collaborators || "not supplied; attribution incomplete"}`, `Privacy note (entered): ${r.privacy || "not supplied"}`];
  if (r.evidence.length) for (const e of r.evidence) lines.push(`Evidence ${e.id} · ${e.label}: ${e.text}`);
  const missing = [!r.challenge && "challenge", !r.action && "personal action", !r.result && "result", !r.evidence.length && "evidence", !r.collaborators && "collaborator attribution"].filter(Boolean);
  lines.push(`Missing: ${missing.join(", ") || "none of the core story fields"}. No independently verified impact or causal link is asserted.`);
  return lines.join("\n");
}
const LAYOUTS = ["action-first", "challenge-first", "result-first"] as const;
async function polish(context: AgentFeatureContext, id: string, audience: string): Promise<string> {
  enumValue(audience, ["review", "resume"]);
  const r = find(await read(context), id);
  if (!r.action || !r.result || !r.challenge || !r.evidence.length) fail(`Add challenge, personal action, result and at least one evidence excerpt before polish. Use story ${id} to see missing fields.`);
  const render = (layout: string) => story(r, layout, audience) + `\nNext: ${ROUTE} story ${id}`;
  // All allowed layouts have renderer-owned factual sections. Account for the true
  // shortest complete reply and complete JSON output; no prose/quote check loophole.
  const minimumReply = Math.min(...LAYOUTS.map(layout => render(layout).length));
  const minimumRaw = Math.min(...LAYOUTS.map(layout => JSON.stringify({ layout, evidenceIds: r.evidence.map(e => e.id) }).length));
  const instructions = 'Choose only an audience-appropriate structure. Return exactly JSON {"layout":"action-first"|"challenge-first"|"result-first","evidenceIds":[all supplied evidence IDs once]}. No additional keys, prose, facts or wording. All factual text is rendered unchanged by the application.';
  const input = JSON.stringify({ audience, record: r });
  if (minimumReply > 3500 || minimumRaw > 4000 || Buffer.byteLength(input) > 16000) fail(`This complete rewrite cannot fit the assistance limits. Shorten entered fields/evidence or use paginated story ${id}; no model call was made.`);
  if (Buffer.byteLength(instructions) > 4000) fail("Assistance instructions exceed capacity; use story.");
  const raw = await context.services.generate({ instructions, input });
  context.signal?.throwIfAborted();
  const fresh = find(await read(context), id); if (stamp(fresh) !== stamp(r)) fail("This achievement changed while assistance ran; the unsaved output was discarded. Reopen story before trying again.");
  let parsed: any;
  try {
    if (typeof raw !== "string" || raw.length > 4000 || !raw.isWellFormed()) throw new Error();
    parsed = JSON.parse(raw); object(parsed, ["layout", "evidenceIds"]); enumValue(parsed.layout, LAYOUTS); array(parsed.evidenceIds, 8);
    if (parsed.evidenceIds.length !== r.evidence.length || parsed.evidenceIds.some((x: unknown) => typeof x !== "string" || !r.evidence.some(e => e.id === x))) throw new Error();
    unique(parsed.evidenceIds);
    if (render(parsed.layout).length > 3500) throw new Error();
  } catch { fail(`Assistance returned an invalid or oversized structure. Nothing was saved. Use story ${id} or explicitly request polish again.`); }
  return render(parsed.layout);
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") {
    const [title, challenge] = fields(rest, 160, 1000), r: RecordData = { ...base(context, "achievement", text(title, "Achievement", 160)), challenge: text(challenge, "Challenge"), action: "", result: "", metric: { value: "", unit: "", baseline: "" }, collaborators: "", privacy: "", evidence: [] };
    return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Challenge saved. Add your personal action, result, evidence and collaborator attribution.", `story ${r.id}`); });
  }
  if (["action", "collaborators", "privacy"].includes(verb)) {
    const [id, value] = fields(rest, 80, 1000), key = verb as "action" | "collaborators" | "privacy";
    return mutate(context, id, (_, r) => { r![key] = text(value, key); return saved(id, "Entered field saved exactly; no team contribution was reassigned.", `story ${id}`); });
  }
  if (verb === "result") {
    const [id, result, value, unit, baseline] = fields(rest, 80, 1000, 20, 160, 20); metricNumber(value); if (baseline) metricNumber(baseline);
    return mutate(context, id, (_, r) => { r!.result = text(result, "Result"); r!.metric = { value, unit: text(unit, "Metric unit", 160), baseline }; return saved(id, "User measurement saved with original units/baseline. It is not causal evidence.", `story ${id}`); });
  }
  if (verb === "edit" || verb === "clear") {
    const v = verb === "edit" ? fields(rest, 80, 24, 1000) : words(rest, 3), [id, key] = v;
    if (verb === "clear" && v[2] !== "confirm") fail("Use clear ACHIEVEMENT FIELD confirm.");
    const clear = verb === "clear";
    return mutate(context, id, (_, r) => {
      if ((TEXT_FIELDS as readonly string[]).includes(key)) r![key as typeof TEXT_FIELDS[number]] = text(clear ? "" : v[2], key, key === "title" ? 160 : 1000, clear);
      else if (["metric.value", "metric.unit", "metric.baseline"].includes(key)) { const k = key.slice(7) as keyof RecordData["metric"], val = clear ? "" : text(v[2], key, k === "unit" ? 160 : 20); if (k !== "unit" && val) metricNumber(val); r!.metric[k] = val; }
      else fail("Fields: title, challenge, action, result, collaborators, privacy, metric.value, metric.unit, metric.baseline.");
      return saved(id, clear ? "Entered field removed; missing evidence remains explicit." : "Entered field updated.", `story ${id}`);
    }, clear ? "remove" : "content");
  }
  if (verb === "evidence" || verb === "evidence-edit") {
    const [head, label, value] = fields(rest, 170, 160, 2000), args = words(head, verb === "evidence" ? 1 : 2), [id, eid] = args;
    const e: Evidence = { id: eid ?? `evidence-${randomUUID()}`, label: text(label, "Evidence label", 160), text: text(value, "Evidence excerpt", 2000, false, 500) };
    return mutate(context, id, (_, r) => { if (eid) { const index = r!.evidence.findIndex(e => e.id === eid); if (index < 0) fail("Evidence not found."); r!.evidence[index] = e; } else { if (r!.evidence.length >= 8) fail("Maximum 8 evidence excerpts. Remove one explicitly first."); r!.evidence.push(e); } return saved(id, `Evidence ${e.id} saved. Labels and excerpts are supplied provenance, not external verification.`, `story ${id}`); });
  }
  if (verb === "evidence-remove") {
    const [id, eid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use evidence-remove ACHIEVEMENT EVIDENCE confirm.");
    return mutate(context, id, (_, r) => { if (!r!.evidence.some(e => e.id === eid)) fail("Evidence not found."); r!.evidence = r!.evidence.filter(e => e.id !== eid); return saved(id, "Evidence removed.", `story ${id}`); }, "remove");
  }
  if (verb === "story" || verb === "bullets") {
    const args = words(rest, 1, 4), r = find(await read(context), args[0]);
    const body = verb === "story" ? story(r) : [`${r.id} · ${r.title}`, `• Personal action: ${r.action || "missing"}`, `• Reported result: ${r.result || "missing"}`, `• ${measurement(r)}`, `• Team/collaborators: ${r.collaborators || "not supplied"}`, `• Evidence IDs: ${r.evidence.map(e => e.id).join(", ") || "missing"}`, `• Privacy: ${r.privacy || "not supplied"}`, "Supplied facts only; no causal connection inferred. Full challenge/evidence: use story."].join("\n");
    return report(body, `${verb} ${r.id}`, r, args.slice(1));
  }
  if (verb === "polish") { const [id, audience] = fields(rest, 80, 6); return polish(context, id, audience); }
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
function validId(value: unknown, prefix: string): void {
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
  validId(r.id, "achievement"); validText(r.title, 160, true); validNumber(r.revision, 1, MAX_REVISION);
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
  // Coalesce small atoms into bounded chunks. Dense IDs in readable legacy data
  // must not exhaust the kit's 4096-part limit. No known ID, URL or command splits.
  const result: { text: string; atomic?: boolean }[] = [];
  const tokens = /(?:[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolbox:goals:[A-Za-z0-9_.:-]+|(?:e1|s1):[a-f0-9]{64}|https?:\/\/[^\s]+|\/nobo-help[^\r\n]*|[\s\S])/gu;
  let chunk = "";
  for (const match of input.matchAll(tokens)) {
    const token = match[0];
    if (chunk && chunk.length + token.length > 2000) { result.push({ text: chunk, atomic: true }); chunk = ""; }
    if (token.length > 2000) result.push({ text: token, atomic: true });
    else chunk += token;
  }
  if (chunk) result.push({ text: chunk, atomic: true });
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
