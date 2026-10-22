import { createHash, randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { boundedText, pipeFields, parseInteger, parsePage, paginateParts, pageAt } from "./feature-kit/command-and-display.js";
import { assertQuota, assertStateVersion, serializedBytes } from "./feature-kit/bounded-state.js";
import { civilDate, civilDaysBetween, dateInZone, normalizeInstant } from "./feature-kit/civil-time.js";
import metadata from "./goal-alignment.metadata.js";
import { AgentContextCapacityError } from "./budgets.js";

import { captureEvidence } from "./feature-kit/evidence.js";
import type { AgentContextItem } from "./types.js";
const MAX_RECORDS = 10;
const SOURCE_KEYS = ["target", "current", "unit", "due", "history", "source", "createdAt", "status", "completedAt"];
type Selected = { kind: "local"; id: string; label: string } | { kind: "source"; id: string; owner: { teamId: string; userId: string }; snapshot: AgentContextItem; fingerprint: string; capturedAt: string; checkedAt: string; verification: "captured" | "unchanged" | "changed" | "absent"; latestFingerprint: string };
type Activity = { id: string; label: string; minutes: number; shares: { goalId: string; percent: number; reason: string }[] };
type RecordData = { id: string; title: string; revision: number; createdAt: string; updatedAt: string; goals: Selected[]; activities: Activity[] };
type State = { version: 1; records: RecordData[] };
type Source = { item: AgentContextItem; fingerprint: string };
function sourceId(value: unknown): asserts value is string { if (typeof value !== "string" || !/^toolbox:goals:[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error("Invalid owned goal source ID."); }
function fingerprint(value: unknown): void { if (typeof value !== "string" || !/^e1:[a-f0-9]{64}$/.test(value)) throw new Error("Invalid goal fingerprint."); }
function source(item: unknown): Source {
  const snapshot = captureEvidence([item], { kinds: ["goal"], maxItems: 1, maxBytes: 196608, metadataKeys: SOURCE_KEYS }), s = snapshot.sources[0]; sourceId(s.id);
  const m = s.metadata; if (!m || m.source !== "Personal toolbox / goals") throw new Error("Goal source provenance is not the owned toolbox adapter.");
  // Shape alone is insufficient: a zero/negative denominator cannot become valid
  // saved evidence merely because the shared adapter accepted a numeric field.
  for (const key of ["target", "current"]) if (m[key] !== undefined && (typeof m[key] !== "number" || !Number.isFinite(m[key]) || Number(m[key]) < (key === "target" ? 0.001 : 0) || Number(m[key]) > 1_000_000_000)) throw new Error("Invalid goal progress or target denominator.");
  if (m.unit !== undefined) validText(m.unit, 160, true);
  if (m.due !== undefined) { civilDate(m.due); if (s.dueAt !== m.due) throw new Error("Goal deadline semantics disagree."); }
  if (s.dueAt !== undefined) civilDate(s.dueAt); // goal deadlines remain civil labels
  if (m.createdAt !== undefined) normalizeInstant(m.createdAt);
  if (m.completedAt !== undefined) normalizeInstant(m.completedAt);
  if (m.status !== undefined) validText(m.status, 128);
  if (m.history !== undefined) {
    array(m.history, 366);
    for (const h of m.history) { object(h, ["at", "value", "note"]); normalizeInstant(h.at); if (typeof h.value !== "number" || !Number.isFinite(h.value) || h.value < 0 || h.value > 1_000_000_000) throw new Error("Invalid progress history."); validText(h.note, 2000, true, 500); }
  }
  if (m.status === undefined && typeof m.target === "number" && typeof m.current === "number" && s.status !== (m.current >= m.target ? "done" : "open")) throw new Error("Goal numeric state/status disagree.");
  return { item: s, fingerprint: snapshot.fingerprint };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validateRecord(v: unknown): asserts v is RecordData {
  object(v, ["id", "title", "revision", "createdAt", "updatedAt", "goals", "activities"]); validBase(v); array(v.goals, 10); array(v.activities, 30);
  for (const g of v.goals) {
    if (g?.kind === "local") { object(g, ["kind", "id", "label"]); validId(g.id, "local"); validText(g.label, 160); }
    else {
      object(g, ["kind", "id", "owner", "snapshot", "fingerprint", "capturedAt", "checkedAt", "verification", "latestFingerprint"]); enumValue(g.kind, ["source"]); sourceId(g.id); object(g.owner, ["teamId", "userId"]);
      for (const k of ["teamId", "userId"]) if (typeof g.owner[k] !== "string" || !/^[A-Z0-9]{2,32}$/.test(g.owner[k])) throw new Error("Invalid source owner.");
      const projected = source(g.snapshot); if (g.id !== projected.item.id || projected.fingerprint !== g.fingerprint || canonical(projected.item) !== canonical(g.snapshot)) throw new Error("Saved goal evidence changed shape or content.");
      fingerprint(g.fingerprint); normalizeInstant(g.capturedAt); normalizeInstant(g.checkedAt); enumValue(g.verification, ["captured", "unchanged", "changed", "absent"]);
      if (g.verification === "absent") { if (g.latestFingerprint !== "") throw new Error("Invalid absent-source verification."); }
      else { fingerprint(g.latestFingerprint); if ((g.verification === "changed") === (g.latestFingerprint === g.fingerprint)) throw new Error("Invalid source comparison."); }
    }
  }
  unique(v.goals.map((g: Selected) => g.id));
  for (const a of v.activities) {
    object(a, ["id", "label", "minutes", "shares"]); validId(a.id, "activity"); validText(a.label, 160, true); validNumber(a.minutes, 0, 1_000_000); array(a.shares, 10);
    for (const l of a.shares) { object(l, ["goalId", "percent", "reason"]); if (typeof l.goalId !== "string" || !v.goals.some((g: Selected) => g.id === l.goalId)) throw new Error("Dangling goal allocation."); validNumber(l.percent, 1, 100); validText(l.reason, 320); }
    unique(a.shares.map((l: Activity["shares"][number]) => l.goalId)); if (a.shares.reduce((n: number, l: Activity["shares"][number]) => n + l.percent, 0) > 100) throw new Error("Goal shares exceed 100%.");
  }
  unique(v.activities.map((a: Activity) => a.id));
}
function projectLifecycle(s: State): State {
  // Every selected source remains refreshable through changed/absent/reappeared
  // states. New snapshots, labels and allocation reasons remain content admission.
  return { ...s, records: s.records.map(r => ({ ...r, revision: MAX_REVISION, goals: r.goals.map(g => g.kind === "local" ? g : { ...g, verification: "unchanged", latestFingerprint: g.fingerprint, checkedAt: "9999-12-31T23:59:59.999Z" }) })) };
}
function verifyOwner(r: RecordData, context: AgentFeatureContext): void {
  if (r.goals.some(g => g.kind === "source" && (g.owner.teamId !== context.teamId || g.owner.userId !== context.userId))) fail("Saved goal provenance does not match this private scope. Data was preserved.");
}
function selected(r: RecordData, id: string): Selected { const g = r.goals.find(g => g.id === id); if (!g) fail("Goal is not selected on this board. Use goals/select or local first."); return g; }
function activity(r: RecordData, id: string): Activity { const a = r.activities.find(a => a.id === id); if (!a) fail("Activity not found on this board."); return a; }
function selectedBytes(r: RecordData): number { return r.goals.reduce((n, g) => n + (g.kind === "source" ? Buffer.byteLength(g.snapshot.text) : 0), 0); }
async function sources(context: AgentFeatureContext, boardId: string): Promise<{ all: Source[]; fingerprint: string }> {
  try {
    const incoming = await context.services.readContext(["goal"]); context.signal?.throwIfAborted();
    // Validate the complete adapter result; selection limits must not truncate
    // discovery or turn an incomplete source into an empty permitted snapshot.
    array(incoming, 100); const all = incoming.map(item => source(item)).sort((a, b) => a.item.id.localeCompare(b.item.id)); unique(all.map(s => s.item.id));
    return { all, fingerprint: `s1:${createHash("sha256").update(JSON.stringify(all.map(s => [s.item.id, s.fingerprint]))).digest("hex")}` };
  } catch (error) {
    context.signal?.throwIfAborted();
    // Only the typed class (possibly wrapped by an adapter) establishes capacity.
    // Never echo backend messages, even messages carried by a typed error.
    let capacity = false;
    for (let cause = error, depth = 0; cause instanceof Error && depth < 8; cause = cause.cause, depth++) {
      if (cause instanceof AgentContextCapacityError) { capacity = true; break; }
    }
    fail(`Owned goal context could not be read completely, so this source operation could not be completed safely.${capacity ? " A complete-read capacity limit was reached." : ""} No board save was dispatched; historical selections and allocations were preserved. Goal source limit: 100 goals; no partial source was used.\nCheck /nobo-help tools goals list and /nobo-help tools goals help. Reduce owned toolbox goals if needed: /nobo-help tools goals export ID, then /nobo-help tools goals delete ID confirm. Use the toolbox entry ID (without toolbox:goals:), then retry this command.\nLocal alternative: ${ROUTE} local ${boardId} | LABEL. Saved show/review/export remain available.`);
  }
}
function coverage(s: AgentContextItem): string { return `text ${s.metadata?.textTruncated === true ? "adapter excerpt (truncated)" : s.metadata?.textTruncated === false ? "complete adapter text" : "coverage unknown"}; title ${s.metadata?.titleTruncated === true ? "truncated by adapter" : s.metadata?.titleTruncated === false ? "complete" : "coverage unknown"}${s.metadata?.coverage ? `; ${s.metadata.coverage}` : ""}`; }
function minutes(n: number): string { return (n / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1"); }
function review(r: RecordData): string {
  const total = r.activities.reduce((n, a) => n + a.minutes * 100, 0), aligned = r.activities.reduce((n, a) => n + a.minutes * a.shares.reduce((v, s) => v + s.percent, 0), 0);
  const lines = [`${r.id} · ${r.title}`, `Planned minutes: ${minutes(total)}; aligned ${minutes(aligned)}; unallocated ${minutes(total - aligned)}. Shares are user allocations, not measured completion or causal impact.`, "Saved source context is historical; show/review do not refresh. Use refresh to check the current permitted snapshot."];
  for (const g of r.goals) {
    const amount = r.activities.reduce((n, a) => n + a.minutes * (a.shares.find(l => l.goalId === g.id)?.percent ?? 0), 0);
    if (g.kind === "local") lines.push(`\n${g.id} · explicit local goal label: ${g.label}; allocated ${minutes(amount)} minutes. No live goal/qualification implied.`);
    else { const m = g.snapshot.metadata!; lines.push(`\n${g.id} · historical snapshot: ${g.snapshot.title}; allocated ${minutes(amount)} minutes.`, `Verification ${g.verification} at ${g.checkedAt}; captured ${g.capturedAt}; source updated ${g.snapshot.updatedAt ?? "unknown"}; deadline ${g.snapshot.dueAt ?? "unknown"} (civil date).`, `Source-reported status ${g.snapshot.status ?? "unknown"}; numeric progress ${m.current ?? "unknown"}/${m.target ?? "unknown"} ${m.unit ?? "(unit unknown)"}. A reached numeric target is not proof of completion, dated completion or causal impact.`, `${coverage(g.snapshot)}. Fingerprint ${g.fingerprint}; latest ${g.latestFingerprint || "absent from this permitted snapshot"}.`); if (g.verification === "changed") lines.push(`Source changed; old evidence retained. To replace explicitly: ${ROUTE} replace ${r.id} | ${g.id} | confirm`); if (g.verification === "absent") lines.push("Source absent/revoked from the permitted snapshot; not proven deleted everywhere. Historical allocation remains labeled, not silently erased."); }
  }
  const covered = r.goals.filter(g => r.activities.some(a => a.shares.some(l => l.goalId === g.id))).length;
  lines.push(`\nSelected-goal coverage: ${covered}/${r.goals.length} have an explicit share. Unknown/unallocated effort is not evenly imputed.`);
  for (const a of r.activities) { const allocated = a.shares.reduce((n, l) => n + l.percent, 0); lines.push(`Activity ${a.id} · ${a.label || "(label cleared)"}: ${a.minutes} planned minutes; ${allocated}% assigned; ${minutes(a.minutes * (100 - allocated))} unallocated minutes.`); for (const l of a.shares) lines.push(`→ ${l.goalId}: ${l.percent}% × ${a.minutes} = ${minutes(a.minutes * l.percent)} minutes; entered reason: ${l.reason}`); }
  return lines.join("\n");
}
async function sourceView(context: AgentFeatureContext, verb: string, rest: string): Promise<string> {
  const args = words(rest, verb === "source" ? 2 : 1, verb === "source" ? 7 : 6), r = find(await read(context), args[0]); verifyOwner(r, context);
  const tail = args.slice(verb === "source" ? 2 : 1); if (![0, 1, 5].includes(tail.length)) fail("Copy the complete PAGE rev TOKEN source FINGERPRINT continuation or restart page 1.");
  const page = checked(() => parsePage(tail[0])); if (tail.length === 5 && (tail[1] !== "rev" || tail[2] !== stamp(r) || tail[3] !== "source")) fail("Saved board changed; restart source page 1.");
  const current = await sources(context, r.id); if (stamp(find(await read(context), r.id)) !== stamp(r)) fail("Board changed while goals loaded; restart discovery.");
  if (tail.length === 5 && tail[4] !== current.fingerprint) fail("Goal source set changed; stale source continuation rejected. Restart page 1.");
  let body: string, command: string;
  if (verb === "source") { const s = current.all.find(s => s.item.id === args[1]); if (!s) fail("Source absent from this permitted snapshot. Use goals to discover available IDs."); body = JSON.stringify({ source: s.item, fingerprint: s.fingerprint }, null, 2); command = `source ${r.id} ${s.item.id}`; }
  else { body = [`Complete owned-goal discovery: ${current.all.length}/100 adapter items; no source silently selected.`, ...current.all.map(s => `${s.item.id} · ${s.item.title}\nStatus ${s.item.status ?? "unknown"}; civil deadline ${s.item.dueAt ?? "unknown"}; ${Buffer.byteLength(s.item.text)} text UTF-8 bytes; ${coverage(s.item)}.\nDetail: ${ROUTE} source ${r.id} ${s.item.id}`), `Select explicitly: ${ROUTE} select ${r.id} | GOAL_SOURCE_ID`, `Local alternative: ${ROUTE} local ${r.id} | YOUR_LABEL`].join("\n"); command = `goals ${r.id}`; }
  return checked(() => pageAt(paginateParts(parts(body), { mode: "plain", title: `Owned goal sources · ${current.fingerprint} · board revision ${r.revision}`, command: n => `${ROUTE} ${command} ${n} rev ${stamp(r)} source ${current.fingerprint}` }), page).text);
}
async function executeDomain(verb: string, rest: string, context: AgentFeatureContext): Promise<string> {
  if (verb === "create") { const [title] = fields(rest, 160), r: RecordData = { ...base(context, "board", text(title, "Board", 160)), goals: [], activities: [] }; return mutate(context, undefined, s => { s.records.push(r); return saved(r.id, "Board created. Discover owned goals or enter explicit local labels.", `goals ${r.id}`); }); }
  if (verb === "edit" || verb === "clear") {
    const v = verb === "edit" ? fields(rest, 80, 16, 160) : words(rest, 3), [id, field] = v, clear = verb === "clear"; if (field !== "title" || (clear && v[2] !== "confirm")) fail("Use edit BOARD | title | VALUE or clear BOARD title confirm.");
    return mutate(context, id, (_, r) => { r!.title = text(clear ? "" : v[2], "Board", 160, clear); return saved(id, "Board label updated."); }, clear ? "remove" : "content");
  }
  if (verb === "goals" || verb === "source") return sourceView(context, verb, rest);
  if (verb === "select" || verb === "replace") {
    const v = fields(rest, ...(verb === "select" ? [80, 112] : [80, 112, 7])), [id, sid] = v; checked(() => sourceId(sid)); if (verb === "replace" && v[2] !== "confirm") fail("Use replace BOARD | SOURCE_ID | confirm to replace the saved historical snapshot.");
    const r = find(await read(context), id); verifyOwner(r, context); const existing = r.goals.find(g => g.id === sid);
    if (verb === "select" && existing) fail("Already selected. Use replace BOARD | SOURCE_ID | confirm for an explicit fresh replacement.");
    if (verb === "replace" && (!existing || existing.kind !== "source")) fail("Only a selected source can be replaced.");
    if (!existing && r.goals.length >= 10) fail("Maximum 10 selected goals/local labels. Remove one explicitly first.");
    const current = await sources(context, id), s = current.all.find(s => s.item.id === sid); if (!s) fail("Goal absent from the current permitted snapshot. Historical data preserved; use goals or refresh.");
    const capturedAt = context.now.toISOString(), g: Selected = { kind: "source", id: sid, owner: { teamId: context.teamId, userId: context.userId }, snapshot: s.item, fingerprint: s.fingerprint, capturedAt, checkedAt: capturedAt, verification: "captured", latestFingerprint: s.fingerprint };
    return mutate(context, id, (_, next) => { if (existing) next!.goals[next!.goals.findIndex(g => g.id === sid)] = g; else next!.goals.push(g); if (selectedBytes(next!) > 8000) fail("Selected source text exceeds 8000 UTF-8 bytes. Remove a selection or shorten the source; no source was clipped."); return saved(id, `Goal ${sid} ${existing ? "snapshot explicitly replaced; existing shares still express your planned allocation" : "snapshot selected"}. Saved context is historical.`, `review ${id}`); }, "content", r);
  }
  if (verb === "refresh") {
    const [id] = words(rest, 1), r = find(await read(context), id); verifyOwner(r, context); if (!r.goals.some(g => g.kind === "source")) fail("No owned goal snapshots selected. Local labels have no source to refresh.");
    const current = await sources(context, id), checkedAt = context.now.toISOString();
    return mutate(context, id, (_, next) => { for (const g of next!.goals) if (g.kind === "source") { const s = current.all.find(s => s.item.id === g.id); g.checkedAt = checkedAt; g.latestFingerprint = s?.fingerprint ?? ""; g.verification = !s ? "absent" : s.fingerprint === g.fingerprint ? "unchanged" : "changed"; } return saved(id, "Checked the complete current permitted goal snapshot. Historical text retained; changed/absent sources labeled. Replacement is explicit.", `review ${id}`); }, "lifecycle", r);
  }
  if (verb === "local" || verb === "local-edit") {
    const [head, value] = fields(rest, 170, 160), [id, lid] = words(head, verb === "local" ? 1 : 2), gid = lid ?? `local-${randomUUID()}`, label = text(value, "Explicit local goal label", 160);
    return mutate(context, id, (_, r) => { if (lid) { const g = selected(r!, lid); if (g.kind !== "local") fail("Source snapshots cannot be relabeled; use explicit replacement or a local label."); g.label = label; } else { if (r!.goals.length >= 10) fail("Maximum 10 selected goals/local labels."); r!.goals.push({ kind: "local", id: gid, label }); } return saved(id, `Local label ${gid} saved. It is not a live owned-goal snapshot.`, `review ${id}`); });
  }
  if (verb === "goal-remove") {
    const [id, gid, confirm] = words(rest, 3); if (confirm !== "confirm") fail("Use goal-remove BOARD GOAL_ID confirm; removes its board shares, never the source.");
    return mutate(context, id, (_, r) => { selected(r!, gid); r!.goals = r!.goals.filter(g => g.id !== gid); for (const a of r!.activities) a.shares = a.shares.filter(l => l.goalId !== gid); return saved(id, "Board selection and its shares removed. Source goal unchanged; planned minutes become unallocated.", `review ${id}`); }, "remove");
  }
  if (verb === "activity") {
    const m = /^(\S+)\s+(add|edit|clear|remove)\s+([\s\S]+)$/.exec(rest); if (!m) fail("Use activity BOARD add LABEL | MINUTES; see help for edit/remove."); const [, id, mode, input] = m;
    if (mode === "remove" || mode === "clear") { const v = words(input, mode === "remove" ? 2 : 3); if (v.at(-1) !== "confirm" || (mode === "clear" && v[1] !== "label")) fail("Use activity BOARD remove ACTIVITY confirm or clear ACTIVITY label confirm."); return mutate(context, id, (_, r) => { const a = activity(r!, v[0]); if (mode === "remove") r!.activities = r!.activities.filter(a => a.id !== v[0]); else a.label = ""; return saved(id, "Activity input removed.", `review ${id}`); }, "remove"); }
    if (mode === "add") { const [label, mins] = fields(input, 160, 7), a: Activity = { id: `activity-${randomUUID()}`, label: text(label, "Activity", 160), minutes: integer(mins, 0, 1_000_000, "Planned minutes"), shares: [] }; return mutate(context, id, (_, r) => { if (r!.activities.length >= 30) fail("Maximum 30 activities. Remove one explicitly first."); r!.activities.push(a); return saved(id, `Activity ${a.id} saved. All minutes are initially unallocated.`, `review ${id}`); }); }
    const [aid, key, value] = fields(input, 80, 16, 160); return mutate(context, id, (_, r) => { const a = activity(r!, aid); if (key === "label") a.label = text(value, "Activity", 160); else if (key === "minutes") a.minutes = integer(value, 0, 1_000_000, "Planned minutes"); else fail("Activity fields: label, minutes. Remove the activity to remove its required numeric minutes."); return saved(id, "Planned activity updated; shares remain explicit user allocations.", `review ${id}`); });
  }
  if (verb === "link") {
    const [head, gid, percent, reason] = fields(rest, 170, 112, 3, 320), [id, aid] = words(head, 2), share = integer(percent, 1, 100, "Percent"), why = text(reason, "Allocation reason", 320);
    return mutate(context, id, (_, r) => { selected(r!, gid); const a = activity(r!, aid), others = a.shares.filter(l => l.goalId !== gid); if (others.reduce((n, l) => n + l.percent, 0) + share > 100) fail("Shares exceed 100%. Reduce another explicit share first; nothing was saved."); a.shares = [...others, { goalId: gid, percent: share, reason: why }]; return saved(id, "User allocation saved; link again to edit percentage/reason.", `review ${id}`); });
  }
  if (verb === "unlink") { const [id, aid, gid, confirm] = words(rest, 4); if (confirm !== "confirm") fail("Use unlink BOARD ACTIVITY GOAL_ID confirm."); return mutate(context, id, (_, r) => { const a = activity(r!, aid); if (!a.shares.some(l => l.goalId === gid)) fail("Allocation not found."); a.shares = a.shares.filter(l => l.goalId !== gid); return saved(id, "Allocation removed; those minutes are unallocated.", `review ${id}`); }, "remove"); }
  if (verb === "review") { const args = words(rest, 1, 4), r = find(await read(context), args[0]); verifyOwner(r, context); return report(review(r), `review ${r.id}`, r, args.slice(1)); }
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
  validId(r.id, "board"); validText(r.title, 160, true); validNumber(r.revision, 1, MAX_REVISION);
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
  if (state.records.some(r => selectedBytes(r) > 8000)) fail("Selected source text exceeds 8000 UTF-8 bytes. Remove a selection before further writes.");
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
  const s = raw === null ? structuredClone(EMPTY) : decode(raw);
  for (const r of s.records) verifyOwner(r, context);
  return s;
}
async function mutate(context: AgentFeatureContext, id: string | undefined, change: (s: State, r?: RecordData) => string,
  kind: "content" | "lifecycle" | "remove" = "content", expected?: RecordData): Promise<string> {
  const intended = id === undefined ? undefined : JSON.stringify(expected ?? find(await read(context), id));
  const timestamp = context.now.toISOString();
  return context.store.update<State, string>("state", EMPTY, raw => {
    const s = structuredClone(decode(raw)), r = id === undefined ? undefined : find(s, id);
    if (r && JSON.stringify(r) !== intended) fail(`This item changed; inspect it before retrying: ${ROUTE} show ${id}`);
    if (r && r.revision === MAX_REVISION && kind !== "remove") fail("Revision limit reached. Export/show, then delete this whole record and create a new one; edits and lifecycle writes are unavailable.");
    for (const record of s.records) verifyOwner(record, context);
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
