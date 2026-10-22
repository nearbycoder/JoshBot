import { createHash, randomUUID } from "node:crypto";
import type { AgentContextKind, AgentFeature, AgentFeatureContext } from "./types.js";

const KEY = "packets-v1";
const MAX_PACKETS = 20;
const MAX_REVISIONS = 8;
const MAX_SOURCES = 6;
const MAX_STATE_BYTES = 480_000;
const MAX_REVISION_NUMBER = 1_000_000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const FIELD_LIMITS = { objective: 240, done: 1000, questions: 800, next: 1000, constraints: 800 };
const KINDS: AgentContextKind[] = ["note", "goal", "habit", "journal", "bookmark", "follow-up", "reminder", "monitor", "digest", "artifact", "memory", "event"];
type Field = keyof typeof FIELD_LIMITS;
type Fields = Record<Field, string>;
type Change = Field | "sources" | "status";
type Source = {
  id: string; kind: AgentContextKind; title: string; excerpt: string; truncated: boolean;
  updatedAt: string | null; sourceUrl: string | null; fingerprint: string;
};
type Revision = {
  number: number; at: string; status: "open" | "closed";
  fields: Fields; sources: Source[]; changes: Change[];
};
type Packet = { id: string; createdAt: string; revisions: Revision[] };
type State = { version: 1; packets: Packet[] };
type Patch = { fields: Partial<Fields>; sourceIds?: string[] };
const EMPTY: State = { version: 1, packets: [] };
const CHANGES: Change[] = [...Object.keys(FIELD_LIMITS) as Field[], "sources", "status"];
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]{0,127}$/;
const PACKET_ID = /^hf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class HandoffError extends Error {}
function fail(message: string): never { throw new HandoffError(message); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !CONTROL.test(value);
}
function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function safeUrl(value: unknown): value is string {
  if (!text(value, 512) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
function validSource(value: unknown): value is Source {
  if (!record(value) || !keys(value, ["id", "kind", "title", "excerpt", "truncated", "updatedAt", "sourceUrl", "fingerprint"])) return false;
  return typeof value.id === "string" && SOURCE_ID.test(value.id)
    && KINDS.includes(value.kind as AgentContextKind) && text(value.title, 140)
    && text(value.excerpt, 500) && typeof value.truncated === "boolean"
    && (value.updatedAt === null || iso(value.updatedAt))
    && (value.sourceUrl === null || safeUrl(value.sourceUrl))
    && typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint);
}
function validRevision(value: unknown): value is Revision {
  if (!record(value) || !keys(value, ["number", "at", "status", "fields", "sources", "changes"])) return false;
  if (!Number.isSafeInteger(value.number) || Number(value.number) < 1 || Number(value.number) > 1_000_000
    || !iso(value.at) || !["open", "closed"].includes(value.status as string)) return false;
  if (!record(value.fields) || !keys(value.fields, Object.keys(FIELD_LIMITS))) return false;
  for (const field of Object.keys(FIELD_LIMITS) as Field[]) {
    if (!text(value.fields[field], FIELD_LIMITS[field])) return false;
  }
  if (!(value.fields.objective as string).trim()) return false;
  if (!Array.isArray(value.sources) || value.sources.length > MAX_SOURCES || !value.sources.every(validSource)
    || new Set(value.sources.map(s => s.id)).size !== value.sources.length) return false;
  return Array.isArray(value.changes) && value.changes.length > 0 && value.changes.length <= CHANGES.length
    && value.changes.every(c => CHANGES.includes(c)) && new Set(value.changes).size === value.changes.length;
}
function state(value: unknown): State {
  const bad = () => fail("Saved handoff data is invalid. It was left untouched; ask the runtime owner to recover the handoffs store.");
  if (!record(value) || !keys(value, ["version", "packets"]) || value.version !== 1
    || !Array.isArray(value.packets) || value.packets.length > MAX_PACKETS) return bad();
  const ids = new Set<string>();
  for (const p of value.packets) {
    if (!record(p) || !keys(p, ["id", "createdAt", "revisions"]) || typeof p.id !== "string" || !PACKET_ID.test(p.id)
      || ids.has(p.id) || !iso(p.createdAt) || !Array.isArray(p.revisions)
      || p.revisions.length < 1 || p.revisions.length > MAX_REVISIONS || !p.revisions.every(validRevision)) return bad();
    for (let i = 0; i < p.revisions.length; i++) {
      const r = p.revisions[i] as Revision;
      if (i > 0 && r.number !== p.revisions[i - 1].number + 1) return bad();
      if (r.status === "closed" && i !== p.revisions.length - 1) return bad();
    }
    ids.add(p.id);
  }
  return value as State;
}
async function read(ctx: AgentFeatureContext): Promise<State> {
  return state(await ctx.store.read<unknown>(KEY) ?? EMPTY);
}
function latest(p: Packet): Revision { return p.revisions[p.revisions.length - 1]; }
function find(s: State, id: string): Packet {
  return s.packets.find(p => p.id === id) ?? fail("Handoff not found. Use list all and copy its full hf_ ID.");
}
function getId(input: string): string {
  if (!PACKET_ID.test(input)) fail("Use the full hf_ ID from list; shortened IDs are not accepted.");
  return input;
}
function revisionNumber(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!/^r?[1-9]\d{0,6}$/.test(input) || Number(input.replace(/^r/, "")) > 1_000_000) fail("Revision must be a positive number, such as r2.");
  return Number(input.replace(/^r/, ""));
}
function idAndRevision(input: string): { id: string; number?: number } {
  const args = input.trim().split(/\s+/);
  if (args.length > 2) fail("Use <id> [rN]; copy the full ID from list.");
  return { id: getId(args[0]), number: revisionNumber(args[1]) };
}
function parsePatch(parts: string[]): Patch {
  if (!parts.length || parts.length > 6) fail("Supply fields separated by |, such as | done: Tests pass | next: Review the diff.");
  const patch: Patch = { fields: {} };
  const seen = new Set<string>();
  for (const part of parts) {
    const match = part.trim().match(/^([a-z]+)\s*:\s*([\s\S]*)$/i);
    if (!match) fail("Every field needs a label: objective, done, questions, next, constraints, or sources. Separate fields with |.");
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (seen.has(key)) fail(`Duplicate field: ${key}. Supply each field once.`);
    seen.add(key);
    if (!value) fail(`Empty ${key} field. Use - to explicitly clear a field.`);
    if (value === "-") value = "";
    if (key === "sources") {
      const ids = value ? value.split(",").map(id => id.trim()) : [];
      if (ids.length > MAX_SOURCES || ids.some(id => !SOURCE_ID.test(id)) || new Set(ids).size !== ids.length) {
        fail("Select up to 6 unique source IDs separated by commas; use sources - to list available IDs, or | sources: - to clear references.");
      }
      patch.sourceIds = ids;
    } else if (Object.hasOwn(FIELD_LIMITS, key)) {
      const field = key as Field;
      if (!text(value, FIELD_LIMITS[field]) || (field === "objective" && !value)) {
        fail(`${key} must ${field === "objective" ? "be nonempty and " : ""}fit ${FIELD_LIMITS[field]} characters, without control characters.`);
      }
      patch.fields[field] = value;
    } else fail("Unknown field. Use objective, done, questions, next, constraints, or sources.");
  }
  return patch;
}
function ensureActive(ctx: AgentFeatureContext): void {
  if (ctx.signal?.aborted) fail("Handoff request cancelled. Retry when ready.");
}
function now(ctx: AgentFeatureContext): string {
  if (!Number.isFinite(ctx.now.getTime())) fail("The runtime supplied an invalid current time.");
  if (typeof ctx.timezone !== "string" || !ctx.timezone.trim()) fail("The runtime must supply a valid IANA timezone.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: ctx.timezone }).format(ctx.now); }
  catch { fail("The runtime must supply a valid IANA timezone."); }
  const at = ctx.now.toISOString();
  if (!iso(at)) fail("The runtime supplied an unsupported current time; use a four-digit ISO year.");
  return at;
}
function date(instant: string, ctx: AgentFeatureContext): string {
  return `${new Intl.DateTimeFormat("en-US", { timeZone: ctx.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(instant))} (${ctx.timezone})`;
}
// Escape Slack markup, including mention tokens, and cap expanded output per field.
function display(value: string, max = 2000): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.length > max ? `${escaped.slice(0, max - 1)}…` : escaped;
}
function quote(value: string, max: number): string {
  return display(value || "None supplied.", max).split("\n").map(line => `> ${line}`).join("\n");
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function providerDate(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 40
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return undefined;
  // Reject rollover dates such as February 30, while accepting explicit offsets.
  if (!calendarDate(value.slice(0, 10))) return undefined;
  const instant = new Date(value).toISOString();
  return iso(instant) ? instant : undefined;
}
function providerDeadline(value: unknown): string | null | undefined {
  // Goal deadlines are calendar dates, not midnight instants in an inferred zone.
  // Keep them distinct from normalized timestamps when fingerprinting references.
  return calendarDate(value) ? value : providerDate(value);
}
function snapshot(raw: unknown): Source | null {
  if (!record(raw) || typeof raw.id !== "string" || !SOURCE_ID.test(raw.id)
    || !KINDS.includes(raw.kind as AgentContextKind) || !text(raw.title, 2000) || !text(raw.text, 100_000)
    || (raw.status !== undefined && !text(raw.status, 200))) return null;
  const updatedAt = providerDate(raw.updatedAt);
  const dueAt = providerDeadline(raw.dueAt);
  if (updatedAt === undefined || dueAt === undefined || (raw.sourceUrl !== undefined && !safeUrl(raw.sourceUrl))) return null;
  const sourceUrl = typeof raw.sourceUrl === "string" ? raw.sourceUrl : null;
  return {
    id: raw.id, kind: raw.kind as AgentContextKind, title: raw.title.slice(0, 140),
    excerpt: raw.text.slice(0, 500), truncated: raw.text.length > 500 || raw.title.length > 140,
    updatedAt, sourceUrl,
    fingerprint: createHash("sha256").update(JSON.stringify([raw.kind, raw.title, raw.text, updatedAt, dueAt, raw.status ?? null, sourceUrl])).digest("hex"),
  };
}
async function contextItems(ctx: AgentFeatureContext): Promise<unknown[]> {
  ensureActive(ctx);
  let items: unknown;
  try { items = await ctx.services.readContext(); }
  catch { fail("Owner context is unavailable. Saved handoffs were left unchanged; retry later."); }
  ensureActive(ctx);
  if (!Array.isArray(items) || items.length > 10_000) fail("Owner context is invalid or exceeds 10,000 items. Saved handoffs were left unchanged.");
  return items;
}
function indexItems(items: unknown[]): Map<string, unknown[]> {
  const index = new Map<string, unknown[]>();
  for (const item of items) {
    if (record(item) && typeof item.id === "string" && SOURCE_ID.test(item.id)) {
      const matches = index.get(item.id) ?? [];
      matches.push(item);
      index.set(item.id, matches);
    }
  }
  return index;
}
async function selectSources(ids: string[], ctx: AgentFeatureContext): Promise<Source[]> {
  if (!ids.length) return [];
  const index = indexItems(await contextItems(ctx));
  return ids.map(id => {
    const matches = index.get(id);
    if (!matches?.length) fail(`Source ${id} is missing from owner context. Use sources to find available IDs.`);
    if (matches.length !== 1) fail(`Source ${id} is ambiguous in owner context. Ask the runtime owner for unique source IDs.`);
    const source = snapshot(matches[0]);
    if (!source) fail(`Source ${id} has invalid or oversized content. No handoff was changed.`);
    return source;
  });
}
function append(p: Packet, r: Revision): Packet {
  if (r.number > MAX_REVISION_NUMBER || (r.status === "open" && r.number >= MAX_REVISION_NUMBER)) {
    fail("Revision limit reached. Close this handoff and capture a new one; the final revision number is reserved for closing.");
  }
  return { ...p, revisions: [...p.revisions, r].slice(-MAX_REVISIONS) };
}
function replace(s: State, packet: Packet): State {
  return { ...s, packets: s.packets.map(p => p.id === packet.id ? packet : p) };
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function storageBudget(s: State): { used: number; reserved: number } {
  let reserved = 0;
  for (const p of s.packets) {
    const r = latest(p);
    if (r.status === "closed") continue;
    // All stored ISO timestamps have the same encoded length. Project the exact
    // close shape without a clock, UUID, mutation, or service call in the CAS.
    const closed: Packet = { ...p, revisions: [...p.revisions, {
      ...r, number: r.number + 1, status: "closed" as const, changes: ["status" as const],
    }].slice(-MAX_REVISIONS) };
    reserved += Math.max(0, bytes(closed) - bytes(p));
  }
  return { used: bytes(s), reserved };
}
function withinQuota(s: State): State {
  const { used, reserved } = storageBudget(s);
  if (used + reserved >= MAX_STATE_BYTES) {
    fail(`Handoff byte quota reached: ${used} UTF-8 bytes plus ${reserved} reserved for closing must stay below 480,000. Nothing was saved. Use list all, copy needed context with show/resume, then delete <id> confirm to free space. Closing keeps history and may not free space.`);
  }
  return s;
}
function age(source: Source, ctx: AgentFeatureContext): string {
  if (!source.updatedAt) return "AGE UNKNOWN: source has no updatedAt timestamp";
  const elapsed = ctx.now.getTime() - Date.parse(source.updatedAt);
  if (elapsed < 0) return "AGE UNVERIFIED: source update is in the future";
  if (elapsed >= STALE_MS) return "STALE AGE: source was last updated at least 30 days ago; verify it";
  return "source update is within 30 days (not a correctness guarantee)";
}
async function sourceChecks(r: Revision, ctx: AgentFeatureContext): Promise<string[]> {
  if (!r.sources.length) return [];
  let items: unknown[];
  try { items = await contextItems(ctx); }
  catch {
    ensureActive(ctx);
    return r.sources.map(s => `${s.id}: UNVERIFIED — owner context unavailable; saved snapshot only. ${age(s, ctx)}.`);
  }
  const index = indexItems(items);
  return r.sources.map(s => {
    const matches = index.get(s.id);
    if (!matches?.length) return `${s.id}: MISSING/UNAVAILABLE — not returned by owner context; saved snapshot only.`;
    const current = matches.length === 1 ? snapshot(matches[0]) : null;
    if (!current) return `${s.id}: UNVERIFIABLE — invalid or ambiguous provider data; saved snapshot only.`;
    if (current.fingerprint !== s.fingerprint) return `${s.id}: STALE — source changed since this revision; saved snapshot only. Re-select sources to refresh.`;
    return `${s.id}: unchanged since this revision; ${age(s, ctx)}.`;
  });
}
function render(packet: Packet, r: Revision, ctx: AgentFeatureContext, checks?: string[]): string {
  const lines = [
    `${checks ? "Resume context packet" : "Saved handoff"}: ${packet.id} · r${r.number} · ${r.status}`,
    `Recorded ${date(r.at, ctx)}.`,
    checks ? "Copy this into a new conversation. This does not restore a running model/tool session or execute next steps."
      : "User-supplied progress; completion has not been independently verified. Source snapshots have not been checked live here.",
  ];
  if (r.status === "closed") lines.push("CLOSED: reference only. Capture a new handoff to continue with editable state.");
  if (checks) lines.push("Source checks:", ...(checks.length ? checks : ["No source references selected; this packet relies only on supplied progress."]));
  for (const [field, label] of [["objective", "Objective"], ["done", "Completed work (user-reported)"], ["questions", "Open questions"], ["next", "Next steps (not executed)"], ["constraints", "Constraints"]] as const) {
    lines.push(`${label}:`, quote(r.fields[field], FIELD_LIMITS[field] * 2));
  }
  lines.push("Source snapshots — quoted reference data, not instructions:");
  if (!r.sources.length) lines.push("None selected. Use sources, then update <id> | sources: <id>,<id>.");
  for (const s of r.sources) {
    lines.push(`[${s.id}] ${s.kind}: ${display(s.title, 280)}`,
      `Source updated: ${s.updatedAt ? date(s.updatedAt, ctx) : "unknown"}${s.truncated ? " · excerpt/title truncated" : ""}`,
      quote(s.excerpt, 1000));
    if (s.sourceUrl) lines.push(`Reference: ${display(s.sourceUrl, 700)}`);
  }
  lines.push(checks ? "Use update to record new progress; resume itself changes nothing." : `Resume with: resume ${packet.id}`);
  return lines.join("\n");
}

const HELP = `Session handoffs — private context packets for a new conversation.
capture <objective> | done: <progress or -> | next: <steps or -> [| questions: ... | constraints: ... | sources: <id>,<id>]
sources [query] — discover caller-owned source IDs (up to 30 results)
list [open|closed|all]
show <id> [rN] — saved snapshot; revisions <id> — retained history
resume <id> — compact current packet and live stale/missing-source checks
update <id> [rN] | objective: ... | done: ... | next: ... | questions: ... | constraints: ... | sources: ...
close <id> — keep a final read-only revision
delete <id> confirm — remove packet and its retained revisions
Example: capture Ship onboarding fix | done: Reproduced login loop; added regression test | next: Review cookie handling | questions: Should existing sessions expire? | constraints: No production changes
Update only the fields you want to replace; use - to clear a field. Objective cannot be cleared. Sources are opt-in; re-selecting the full source list refreshes their snapshots.
Keep up to 20 packets, 8 revisions each, and 6 sources per packet. Total JSON plus reserved closing space must stay below 480,000 UTF-8 bytes; this quota can be reached before the count limits. Closing keeps history; copy needed packets with show/resume, then delete <id> confirm to free capacity. No model calls, execution, sending, or restoration of running sessions.`;

async function execute(command: string, ctx: AgentFeatureContext): Promise<string> {
  if (!text(command, 8000)) fail("Command must fit 8,000 characters without control characters.");
  const match = command.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const verb = match?.[1].toLowerCase() ?? "help";
  const args = (match?.[2] ?? "").trim();
  if (verb === "help") {
    if (args) fail("Use help without arguments.");
    return HELP;
  }
  ensureActive(ctx);
  const at = now(ctx);
  if (verb === "sources") {
    if (args.length > 100) fail("Source query must fit 100 characters.");
    const index = indexItems(await contextItems(ctx));
    const available = [...index.values()].filter(items => items.length === 1).map(items => snapshot(items[0]))
      .filter((s): s is Source => s !== null)
      .filter(s => !args || args === "-" || `${s.id} ${s.kind} ${s.title} ${s.excerpt}`.toLowerCase().includes(args.toLowerCase()))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!available.length) return "No selectable owner sources found. Capture explicit progress without sources, or try a different source query.";
    return ["Owner source candidates (not linked until you select IDs):", ...available.slice(0, 30).map(s => `${s.id} · ${s.kind} · ${display(s.title, 280)}`),
      `Showing ${Math.min(available.length, 30)} of ${available.length} matches. Narrow with sources <query>.`,
      "Select with capture … | sources: <id>,<id> or update <handoff-id> | sources: <id>,<id>."].join("\n");
  }
  if (verb === "capture") {
    const [objective, ...parts] = args.split("|").map(s => s.trim());
    if (!text(objective, FIELD_LIMITS.objective) || !objective) fail("Capture needs an objective of 1–240 characters, followed by | done: ... | next: ...");
    const patch = parsePatch(parts);
    if (patch.fields.objective !== undefined) fail("Capture takes the objective before the first |; do not repeat objective:.");
    if (patch.fields.done === undefined || patch.fields.next === undefined) fail("Capture needs explicit progress and next steps: | done: ... | next: ... (use - for none).");
    const sources = await selectSources(patch.sourceIds ?? [], ctx);
    const packet: Packet = { id: `hf_${randomUUID()}`, createdAt: at, revisions: [{
      number: 1, at, status: "open", fields: { objective, done: "", questions: "", next: "", constraints: "", ...patch.fields },
      sources, changes: [...CHANGES],
    }] };
    ensureActive(ctx);
    return ctx.store.update<State, string>(KEY, EMPTY, raw => {
      const current = state(raw);
      if (current.packets.length >= MAX_PACKETS) fail("Handoff storage is full (20 packets). Use list all, then delete <id> confirm to free a slot; closing does not free storage.");
      if (current.packets.some(p => p.id === packet.id)) fail("ID conflict; retry capture.");
      return { value: withinQuota({ ...current, packets: [...current.packets, packet] }), result: `Captured ${packet.id} · r1.\n${render(packet, latest(packet), ctx)}` };
    });
  }
  if (verb === "list") {
    const filter = args || "open";
    if (!["all", "open", "closed"].includes(filter)) fail("Use list [open|closed|all].");
    const saved = await read(ctx);
    const packets = saved.packets.filter(p => filter === "all" || latest(p).status === filter).reverse();
    const { used, reserved } = storageBudget(saved);
    const entries = packets.length ? packets.map(p => `${p.id} · r${latest(p).number} · ${latest(p).status}\n${display(latest(p).fields.objective, 480)}\nUpdated ${date(latest(p).at, ctx)}`).join("\n\n")
      : "No matching handoffs. Start with capture <objective> | done: <progress> | next: <steps>; use list all to include closed packets.";
    return `${entries}\n\nStorage: ${used} UTF-8 bytes + ${reserved} reserved for closing; limit below 480,000. Copy needed packets with show/resume, then delete <id> confirm to free space.`;
  }
  if (verb === "update") {
    const [head, ...parts] = args.split("|").map(s => s.trim());
    const { id, number } = idAndRevision(head);
    const patch = parsePatch(parts);
    const base = latest(find(await read(ctx), id));
    if (base.status === "closed") fail("This handoff is closed. Capture a new packet to continue; show and resume still provide reference context.");
    if (number !== undefined && number !== base.number) fail(`Revision conflict: current revision is r${base.number}. Show it before retrying your update.`);
    const sources = patch.sourceIds === undefined ? undefined : await selectSources(patch.sourceIds, ctx);
    ensureActive(ctx);
    return ctx.store.update<State, string>(KEY, EMPTY, raw => {
      const current = state(raw);
      const p = find(current, id);
      const previous = latest(p);
      if (previous.status === "closed" || previous.number !== base.number) fail("Handoff changed while updating. Nothing from this update was saved; show the current revision and retry.");
      const fields = { ...previous.fields, ...patch.fields };
      const changed: Change[] = (Object.keys(patch.fields) as Field[]).filter(field => fields[field] !== previous.fields[field]);
      if (sources !== undefined && JSON.stringify(sources) !== JSON.stringify(previous.sources)) changed.push("sources");
      if (!changed.length) return { value: current, result: `No changes; ${id} remains at r${previous.number}.` };
      const updated = append(p, { number: previous.number + 1, at, status: "open", fields, sources: sources ?? previous.sources, changes: changed });
      return { value: withinQuota(replace(current, updated)), result: `Updated ${id} · r${latest(updated).number}. Changed: ${changed.join(", ")}.\nUse resume ${id} for a context packet.` };
    });
  }
  if (verb === "close" || verb === "delete") {
    const parts = args.split(/\s+/);
    const id = getId(parts[0]);
    if (verb === "delete" && (parts.length !== 2 || parts[1] !== "confirm")) fail(`Delete permanently removes this packet and its revisions. Use delete ${id} confirm.`);
    if (verb === "close" && parts.length !== 1) fail("Use close <id>.");
    return ctx.store.update<State, string>(KEY, EMPTY, raw => {
      const current = state(raw);
      const packet = find(current, id);
      if (verb === "delete") return { value: { ...current, packets: current.packets.filter(p => p.id !== id) }, result: `Deleted ${id} and all retained revisions.` };
      const previous = latest(packet);
      if (previous.status === "closed") return { value: current, result: `${id} is already closed at r${previous.number}.` };
      const closed = append(packet, { ...previous, number: previous.number + 1, at, status: "closed", changes: ["status"] });
      return { value: withinQuota(replace(current, closed)), result: `Closed ${id} · r${latest(closed).number}. History remains available with show, revisions, and resume (reference only).` };
    });
  }
  if (verb === "show" || verb === "resume" || verb === "revisions") {
    const { id, number } = idAndRevision(args);
    if (number !== undefined && verb !== "show") fail(`Use ${verb} <id>. Historical snapshots are available with show <id> rN.`);
    const packet = find(await read(ctx), id);
    if (verb === "revisions") return [`${id}: retained revisions (newest first; at most 8)`, ...[...packet.revisions].reverse().map(r => `r${r.number} · ${r.status} · ${date(r.at, ctx)} · ${r.changes.join(", ")}`), "Inspect with show <id> rN."].join("\n");
    const r = number === undefined ? latest(packet) : packet.revisions.find(r => r.number === number);
    if (!r) fail(`Revision r${number} is not retained. Available: ${packet.revisions.map(r => `r${r.number}`).join(", ")}.`);
    return render(packet, r, ctx, verb === "resume" ? await sourceChecks(r, ctx) : undefined);
  }
  return "Unknown handoffs command. Use help for capture, list, show, resume, update, close, revisions, sources, and delete.";
}

export const feature: AgentFeature = {
  id: "handoffs",
  title: "Session handoff packets",
  description: "Carry explicit progress and selected personal context into a new session, with revisions and source freshness checks.",
  help: HELP,
  async execute(command, context) {
    try {
      const result = await execute(command, context);
      return result.length <= 27_500 ? result : `${result.slice(0, 27_300)}\n[Output shortened to fit Slack. Use show and revisions to inspect saved state.]`;
    } catch (error) {
      if (error instanceof HandoffError) return error.message;
      return "Handoffs could not complete this request. Check list/show before retrying; no automatic retry or reset was attempted.";
    }
  },
};
export default feature;
