import { randomUUID } from "node:crypto";
import type { AgentContextKind, AgentFeature, AgentFeatureContext } from "./types.js";

const KEY = "packets";
const MAX_MEETINGS = 12;
const MAX_HISTORY = 3;
const MAX_CONTEXT = 5;
const MAX_SOURCES = 6;
// Leave headroom beneath the runtime's 512,000-byte scoped JSON limit.
const MAX_STATE_BYTES = 480_000;
const KINDS: AgentContextKind[] = ["note", "goal", "follow-up", "reminder", "memory", "event", "artifact"];
const HELP = `Private meeting preparation from a meeting you explicitly supply.
prepare <title> | <details>
list
show <id> [packet-number]
add-context <id> | <text>
refresh <id>
delete <id> confirm
Example: prepare Atlas launch | purpose: Agree the launch date; attendees: Ana, Dev; when: 2026-11-12T10:00:00-06:00; Resolve the Atlas rollout risks.
Details can be plain text. Optional purpose:, attendees:, and when: fields use semicolons or newlines. when: requires an ISO date/time with an explicit offset and must be upcoming at creation. No time is inferred when omitted.
Preparation matches words against your own context and proposes agenda items/questions without a model. add-context saves up to 5 notes; refresh incorporates them and rereads owner context. Up to 12 meetings and 3 packet versions per meeting are retained. No calendar writes or attendee lookups.`;

type Note = { id: string; text: string; createdAt: string };
type Source = {
  id: string;
  kind: AgentContextKind;
  title: string;
  text: string;
  updatedAt?: string;
  dueAt?: string;
  status?: string;
};
type Packet = { number: number; revision: number; capturedAt: string; notes: Note[]; sources: Source[]; scanned: number };
type Meeting = { id: string; title: string; details: string; createdAt: string; revision: number; notes: Note[]; packets: Packet[] };
type State = { schema: 1; meetings: Meeting[] };
type Details = { purpose?: string; attendees?: string; when?: string; free: string[] };

class InputError extends Error {}
const emptyState = (): State => ({ schema: 1, meetings: [] });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000_000;
const meetingId = (id: string): boolean => /^mp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id);
const noteId = (id: string): boolean => /^ctx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id);
const keysOnly = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const canonicalDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const unique = <T>(values: T[], key: (value: T) => string): boolean => new Set(values.map(key)).size === values.length;

/** Reject rollover dates and offset-less times instead of using the host timezone. */
function explicitDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, , offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return undefined;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 || (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0))) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const canonical = new Date(parsed).toISOString();
  return canonicalDate(canonical) ? canonical : undefined;
}

function parseDetails(text: string): Details {
  const result: Details = { free: [] };
  for (const part of text.split(/[;\n]/u).map((part) => part.trim()).filter(Boolean)) {
    const field = /^(purpose|attendees|when)\s*:\s*(.*)$/iu.exec(part);
    if (!field) { result.free.push(part); continue; }
    const key = field[1].toLowerCase() as "purpose" | "attendees" | "when";
    if (result[key] !== undefined || !field[2].trim()) throw new InputError(`Supply one nonempty ${key}: field.`);
    if (key === "when") {
      const when = explicitDate(field[2].trim());
      if (!when) throw new InputError("when: needs a valid ISO date/time with an explicit offset, e.g. 2026-11-12T10:00:00-06:00.");
      result.when = when;
    } else result[key] = field[2].trim();
  }
  if (!result.purpose && result.free.length) result.purpose = result.free.join("; ");
  if (!result.purpose && !result.attendees && !result.when) throw new InputError("Supply meeting details, such as purpose: Agree the launch date.");
  return result;
}

function validNote(value: unknown): value is Note {
  return record(value) && keysOnly(value, ["id", "text", "createdAt"]) && typeof value.id === "string" && noteId(value.id) && validText(value.text, 800) && canonicalDate(value.createdAt);
}
function validSource(value: unknown): value is Source {
  return record(value) && keysOnly(value, ["id", "kind", "title", "text", "updatedAt", "dueAt", "status"])
    && validText(value.id, 160) && KINDS.includes(value.kind as AgentContextKind) && validText(value.title, 140) && typeof value.text === "string" && value.text.length <= 600 && (value.text === "" || validText(value.text, 600))
    && (value.updatedAt === undefined || canonicalDate(value.updatedAt)) && (value.dueAt === undefined || canonicalDate(value.dueAt)) && (value.status === undefined || validText(value.status, 60));
}
function validPacket(value: unknown): value is Packet {
  return record(value) && keysOnly(value, ["number", "revision", "capturedAt", "notes", "sources", "scanned"])
    && integer(value.number) && integer(value.revision) && value.number <= value.revision && canonicalDate(value.capturedAt)
    && Array.isArray(value.notes) && value.notes.length <= MAX_CONTEXT && value.notes.every(validNote) && unique(value.notes, (note) => note.id)
    && Array.isArray(value.sources) && value.sources.length <= MAX_SOURCES && value.sources.every(validSource) && unique(value.sources, (source) => `${source.kind}:${source.id}`)
    && Number.isInteger(value.scanned) && Number(value.scanned) >= value.sources.length && Number(value.scanned) <= 200;
}
function validMeeting(value: unknown): value is Meeting {
  if (!record(value) || !keysOnly(value, ["id", "title", "details", "createdAt", "revision", "notes", "packets"]) || typeof value.id !== "string" || !meetingId(value.id) || !validText(value.title, 120) || !validText(value.details, 1600) || !canonicalDate(value.createdAt) || !integer(value.revision)) return false;
  try { parseDetails(value.details); } catch { return false; }
  if (!Array.isArray(value.notes) || value.notes.length > MAX_CONTEXT || !value.notes.every(validNote) || !unique(value.notes, (note) => note.id) || !Array.isArray(value.packets) || !value.packets.length || value.packets.length > MAX_HISTORY || !value.packets.every(validPacket)) return false;
  const notes = value.notes;
  const packets = value.packets;
  const revision = value.revision;
  return revision === packets[0].number + notes.length
    && packets.every((packet, index) => packet.revision === packet.number + packet.notes.length && packet.revision <= revision && packet.notes.every((note, noteIndex) => notes[noteIndex]?.id === note.id && notes[noteIndex].text === note.text && notes[noteIndex].createdAt === note.createdAt) && (index === 0 || (packets[index - 1].number === packet.number + 1 && packets[index - 1].revision > packet.revision)));
}
function validateState(value: unknown): State {
  if (!record(value) || !keysOnly(value, ["schema", "meetings"]) || value.schema !== 1 || !Array.isArray(value.meetings) || value.meetings.length > MAX_MEETINGS || !value.meetings.every(validMeeting) || !unique(value.meetings, (meeting) => meeting.id)) {
    throw new InputError("Saved meeting-prep data is invalid or uses an unsupported schema. No changes were made; ask the administrator to restore this feature's scoped data.");
  }
  return value as State;
}
async function readState(context: AgentFeatureContext): Promise<State> {
  const state = await context.store.read<unknown>(KEY);
  return state === null ? emptyState() : validateState(state);
}
function boundedState(state: State): State {
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) {
    throw new InputError("Meeting preparation storage is full. This change was not saved. Use list, then delete <id> confirm to free space before retrying.");
  }
  return state;
}

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 12)}… [excerpt]`;
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
// Slack control/mention sequences from supplied text must stay inert in private replies.
function escape(text: string, max = 1600): string {
  const escaped = text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  // Bound the encoded response too: a single '&' expands to five characters.
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 12).replace(/&[^;]*$/u, "")}… [excerpt]`;
}
const oneLine = (text: string, max: number): string => escape(clean(text), max);
const STOP = new Set("the and with from that this for are was will have has into about purpose attendees when meeting prepare context next our your you not but can all then they their discuss discussion sync review weekly daily please should could would what which how who why any also open date time agenda".split(" "));
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3 && !STOP.has(word)).slice(0, 250));
}
function score(source: Source, terms: Set<string>): number {
  const title = words(source.title), body = words(source.text);
  let result = 0;
  for (const term of terms) result += (title.has(term) ? 3 : 0) + (body.has(term) ? 1 : 0);
  return result;
}
function sourceFrom(value: unknown): Source | undefined {
  if (!record(value) || !validText(value.id, 160) || !KINDS.includes(value.kind as AgentContextKind) || typeof value.title !== "string" || typeof value.text !== "string") return undefined;
  const source: Source = { id: value.id, kind: value.kind as AgentContextKind, title: clip(clean(value.title) || "Untitled owner source", 140), text: clip(clean(value.text), 600) };
  for (const key of ["updatedAt", "dueAt"] as const) {
    const date = explicitDate(value[key]);
    if (date) source[key] = date;
  }
  if (typeof value.status === "string" && clean(value.status)) source.status = clip(clean(value.status), 60);
  return source;
}
async function collect(meeting: Meeting, context: AgentFeatureContext): Promise<{ sources: Source[]; scanned: number }> {
  if (context.signal?.aborted) throw new InputError("Preparation cancelled; no packet was saved.");
  let items: unknown;
  try { items = await context.services.readContext([...KINDS]); }
  catch { throw new InputError("Owner context is unavailable. No packet was saved or replaced; try prepare/refresh again later. Your saved meeting and added context remain available with show."); }
  if (!Array.isArray(items)) throw new InputError("Owner context returned an invalid response. No packet was saved or replaced; try again later.");
  const terms = words(`${meeting.title} ${meeting.details} ${meeting.notes.map((note) => note.text).join(" ")}`);
  const seen = new Set<string>();
  const ranked: { source: Source; score: number }[] = [];
  for (const item of items.slice(0, 200)) {
    const source = sourceFrom(item);
    if (!source || seen.has(`${source.kind}:${source.id}`)) continue;
    seen.add(`${source.kind}:${source.id}`);
    const relevance = score(source, terms);
    if (relevance > 0) ranked.push({ source, score: relevance });
  }
  ranked.sort((a, b) => b.score - a.score || a.source.kind.localeCompare(b.source.kind) || a.source.id.localeCompare(b.source.id));
  if (context.signal?.aborted) throw new InputError("Preparation cancelled; no packet was saved.");
  return { sources: ranked.slice(0, MAX_SOURCES).map(({ source }) => source), scanned: Math.min(items.length, 200) };
}
function local(date: string, context: AgentFeatureContext): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: context.timezone, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(date));
}
const commitmentKind = (source: Source): boolean => ["goal", "follow-up", "reminder"].includes(source.kind);
const closed = (source: Source): boolean => /^(done|completed|complete|closed|cancelled|canceled|archived|dismissed|resolved)$/iu.test(source.status ?? "");
const open = (source: Source): boolean => /^(open|active|pending|in[-_ ]progress|todo|scheduled|overdue|blocked)$/iu.test(source.status ?? "");
function render(meeting: Meeting, packet: Packet, context: AgentFeatureContext): string {
  const details = parseDetails(meeting.details);
  const lines = [
    `Meeting preparation: ${oneLine(meeting.title, 120)}`,
    `ID: ${meeting.id} • packet ${packet.number} • captured ${local(packet.capturedAt, context)} (${escape(context.timezone)})`,
    "Facts below are supplied/source-reported, not independently verified. Owner context was matched by shared words; relevance may be incomplete.",
  ];
  if (packet !== meeting.packets[0]) lines.push("Historical packet: source excerpts reflect this saved version.");
  if (meeting.revision > meeting.packets[0].revision) lines.push(`Added context is waiting to be incorporated. Run refresh ${meeting.id}.`);
  lines.push("", "Meeting facts — supplied by you [M]", `Purpose: ${details.purpose ? oneLine(details.purpose, 900) : "Not supplied; clarify the desired outcome."}`, `Attendees: ${details.attendees ? oneLine(details.attendees, 500) : "Not supplied; confirm who needs to attend."}`);
  if (details.when) lines.push(`When: ${local(details.when, context)} (${escape(context.timezone)})${Date.parse(details.when) <= context.now.getTime() ? " — this supplied time has passed" : ""}`);
  else lines.push("When: not supplied; no calendar event or meeting time was inferred.");
  lines.push("", "Relevant owner context — saved source excerpts");
  if (!packet.sources.length) lines.push("No matching owner sources found. Add project names, decisions, or promises with add-context, then refresh.");
  packet.sources.forEach((source, index) => lines.push(`[S${index + 1}] ${oneLine(source.title, 140)} (${source.kind}; source ID: ${oneLine(source.id, 160)})${source.updatedAt ? ` • updated ${local(source.updatedAt, context)}` : " • update time unknown"}\n${escape(source.text || "No source text supplied.", 600)}${source.status ? `\nReported status: ${oneLine(source.status, 60)}` : ""}`));
  lines.push("", "Open commitments — source-reported");
  const commitments = packet.sources.map((source, index) => ({ source, ref: `S${index + 1}` })).filter(({ source }) => commitmentKind(source) && !closed(source));
  const knownOpen = commitments.filter(({ source }) => open(source));
  if (!knownOpen.length) lines.push("No explicitly open commitments in the matched sources. This is not a complete task inventory.");
  for (const { source, ref } of knownOpen) lines.push(`• [${ref}] ${oneLine(source.title, 140)} — ${source.dueAt ? `due ${local(source.dueAt, context)}${Date.parse(source.dueAt) < context.now.getTime() ? " (past the reported due time)" : ""}` : "due time not supplied"}`);
  const unknown = commitments.filter(({ source }) => !open(source));
  for (const { source, ref } of unknown) lines.push(`• [${ref}] Verify status: ${oneLine(source.title, 140)} — not classified as open because its status is unknown/unrecognized.`);
  lines.push("", "Proposed agenda — suggestions, not established facts", "1. Confirm the meeting purpose and desired decision/output [M].");
  if (packet.sources.length) lines.push(`2. Review the relevant source excerpts and resolve stale or conflicting information [${packet.sources.map((_, index) => `S${index + 1}`).join(", ")}].`);
  else lines.push("2. Establish the background and constraints [M].");
  if (commitments.length) lines.push(`3. Check progress, blockers, and due dates for the matched commitments [${commitments.map(({ ref }) => ref).join(", ")}].`);
  else lines.push("3. Identify decisions, dependencies, and any outstanding promises [M].");
  lines.push("4. Agree next steps, owners, and checkpoints; record them after the meeting [M].", "", "Suggested questions — prompts to consider, not facts", "• What outcome or decision would make this meeting useful? [M]");
  if (!details.attendees) lines.push("• Who needs to participate or approve the outcome? [M]");
  for (const { source, ref } of commitments.slice(0, 3)) lines.push(`• What is the current status of “${oneLine(source.title, 140)}”, and what help or decision is needed? [${ref}]`);
  const background = packet.sources.findIndex((source) => !commitmentKind(source));
  if (background >= 0) lines.push(`• Does “${oneLine(packet.sources[background].title, 140)}” still describe the situation, or has anything changed? [S${background + 1}]`);
  if (packet.notes.length) lines.push(`• Which decisions or constraints in the added context need agreement? [${packet.notes.map((_, index) => `C${index + 1}`).join(", ")}]`);
  lines.push("• What should each person leave knowing or owning? [M]", "", "Supplied sources preserved with this packet", `[M] ${meeting.id} • captured ${local(meeting.createdAt, context)}\n${escape(meeting.details)}`);
  packet.notes.forEach((note, index) => lines.push(`[C${index + 1}] ${note.id} • captured ${local(note.createdAt, context)}\n${escape(note.text, 800)}`));
  const pending = meeting.notes.filter((note) => !meeting.packets[0].notes.some((saved) => saved.id === note.id));
  if (pending.length) lines.push("", "Added context pending refresh", ...pending.map((note) => `${note.id}: ${escape(note.text, 800)}`));
  lines.push("", `Retained packets: ${meeting.packets.map((saved) => saved.number).join(", ")}. Read an older packet with show ${meeting.id} <packet-number>. Scanned up to ${packet.scanned} owner records; retained at most ${MAX_SOURCES} matches. No attendees were contacted or looked up.`);
  return lines.join("\n");
}

function findMeeting(state: State, id: string): Meeting {
  if (!meetingId(id)) throw new InputError("Use the full meeting ID from list (mp-…).");
  const meeting = state.meetings.find((item) => item.id === id);
  if (!meeting) throw new InputError("Meeting not found. Use list to see retained meetings, or prepare <title> | <details> to create one.");
  return meeting;
}
function splitPipe(input: string, usage: string): [string, string] {
  const separator = input.indexOf("|");
  if (separator < 0) throw new InputError(usage);
  const first = input.slice(0, separator).trim(), second = input.slice(separator + 1).trim();
  if (!first || !second) throw new InputError(usage);
  return [first, second];
}
function changed(meeting: Meeting): number {
  if (meeting.revision >= 1_000_000_000) throw new InputError("This meeting has reached its revision limit. Prepare a new meeting.");
  return meeting.revision + 1;
}

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  const input = command.trim();
  if (!input || input === "help") return HELP;
  try {
    if (!validText(input, 2000)) throw new InputError("Command is too long or contains control characters. Keep titles to 120, details to 1600, and added context to 800 characters.");
    if (!Number.isFinite(context.now.getTime())) throw new InputError("A valid current time is required from the runtime.");
    try { new Intl.DateTimeFormat("en-US", { timeZone: context.timezone }).format(context.now); }
    catch { throw new InputError("A valid IANA timezone is required from your preferences; no server-local timezone was used."); }
    if (!context.timezone?.trim()) throw new InputError("A timezone is required from your preferences; no server-local timezone was used.");
    const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)!;
    const action = match[1].toLowerCase(), args = (match[2] ?? "").trim();
    if (action === "list" && !args) {
      const state = await readState(context);
      if (!state.meetings.length) return "No meeting packets yet. Start with prepare <title> | <details>, for example: prepare Atlas launch | purpose: Agree the launch date; attendees: Ana, Dev.";
      return ["Your meeting preparations (up to 12 most recently created):", ...state.meetings.map((meeting) => `${meeting.id} — ${oneLine(meeting.title, 120)} • packet ${meeting.packets[0].number} • ${local(meeting.createdAt, context)}${meeting.revision > meeting.packets[0].revision ? " • added context pending refresh" : ""}`), "Use show <id> or refresh <id>."].join("\n");
    }
    if (action === "show") {
      const tokens = args.split(/\s+/u);
      if (tokens.length > 2 || (tokens[1] !== undefined && !/^[1-9]\d{0,9}$/u.test(tokens[1]))) throw new InputError("Use show <id> [packet-number].");
      const meeting = findMeeting(await readState(context), tokens[0]);
      const packet = tokens[1] ? meeting.packets.find((saved) => saved.number === Number(tokens[1])) : meeting.packets[0];
      if (!packet) throw new InputError(`Packet not retained. Available packet numbers: ${meeting.packets.map((saved) => saved.number).join(", ")}.`);
      return render(meeting, packet, context);
    }
    if (action === "prepare") {
      const [title, details] = splitPipe(args, "Use prepare <title> | <details>.");
      if (!validText(title, 120) || /[\r\n]/u.test(title) || !validText(details, 1600)) throw new InputError("Use a single-line title of 1–120 characters and details of 1–1600 characters.");
      const parsed = parseDetails(details);
      if (parsed.when && Date.parse(parsed.when) <= context.now.getTime()) throw new InputError("The supplied when: time has passed. Prepare an upcoming meeting or omit when: if its time is unknown.");
      await readState(context); // Reject corrupt state before any provider work.
      const now = context.now.toISOString();
      const meeting: Meeting = { id: `mp-${randomUUID()}`, title, details, createdAt: now, revision: 1, notes: [], packets: [] };
      const collected = await collect(meeting, context);
      meeting.packets = [{ number: 1, revision: 1, capturedAt: now, notes: [], ...collected }];
      await context.store.update<State, void>(KEY, emptyState(), (current) => ({ value: boundedState({ schema: 1, meetings: [meeting, ...validateState(current).meetings].slice(0, MAX_MEETINGS) }), result: undefined }));
      return render(meeting, meeting.packets[0], context);
    }
    if (action === "add-context") {
      const [id, text] = splitPipe(args, "Use add-context <id> | <text>.");
      if (!meetingId(id) || !validText(text, 800)) throw new InputError("Use add-context <full-meeting-id> | <text of 1–800 characters>.");
      const note: Note = { id: `ctx-${randomUUID()}`, text, createdAt: context.now.toISOString() };
      await context.store.update<State, void>(KEY, emptyState(), (current) => {
        const state = validateState(current), meeting = findMeeting(state, id);
        if (meeting.notes.length >= MAX_CONTEXT) throw new InputError("This meeting already has 5 context notes. Prepare a new meeting if you need a larger brief; delete <id> confirm removes an old meeting.");
        const next = { ...meeting, revision: changed(meeting), notes: [...meeting.notes, note] };
        return { value: boundedState({ ...state, meetings: state.meetings.map((item) => item.id === id ? next : item) }), result: undefined };
      });
      return `Context saved as ${note.id}. Existing packet sources are preserved. Run refresh ${id} to incorporate it; show ${id} includes the pending context.`;
    }
    if (action === "refresh") {
      const meeting = findMeeting(await readState(context), args);
      const collected = await collect(meeting, context);
      const revision = changed(meeting);
      const packet: Packet = { number: meeting.packets[0].number + 1, revision, capturedAt: context.now.toISOString(), notes: meeting.notes.map((note) => ({ ...note })), ...collected };
      const next: Meeting = { ...meeting, revision, packets: [packet, ...meeting.packets].slice(0, MAX_HISTORY) };
      const saved = await context.store.update<State, boolean>(KEY, emptyState(), (current) => {
        const state = validateState(current), latest = state.meetings.find((item) => item.id === meeting.id);
        if (!latest || latest.revision !== meeting.revision) return { value: state, result: false };
        return { value: boundedState({ ...state, meetings: state.meetings.map((item) => item.id === meeting.id ? next : item) }), result: true };
      });
      if (!saved) return "This meeting changed or was deleted while refresh was reading context. The stale refresh was discarded. Use list/show, then refresh again if needed.";
      return render(next, packet, context);
    }
    if (action === "delete") {
      const tokens = args.split(/\s+/u);
      if (tokens.length !== 2 || tokens[1] !== "confirm" || !meetingId(tokens[0])) throw new InputError("Delete removes the meeting, all added context, and its saved packets. Use delete <id> confirm.");
      await context.store.update<State, void>(KEY, emptyState(), (current) => {
        const state = validateState(current);
        findMeeting(state, tokens[0]);
        return { value: { ...state, meetings: state.meetings.filter((meeting) => meeting.id !== tokens[0]) }, result: undefined };
      });
      return "Meeting preparation and all of its saved packets/context were deleted.";
    }
    return `Unknown command or extra arguments.\n${HELP}`;
  } catch (error) {
    if (error instanceof InputError) return error.message;
    return "Meeting preparation could not finish accessing saved data. Try list/show before retrying. No external actions were performed.";
  }
}

export const feature: AgentFeature = {
  id: "meeting-prep",
  title: "Meeting preparation briefs",
  description: "Prepare a private, source-backed packet for a supplied upcoming meeting, with owner context, commitments, agenda suggestions and questions.",
  help: HELP,
  execute,
};
export default feature;
