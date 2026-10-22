import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { AgentFeature, AgentFeatureContext } from "./types.js";

const KEY = "relationships.v1";
const LIMIT = { contacts: 50, notes: 8, touches: 20, promises: 12 };
const DAY = 86_400_000;
const MAX_REPLY = 27_500;
const CONTENT_BYTES = 460_000;
const STATE_BYTES = 479_000;
// Completing 50 × 12 open promises adds at most 13,200 bytes (null → quoted
// 24-character timestamp); pausing all 50 numeric cadences adds at most 150.
// Reserve 19,000 bytes so these lifecycle changes cannot be blocked by new text.

type Note = { id: string; text: string; recordedAt: string };
type Touch = { id: string; date: string; text: string; recordedAt: string };
type PromiseRecord = {
  id: string;
  text: string;
  dueDate: string | null;
  createdAt: string;
  keptAt: string | null;
};
type Contact = {
  id: string;
  name: string;
  cadenceDays: number | null;
  createdAt: string;
  updatedAt: string;
  notes: Note[];
  touches: Touch[];
  promises: PromiseRecord[];
};
type State = { version: 1; contacts: Contact[] };

class InputError extends Error {}

const HELP = `Relationship follow-through — private, user-entered contacts only.
Prefix every command with /nobo-help agent relationships

add <name> | <cadence-days> [| <private context>]
log <contact-id> | <YYYY-MM-DD or today> | <meaningful touchpoint>
log <contact-id> note | <private context>
log <contact-id> promise | <promise you made> [| <YYYY-MM-DD>]
log <contact-id> kept | <promise-id>
cadence <contact-id> <1-365 days or pause>
due [YYYY-MM-DD] — today or a future date in your timezone
brief <contact-id> — context, history, and open promises
draft <contact-id> [| <topic to include>]
list
show <contact-id> [entry-id]
delete <contact-id> confirm

Example: add Maya Chen | 30 | Met at the neighborhood garden
Then: log <contact-id> | today | Talked about the spring planting plan
Then: log <contact-id> promise | Share my seed list | 2026-10-30
Then: due, brief <contact-id>, or draft <contact-id> | Spring planting ideas

Drafts are editable, fact-based templates; nothing is sent. Private notes stay outside the message text. Logging a note/promise or drafting does not count as a touchpoint. Cadence uses calendar days, not 24-hour timers. Pausing cadence still surfaces due promises.
Limits: 50 contacts, 8 recent notes, 20 most recent dated touchpoints, 12 promises per contact. Open promises are never automatically removed. Names: 100 characters; notes: 500; touchpoints: 600; promises/topics: 400. Use | as a separator, not inside a field.
Storage: 460,000 UTF-8 JSON bytes for content, with 19,000 additional bytes reserved for marking promises kept and changing cadence. At quota, use shorter text or delete <contact-id> confirm to free space. List shows current usage; reads and drafts remain available.`;

function fail(message: string): never { throw new InputError(message); }
function empty(): State { return { version: 1, contacts: [] }; }
function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function text(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!validText(trimmed, max)) fail(`${label} must contain 1–${max} characters without control characters.`);
  return trimmed;
}
function idValid(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(value);
}
function id(value: string, prefix = "rel"): string {
  if (!idValid(value, prefix)) fail(`Use the exact ${prefix === "rel" ? "contact" : "promise"} ID from list/show.`);
  return value;
}
function dateValid(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dateInput(value: string): string {
  if (!dateValid(value)) fail("Use a real calendar date in YYYY-MM-DD format (for example, 2026-10-22).");
  return value;
}
function timestampValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function serial(date: string): number { return Date.parse(`${date}T00:00:00.000Z`) / DAY; }
function plusDays(date: string, days: number): string {
  return new Date((serial(date) + days) * DAY).toISOString().split("T")[0];
}
function clock(context: AgentFeatureContext): { today: string; now: string } {
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) fail("A valid current time is required from the runtime.");
  if (typeof context.timezone !== "string" || !context.timezone.trim()) fail("A valid timezone is required; set your timezone before using relationships.");
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: context.timezone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(context.now);
  } catch { return fail("The supplied timezone is invalid; set a valid timezone before using relationships."); }
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  const today = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  dateInput(today);
  return { today, now: context.now.toISOString() };
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function arrayValid(value: unknown, max: number, validate: (item: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length <= max && value.every(validate)
    && new Set(value.map((item: { id: unknown }) => item.id)).size === value.length;
}
function noteValid(value: unknown): boolean {
  return shape(value, ["id", "text", "recordedAt"]) && idValid(value.id, "note")
    && validText(value.text, 500) && timestampValid(value.recordedAt);
}
function touchValid(value: unknown): boolean {
  return shape(value, ["id", "date", "text", "recordedAt"]) && idValid(value.id, "touch")
    && dateValid(value.date) && validText(value.text, 600) && timestampValid(value.recordedAt);
}
function promiseValid(value: unknown): boolean {
  return shape(value, ["id", "text", "dueDate", "createdAt", "keptAt"]) && idValid(value.id, "promise")
    && validText(value.text, 400) && (value.dueDate === null || dateValid(value.dueDate))
    && timestampValid(value.createdAt) && (value.keptAt === null || timestampValid(value.keptAt));
}
function contactValid(value: unknown): boolean {
  return shape(value, ["id", "name", "cadenceDays", "createdAt", "updatedAt", "notes", "touches", "promises"])
    && idValid(value.id, "rel") && validText(value.name, 100) && !/[\r\n\t]/.test(value.name)
    && (value.cadenceDays === null || (Number.isInteger(value.cadenceDays) && (value.cadenceDays as number) >= 1 && (value.cadenceDays as number) <= 365))
    && timestampValid(value.createdAt) && timestampValid(value.updatedAt)
    && arrayValid(value.notes, LIMIT.notes, noteValid) && arrayValid(value.touches, LIMIT.touches, touchValid)
    && arrayValid(value.promises, LIMIT.promises, promiseValid);
}
function state(value: unknown): State {
  if (!shape(value, ["version", "contacts"]) || value.version !== 1
    || !arrayValid(value.contacts, LIMIT.contacts, contactValid)) {
    fail("Saved relationship data is invalid or from an unsupported version. Nothing was changed; ask the runtime maintainer to repair it without resetting your contacts.");
  }
  return value as State;
}
async function read(context: AgentFeatureContext): Promise<State> {
  const value = await context.store.read<unknown>(KEY);
  return value === null ? empty() : state(value);
}
function serializedBytes(value: State): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
async function edit(
  context: AgentFeatureContext,
  transform: (draft: State) => string,
  mode: "content" | "lifecycle" = "content",
): Promise<string> {
  return context.store.update<unknown, string>(KEY, empty(), (current) => {
    // Never mutate the caller's value: optimistic store adapters may retry this callback.
    const next = structuredClone(state(current));
    const result = transform(next);
    const size = serializedBytes(next);
    const limit = mode === "content" ? CONTENT_BYTES : STATE_BYTES;
    if (size > limit) {
      fail(`Relationship storage quota reached: this change would use ${size} UTF-8 JSON bytes; the ${mode} limit is ${limit}. Nothing was changed. Use shorter text or inspect list/show, then delete <contact-id> confirm to free space. Marking existing promises kept and changing cadence have reserved space; reads and drafts remain available.`);
    }
    return { value: next, result };
  });
}
function contact(data: State, contactId: string): Contact {
  const found = data.contacts.find((item) => item.id === contactId);
  return found ?? fail("Contact not found. Use list for your contact IDs, or add a contact first.");
}
function cadence(value: string): number | null {
  if (value === "pause") return null;
  if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 365) fail("Cadence must be a whole number of days from 1 to 365, or pause.");
  return Number(value);
}
function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function snippet(value: string, max = 150): string {
  const safe = escaped(value.replace(/\s+/g, " "));
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}
function bound(value: string): string {
  const suffix = "\n… Reply shortened. Use show <contact-id> <entry-id> for a complete individual entry.";
  return value.length <= MAX_REPLY ? value : value.slice(0, MAX_REPLY - suffix.length) + suffix;
}
function latestTouches(item: Contact): Touch[] {
  return [...item.touches].sort((a, b) => b.date.localeCompare(a.date)
    || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
}
function openPromises(item: Contact): PromiseRecord[] {
  return item.promises.filter((promise) => promise.keptAt === null)
    .sort((a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99")
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function cadenceLabel(item: Contact): string {
  return item.cadenceDays === null ? "paused" : `every ${item.cadenceDays} calendar days`;
}
function status(item: Contact, date: string): { reason: string; due: boolean; priority: number } {
  const last = latestTouches(item)[0];
  if (item.cadenceDays === null) return { reason: "Reconnect cadence is paused.", due: false, priority: Infinity };
  if (!last) return {
    reason: `No meaningful touchpoint recorded; choose an initial check-in (${cadenceLabel(item)}).`,
    due: true, priority: serial(date),
  };
  const next = plusDays(last.date, item.cadenceDays);
  const elapsed = serial(date) - serial(last.date);
  const overdue = serial(date) - serial(next);
  return {
    reason: `Last touchpoint ${last.date} (${elapsed} calendar days ago); ${cadenceLabel(item)} → ${overdue > 0 ? `${overdue} days overdue since` : overdue === 0 ? "due today," : "next due"} ${next}.`,
    due: overdue >= 0, priority: serial(next),
  };
}
function duePromises(item: Contact, date: string): PromiseRecord[] {
  return openPromises(item).filter((promise) => promise.dueDate !== null && promise.dueDate <= date);
}
function promiseLine(promise: PromiseRecord, today: string, full = false): string {
  const due = promise.dueDate ? `due ${promise.dueDate}${promise.keptAt === null && promise.dueDate <= today ? " — due now/overdue" : ""}` : "no due date";
  return `- ${promise.id} [${promise.keptAt ? "kept" : "open"}; ${due}] ${full ? escaped(promise.text) : snippet(promise.text, 300)}${promise.keptAt ? ` (marked kept ${promise.keptAt})` : ""}`;
}
function overview(item: Contact, today: string, full: boolean): string {
  const touches = latestTouches(item);
  const promises = full ? item.promises : openPromises(item);
  return [
    `${full ? "Contact" : "Relationship brief"}: ${escaped(item.name)} — ${item.id}`,
    `Cadence: ${cadenceLabel(item)}. ${status(item, today).reason}`,
    `As of ${today}. Added ${item.createdAt}; last edited ${item.updatedAt}.`,
    "", "Private context notes (not included in outreach drafts):",
    ...item.notes.slice(0, full ? LIMIT.notes : 3).map((note) => `- ${note.id} (${note.recordedAt}): ${snippet(note.text, 500)}`),
    ...(item.notes.length ? [] : ["No context notes. Add one with log <contact-id> note | <context>."]),
    "", full ? "Retained meaningful touchpoints:" : "Recent meaningful touchpoints:",
    ...touches.slice(0, full ? LIMIT.touches : 3).map((touch) => `- ${touch.date} — ${touch.id}: ${snippet(touch.text, 600)}`),
    ...(touches.length ? [] : ["None recorded. Use log <contact-id> | today | <what mattered>."]),
    "", full ? "Promises:" : "Open promises:",
    ...promises.map((promise) => promiseLine(promise, today)),
    ...(promises.length ? [] : ["None recorded."]),
    "", "Next step: choose a check-in, honor an open promise, or use draft <contact-id>. Nothing is scheduled or sent.",
    "Use show <contact-id> <entry-id> for a full note, touchpoint, or promise.",
  ].join("\n");
}

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  try {
    if (typeof command !== "string" || command.length > 4_000) fail("Commands must be at most 4,000 characters. Use help for syntax.");
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.trim());
    const verb = match?.[1].toLowerCase() ?? "help";
    const args = match?.[2]?.trim() ?? "";
    if (verb === "help") {
      if (args) fail("Use help without arguments.");
      return HELP;
    }
    const { today, now } = clock(context);
    if (context.signal?.aborted) fail("The request was cancelled before work began.");
    const fields = args.split("|").map((field) => field.trim());

    if (verb === "add") {
      if (fields.length < 2 || fields.length > 3) fail("Use add <name> | <cadence-days> [| <private context>].");
      const name = text(fields[0], "Name", 100);
      if (/[\r\n\t]/.test(name)) fail("Names must be on one line without tabs.");
      const days = cadence(fields[1]);
      const note = fields.length === 3 ? text(fields[2], "Context", 500) : null;
      const newContact: Contact = {
        id: `rel_${randomUUID()}`, name, cadenceDays: days, createdAt: now, updatedAt: now,
        notes: note ? [{ id: `note_${randomUUID()}`, text: note, recordedAt: now }] : [],
        touches: [], promises: [],
      };
      return await edit(context, (data) => {
        if (data.contacts.length >= LIMIT.contacts) fail("Contact limit reached (50). Delete an unneeded contact with delete <contact-id> confirm before adding another.");
        data.contacts.push(structuredClone(newContact));
        return `Added ${escaped(name)} — ${newContact.id}. Cadence: ${cadenceLabel(newContact)}.\nNo meaningful touchpoint is assumed. Log one with log ${newContact.id} | today | <what mattered>.`;
      });
    }

    if (verb === "log") {
      const tokens = fields[0].split(/\s+/);
      const contactId = id(tokens[0]);
      const kind = tokens[1] ?? "touch";
      if (tokens.length > 2 || !["touch", "note", "promise", "kept"].includes(kind) || (kind === "touch" && tokens.length !== 1)) {
        fail("Use log <contact-id> | <date or today> | <touchpoint>, or log <contact-id> note/promise/kept | <value>. See help.");
      }
      if (kind === "touch") {
        if (fields.length !== 3) fail("Use log <contact-id> | <YYYY-MM-DD or today> | <meaningful touchpoint>.");
        const date = fields[1] === "today" ? today : dateInput(fields[1]);
        if (date > today) fail(`Touchpoints must have happened already. Today is ${today} in ${context.timezone}.`);
        const entry: Touch = { id: `touch_${randomUUID()}`, date, text: text(fields[2], "Touchpoint", 600), recordedAt: now };
        return await edit(context, (data) => {
          const item = contact(data, contactId);
          const sorted = latestTouches({ ...item, touches: [...item.touches, entry] });
          if (!sorted.slice(0, LIMIT.touches).some((touch) => touch.id === entry.id)) {
            fail("That touchpoint falls outside the 20 most recent retained entries. Nothing was changed.");
          }
          const trimmed = sorted.length > LIMIT.touches;
          item.touches = sorted.slice(0, LIMIT.touches);
          item.updatedAt = now;
          return `Logged ${entry.id} for ${escaped(item.name)} on ${date}. Last meaningful touchpoint: ${item.touches[0].date}.${trimmed ? " Oldest touchpoint removed (20-entry limit)." : ""}\n${status(item, today).reason}`;
        });
      }
      if (kind === "note") {
        if (fields.length !== 2) fail("Use log <contact-id> note | <private context>.");
        const entry: Note = { id: `note_${randomUUID()}`, text: text(fields[1], "Context", 500), recordedAt: now };
        return await edit(context, (data) => {
          const item = contact(data, contactId);
          const trimmed = item.notes.length === LIMIT.notes;
          item.notes = [entry, ...item.notes].slice(0, LIMIT.notes);
          item.updatedAt = now;
          return `Saved private context ${entry.id}.${trimmed ? " Oldest note removed (8-note limit)." : ""} Meaningful touchpoint unchanged.`;
        });
      }
      if (kind === "promise") {
        if (fields.length < 2 || fields.length > 3) fail("Use log <contact-id> promise | <promise you made> [| <YYYY-MM-DD>].");
        const entry: PromiseRecord = {
          id: `promise_${randomUUID()}`, text: text(fields[1], "Promise", 400),
          dueDate: fields.length === 3 ? dateInput(fields[2]) : null, createdAt: now, keptAt: null,
        };
        return await edit(context, (data) => {
          const item = contact(data, contactId);
          let removed = false;
          if (item.promises.length >= LIMIT.promises) {
            const index = item.promises.findIndex((promise) => promise.keptAt !== null);
            if (index < 0) fail("All 12 promise slots are open. Mark a genuinely fulfilled promise kept before adding another; open promises are never discarded.");
            item.promises.splice(index, 1);
            removed = true;
          }
          item.promises.push(entry);
          item.updatedAt = now;
          return `Recorded open promise ${entry.id}${entry.dueDate ? `, due ${entry.dueDate}` : " without a due date"}.${removed ? " Oldest recorded kept promise removed (12-promise limit)." : ""}\nMark fulfilled with log ${contactId} kept | ${entry.id}. Meaningful touchpoint unchanged.`;
        });
      }
      if (fields.length !== 2) fail("Use log <contact-id> kept | <promise-id>.");
      const promiseId = id(fields[1], "promise");
      return await edit(context, (data) => {
        const item = contact(data, contactId);
        const promise = item.promises.find((entry) => entry.id === promiseId);
        if (!promise) fail("Promise not found on this contact. Use show <contact-id> for its promise IDs.");
        if (promise.keptAt !== null) return `Promise ${promiseId} was already marked kept. Meaningful touchpoint unchanged.`;
        promise.keptAt = now;
        item.updatedAt = now;
        return `Marked ${promiseId} kept. Meaningful touchpoint unchanged; log a separate touchpoint if you connected.`;
      }, "lifecycle");
    }

    if (verb === "cadence") {
      const tokens = args.split(/\s+/);
      if (tokens.length !== 2) fail("Use cadence <contact-id> <1-365 days or pause>.");
      const contactId = id(tokens[0]);
      const days = cadence(tokens[1]);
      return await edit(context, (data) => {
        const item = contact(data, contactId);
        item.cadenceDays = days;
        item.updatedAt = now;
        return `Cadence for ${escaped(item.name)}: ${cadenceLabel(item)}. ${days === null ? "Due promises still appear in due." : status(item, today).reason}`;
      }, "lifecycle");
    }

    if (verb === "delete") {
      const tokens = args.split(/\s+/);
      if (tokens.length > 2 || (tokens.length === 2 && tokens[1] !== "confirm")) fail("Use delete <contact-id> confirm to remove that contact and all of its history.");
      const contactId = id(tokens[0]);
      if (tokens.length === 1) {
        const item = contact(await read(context), contactId);
        return `To permanently delete ${escaped(item.name)}, its notes, touchpoints and promises, use delete ${contactId} confirm. Nothing was changed.`;
      }
      return await edit(context, (data) => {
        const item = contact(data, contactId);
        data.contacts = data.contacts.filter((entry) => entry.id !== contactId);
        return `Deleted ${escaped(item.name)} and all of that contact's notes, touchpoints and promises.`;
      }, "lifecycle");
    }

    if (!["list", "due", "brief", "draft", "show"].includes(verb)) fail("Unknown relationships command. Use help for syntax and examples.");
    if (verb === "list" && args) fail("Use list without arguments.");
    const data = await read(context);
    if (verb === "list") {
      if (!data.contacts.length) return "No contacts yet. Start with add Maya Chen | 30 | Met at the neighborhood garden, then log a meaningful touchpoint.";
      return bound([`Your contacts (${data.contacts.length}/50). Storage: ${serializedBytes(data)} UTF-8 JSON bytes; content limit ${CONTENT_BYTES}, lifecycle ceiling ${STATE_BYTES}.`, ...data.contacts.map((item) =>
        `- ${snippet(item.name, 100)} — ${item.id}; ${cadenceLabel(item)}; last ${latestTouches(item)[0]?.date ?? "not recorded"}; ${openPromises(item).length} open promises.`),
      "Use due for reconnect suggestions, or brief/show <contact-id> for context. At quota, delete <contact-id> confirm to free space."].join("\n"));
    }
    if (verb === "due") {
      const date = args ? dateInput(args) : today;
      if (date < today) fail(`Use today (${today}) or a future date. Due previews use current cadence and promise status, not historical snapshots.`);
      if (!data.contacts.length) return "No contacts yet. Start with add Maya Chen | 30, then log a meaningful touchpoint.";
      const due = data.contacts.map((item) => {
        const reconnect = status(item, date);
        const promises = duePromises(item, date);
        return { item, reconnect, promises, priority: Math.min(reconnect.due ? reconnect.priority : Infinity, ...promises.map((promise) => serial(promise.dueDate!))) };
      }).filter((entry) => entry.reconnect.due || entry.promises.length)
        .sort((a, b) => a.priority - b.priority || a.item.id.localeCompare(b.item.id));
      if (!due.length) return `Nothing due as of ${date} (${context.timezone}). Open promises without dates remain in brief/show. Use due YYYY-MM-DD to preview a future date.`;
      return bound([`Reconnect suggestions as of ${date} (${context.timezone}) — ${due.length} contact(s). Based only on your records; nothing scheduled.`,
        ...due.map(({ item, reconnect, promises }) => [
          `\n${snippet(item.name, 100)} — ${item.id}`,
          reconnect.reason,
          ...(promises.length ? [`${promises.length} open promise(s) due; earliest ${promises[0].dueDate}: ${promises[0].id} — ${snippet(promises[0].text, 100)}.`] : []),
        ].join("\n")), "\nUse brief <contact-id> before reconnecting; draft <contact-id> makes an editable private template."].join("\n"));
    }
    if (verb === "show" || verb === "brief") {
      const tokens = args.split(/\s+/);
      if (tokens.length > (verb === "show" ? 2 : 1)) fail(`Use ${verb} <contact-id>${verb === "show" ? " [entry-id]" : ""}.`);
      const item = contact(data, id(tokens[0]));
      if (tokens[1]) {
        const note = item.notes.find((entry) => entry.id === tokens[1]);
        const touch = item.touches.find((entry) => entry.id === tokens[1]);
        const promise = item.promises.find((entry) => entry.id === tokens[1]);
        if (note) return `Private context ${note.id} (${note.recordedAt}):\n${escaped(note.text)}`;
        if (touch) return `Meaningful touchpoint ${touch.id} (${touch.date}; recorded ${touch.recordedAt}):\n${escaped(touch.text)}`;
        if (promise) return promiseLine(promise, today, true);
        fail("Entry not found on this contact. Use show <contact-id> for retained entry IDs.");
      }
      return bound(overview(item, today, verb === "show"));
    }
    if (fields.length > 2) fail("Use draft <contact-id> [| <topic to include>].");
    const item = contact(data, id(fields[0]));
    const topic = fields.length === 2 ? text(fields[1], "Topic", 400) : null;
    const last = latestTouches(item)[0];
    const promise = openPromises(item)[0];
    // A deterministic template keeps every personal claim traceable to supplied text.
    // Private notes never enter the draft, and producing it never records a touchpoint.
    return bound([
      "Private outreach draft — editable template. Review the quoted notes and promises before using it. Nothing sent or saved.",
      "", `Hi ${escaped(item.name)},`, "",
      ...(last ? [`I wanted to check in after our ${last.date} touchpoint. My note from then: “${escaped(last.text)}”.`] : ["I wanted to check in. How have you been?"]),
      ...(topic ? [`I wanted to talk about: “${escaped(topic)}”.`] : []),
      ...(promise ? [`A promise I still have noted: “${escaped(promise.text)}”.`] : []),
      "Would you like to catch up sometime?", "",
      `Sources: ${item.id}${last ? `; ${last.id}` : ""}${promise ? `; ${promise.id}` : ""}${topic ? "; topic supplied in this command" : ""}.`,
      "Private context notes are excluded. This draft creates no new commitment and does not mark any promise kept.",
    ].join("\n"));
  } catch (error) {
    if (error instanceof InputError) return error.message;
    return "Relationships storage could not be read or saved. Retry or ask the runtime maintainer to check storage; no success has been confirmed.";
  }
}

export const feature: AgentFeature = {
  id: "relationships",
  title: "Relationship follow-through",
  description: "Remember meaningful touchpoints, reconnect on your preferred cadence, keep promises, and prepare private outreach drafts.",
  help: HELP,
  execute,
};

export default feature;
