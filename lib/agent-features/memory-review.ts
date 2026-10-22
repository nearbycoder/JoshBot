import { randomUUID } from "node:crypto";
import type { AgentContextItem, AgentFeature, AgentFeatureContext } from "./types.js";

const STORE_KEY = "cards";
const MAX_CARDS = 100;
const MAX_HISTORY = 6;
const PAGE_SIZE = 10;
const FACT_LIMIT = 1_200;
const SOURCE_LIMIT = 300;
const STALE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_REPLY = 27_500;
const ID_PATTERN = /^mr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BAD_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

type Claim = {
  fact: string;
  source: string;
  expiresOn: string | null;
  confidence: number | null;
  confirmedAt: string | null;
};
type Revision = Claim & {
  revision: number;
  action: "capture" | "import" | "correct" | "confirm";
  at: string;
};
type Origin = { kind: "user" } | { kind: "legacy"; id: string; updatedAt: string | null };
type Card = Claim & {
  id: string;
  subject: string;
  key: string;
  capturedAt: string;
  updatedAt: string;
  revision: number;
  origin: Origin;
  history: Revision[];
};
type State = { version: 1; cards: Card[] };
type Clock = { iso: string; today: string; timezone: string; milliseconds: number };
type Options = { expiresOn?: string | null; confidence?: number | null };
type Candidate = { id: string; text: string; updatedAt: string | null };

class MemoryReviewError extends Error {}

function fail(message: string): never {
  throw new MemoryReviewError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validText(value: unknown, max: number, oneLine = false): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !BAD_CONTROLS.test(value)
    && (!oneLine || !/[\r\n\t]/.test(value));
}

function field(value: string | undefined, name: string, max: number, oneLine = false): string {
  const text = value?.trim();
  if (!validText(text, max, oneLine)) fail(`${name} must be 1–${max} characters${oneLine ? " on one line" : ""}, without control characters.`);
  return text;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && isInstant(`${value}T00:00:00.000Z`);
}

function validConfidence(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

const claimKeys = ["fact", "source", "expiresOn", "confidence", "confirmedAt"];
function validClaim(value: Record<string, unknown>): boolean {
  return validText(value.fact, FACT_LIMIT) && validText(value.source, SOURCE_LIMIT)
    && (value.expiresOn === null || isDateOnly(value.expiresOn))
    && validConfidence(value.confidence) && (value.confirmedAt === null || isInstant(value.confirmedAt));
}

function validOrigin(value: unknown): value is Origin {
  return record(value) && ((value.kind === "user" && keys(value, ["kind"]))
    || (value.kind === "legacy" && keys(value, ["kind", "id", "updatedAt"])
      && validText(value.id, 180, true) && !value.id.includes("|")
      && (value.updatedAt === null || isInstant(value.updatedAt))));
}

function validCard(value: unknown): value is Card {
  if (!record(value) || !keys(value, [...claimKeys, "id", "subject", "key", "capturedAt", "updatedAt", "revision", "origin", "history"])
    || !validClaim(value) || typeof value.id !== "string" || !ID_PATTERN.test(value.id)
    || !validText(value.subject, 80, true) || !validText(value.key, 80, true)
    || !isInstant(value.capturedAt) || !isInstant(value.updatedAt) || value.capturedAt > value.updatedAt
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !validOrigin(value.origin) || !Array.isArray(value.history)
    || value.history.length !== Math.min(value.revision as number, MAX_HISTORY)) return false;

  let previousAt = value.capturedAt;
  for (const [index, item] of value.history.entries()) {
    if (!record(item) || !keys(item, [...claimKeys, "revision", "action", "at"]) || !validClaim(item)
      || item.revision !== (value.revision as number) - value.history.length + index + 1
      || !isInstant(item.at) || item.at < previousAt || item.at > value.updatedAt) return false;
    const action = item.revision === 1 ? value.origin.kind === "user" ? "capture" : "import" : null;
    if (action ? item.action !== action || item.at !== value.capturedAt : !["correct", "confirm"].includes(String(item.action))) return false;
    if (item.action === "confirm" ? item.confirmedAt !== item.at : item.confirmedAt !== null) return false;
    previousAt = item.at;
  }
  const last = value.history.at(-1)! as Record<string, unknown>;
  return last.at === value.updatedAt && claimKeys.every((key) => last[key] === value[key]);
}

/** Reject malformed state without resetting or overwriting any existing records. */
function parseState(value: unknown): State {
  if (!record(value) || !keys(value, ["version", "cards"]) || value.version !== 1
    || !Array.isArray(value.cards) || value.cards.length > MAX_CARDS || !value.cards.every(validCard)
    || new Set(value.cards.map((card) => card.id)).size !== value.cards.length) {
    fail("Saved memory-review data is invalid or from an unsupported version. It was not reset; ask the maintainer to inspect this feature's scoped cards record.");
  }
  const legacyIds = value.cards.flatMap((card) => card.origin.kind === "legacy" ? [card.origin.id] : []);
  if (new Set(legacyIds).size !== legacyIds.length) fail("Saved memory-review data contains duplicate legacy origins. It was not reset.");
  return value as State;
}

function clock(context: Pick<AgentFeatureContext, "now" | "timezone">): Clock {
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) fail("A valid current time is required.");
  if (typeof context.timezone !== "string" || !context.timezone.trim()) fail("A valid supplied timezone is required.");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: context.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(context.now);
    const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
    const iso = context.now.toISOString();
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    if (!isInstant(iso) || !isDateOnly(today)) fail("The supplied date is unsupported.");
    return { iso, today, timezone: context.timezone, milliseconds: context.now.getTime() };
  } catch (error) {
    if (error instanceof MemoryReviewError) throw error;
    return fail("The supplied timezone is invalid. Set a valid IANA timezone before reviewing memory.");
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function sameSlot(a: Pick<Card, "subject" | "key">, b: Pick<Card, "subject" | "key">): boolean {
  return normalized(a.subject) === normalized(b.subject) && normalized(a.key) === normalized(b.key);
}

function sameFact(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ") === b.replace(/\s+/g, " ");
}

function conflicting(card: Card, cards: Card[]): Card[] {
  return cards.filter((other) => other.id !== card.id && sameSlot(card, other) && !sameFact(card.fact, other.fact));
}

function reasons(card: Card, cards: Card[], now: Clock): string[] {
  const result: string[] = [];
  if (card.updatedAt > now.iso) result.push("dated after the supplied current time");
  if (!card.confirmedAt) result.push("needs confirmation");
  if (now.milliseconds - Date.parse(card.confirmedAt ?? card.capturedAt) >= STALE_MS) result.push("stale (90 days since capture/confirmation)");
  if (card.expiresOn && now.today > card.expiresOn) result.push(`expired after ${card.expiresOn}`);
  if (conflicting(card, cards).length) result.push("possible conflict: different claims for the same subject/key");
  return result;
}

function safe(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function excerpt(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ");
  return safe(line.length > max ? `${line.slice(0, max - 1)}…` : line);
}

function reply(value: string): string {
  return value.length <= MAX_REPLY ? value : `${value.slice(0, MAX_REPLY - 100)}\nOutput shortened; use show with an individual card ID and revision.`;
}

function options(parts: string[], now: Clock): Options {
  const parsed: Options = {};
  for (const part of parts) {
    const match = /^(expires|confidence)=(.+)$/.exec(part);
    if (!match) fail("Options must be expires=YYYY-MM-DD (or none) and confidence=0..1 (or unknown), each after a |.");
    if (match[1] === "expires") {
      if (Object.hasOwn(parsed, "expiresOn")) fail("Specify expires only once.");
      const date = match[2];
      if (date !== "none" && (!isDateOnly(date) || date < now.today)) fail(`Expiry must be a real YYYY-MM-DD date on or after ${now.today} (${safe(now.timezone)}), or none.`);
      parsed.expiresOn = date === "none" ? null : date;
    } else {
      if (Object.hasOwn(parsed, "confidence")) fail("Specify confidence only once.");
      const value = match[2];
      if (value !== "unknown" && (!/^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/.test(value))) fail("Confidence is a user rating from 0 to 1 (up to four decimals), or unknown.");
      parsed.confidence = value === "unknown" ? null : Number(value);
    }
  }
  return parsed;
}

function revision(card: Card, action: Revision["action"]): Revision {
  return {
    revision: card.revision, action, at: card.updatedAt,
    fact: card.fact, source: card.source, expiresOn: card.expiresOn,
    confidence: card.confidence, confirmedAt: card.confirmedAt,
  };
}

async function read(context: Pick<AgentFeatureContext, "store">): Promise<State> {
  const raw = await context.store.read<unknown>(STORE_KEY);
  return raw === null ? { version: 1, cards: [] } : parseState(raw);
}

async function change(context: AgentFeatureContext, transform: (state: State) => { value: State; result: string }): Promise<string> {
  return context.store.update<unknown, string>(STORE_KEY, { version: 1, cards: [] }, (raw) => transform(parseState(raw)));
}

function getCard(state: State, id: string): Card {
  const card = state.cards.find((entry) => entry.id === id);
  return card ?? fail("No memory card with that ID. Use list to find a current card ID.");
}

function mutationTarget(input: string, forgetting = false): { id: string; expected: number } {
  const tokens = input.split(/\s+/);
  if (tokens.length !== (forgetting ? 3 : 2) || !ID_PATTERN.test(tokens[0])
    || !/^[1-9]\d*$/.test(tokens[1]) || !Number.isSafeInteger(Number(tokens[1]))
    || (forgetting && tokens[2] !== "confirm")) {
    fail(forgetting ? "Use forget <id> <revision> confirm. This deletes the card and its retained history. Use show <id> to check the revision."
      : "Include the current revision: <id> <revision>. Use show <id> to review it first.");
  }
  return { id: tokens[0], expected: Number(tokens[1]) };
}

function checkRevision(card: Card, expected: number, now: Clock): void {
  if (card.revision !== expected) fail(`Card changed: current revision is ${card.revision}. Use show ${card.id}, then retry with that revision.`);
  if (now.iso < card.updatedAt) fail("This command's timestamp predates a newer edit. Retry with the current time.");
  if (card.revision >= Number.MAX_SAFE_INTEGER) fail("This card has reached its revision limit; capture a replacement before forgetting it.");
}

function pageNumber(input: string): number {
  if (!input) return 1;
  if (!/^[1-9]\d{0,3}$/.test(input)) fail("Page must be a positive whole number (for example: list 2).");
  return Number(input);
}

function page<T>(entries: T[], number: number): T[] {
  const total = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  if (number > total) fail(`Page ${number} is out of range; there ${total === 1 ? "is" : "are"} ${total} page${total === 1 ? "" : "s"}.`);
  return entries.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE);
}

function status(card: Card, cards: Card[], now: Clock): string {
  const pending = reasons(card, cards, now);
  return pending.length ? pending.join("; ") : "confirmed and eligible for approved context";
}

function show(card: Card, cards: Card[], now: Clock, historyRevision?: number): string {
  const selected = historyRevision === undefined ? card : card.history.find((item) => item.revision === historyRevision);
  if (!selected) fail(`Revision ${historyRevision} is not retained. Available revisions: ${card.history.map((item) => item.revision).join(", ")}.`);
  const lines = [
    `${card.id} · ${safe(card.subject)} / ${safe(card.key)} · revision ${selected.revision}${historyRevision === undefined ? "" : " (history; not current approval)"}`,
    `Claim: ${safe(selected.fact)}`,
    `Source: ${safe(selected.source)}`,
    `Captured: ${card.capturedAt}; ${historyRevision === undefined ? `updated: ${card.updatedAt}` : `revision recorded: ${(selected as Revision).at}`}`,
    `Expires: ${selected.expiresOn ? `end of ${selected.expiresOn} in ${safe(now.timezone)}` : "none"}; confidence: ${selected.confidence ?? "unknown"} (user rating)`,
    `Confirmed: ${selected.confirmedAt ?? "not yet"}`,
    `Origin: ${card.origin.kind === "user" ? "user capture" : `owned legacy memory ${safe(card.origin.id)}; source updated: ${card.origin.updatedAt ?? "unknown"}`}`,
  ];
  if (historyRevision !== undefined) return lines.join("\n");
  lines.push(`Current review: ${status(card, cards, now)}. As of ${now.today} (${safe(now.timezone)}).`);
  const conflicts = conflicting(card, cards);
  if (conflicts.length) {
    lines.push("Different claims share this user-selected subject/key; this is a review flag, not proof that either is false.");
    lines.push(...conflicts.slice(0, 5).map((other) => `• ${other.id} (r${other.revision}): ${excerpt(other.fact, 160)}`));
    if (conflicts.length > 5) lines.push(`${conflicts.length - 5} more; use review to inspect the remaining cards.`);
    lines.push("Correct or forget competing cards to resolve the flag. Confirmation alone does not resolve it.");
  }
  lines.push(`Recent history (${card.history.length}/${card.revision} revisions retained):`);
  lines.push(...card.history.map((item) => `• r${item.revision} ${item.action} at ${item.at}: ${excerpt(item.fact, 180)} — source: ${excerpt(item.source, 80)}`));
  lines.push(`Inspect full history: show ${card.id} <revision>`, `Confirm: confirm ${card.id} ${card.revision}`, `Correct: correct ${card.id} ${card.revision} | <fact> | <source>`, `Forget: forget ${card.id} ${card.revision} confirm`);
  return lines.join("\n");
}

async function addCard(context: AgentFeatureContext, now: Clock, subject: string, key: string, fact: string, source: string, settings: Options, origin: Origin): Promise<string> {
  // UUID and timestamp are captured outside the retryable transform.
  const card: Card = {
    id: `mr_${randomUUID()}`, subject, key, fact, source,
    capturedAt: now.iso, updatedAt: now.iso, revision: 1,
    expiresOn: settings.expiresOn ?? null, confidence: settings.confidence ?? null,
    confirmedAt: null, origin, history: [],
  };
  card.history = [revision(card, origin.kind === "user" ? "capture" : "import")];
  return change(context, (state) => {
    if (origin.kind === "legacy") {
      const existing = state.cards.find((entry) => entry.origin.kind === "legacy" && entry.origin.id === origin.id);
      if (existing) fail(`That legacy source is already imported as ${existing.id}. Use show; imports never overwrite an existing card.`);
    }
    const duplicate = state.cards.find((entry) => sameSlot(entry, card) && sameFact(entry.fact, card.fact));
    if (duplicate) fail(`That claim already exists as ${duplicate.id}. Use show, correct, or confirm.`);
    if (state.cards.length >= MAX_CARDS) fail(`The workspace holds at most ${MAX_CARDS} cards. Forget an unneeded card before capturing another.`);
    const value: State = { version: 1, cards: [...state.cards, card] };
    return { value, result: `${origin.kind === "legacy" ? "Imported a private copy" : "Captured"}: ${card.id} (revision 1).\n${safe(subject)} / ${safe(key)}: ${safe(fact)}\nReview: ${status(card, value.cards, now)}.\nUse show ${card.id}, then confirm ${card.id} 1 after checking the claim and source.` };
  });
}

function candidate(value: unknown): Candidate | null {
  if (!record(value) || value.kind !== "memory" || !validText(value.id, 180, true)
    || value.id.includes("|") || value.id.startsWith("memory-review:")
    || !validText(value.text, FACT_LIMIT)) return null;
  let updatedAt: string | null = null;
  if (value.updatedAt !== undefined) {
    // Require an explicit timezone, then store a canonical UTC instant.
    if (typeof value.updatedAt !== "string" || value.updatedAt.length > 35
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.updatedAt)
      || !isDateOnly(value.updatedAt.slice(0, 10))) return null;
    const parsed = new Date(value.updatedAt);
    if (!Number.isFinite(parsed.getTime())) return null;
    updatedAt = parsed.toISOString();
    if (!isInstant(updatedAt)) return null;
  }
  return { id: value.id, text: value.text, updatedAt };
}

async function importCommand(input: string, context: AgentFeatureContext, now: Clock): Promise<string> {
  const parts = input.split("|").map((part) => part.trim());
  const listing = !input || /^list(?:\s+\d+)?$/.test(input);
  let number = 1;
  let subject = "";
  let key = "";
  let settings: Options = {};
  if (listing) number = pageNumber(input.replace(/^list\s*/, ""));
  else {
    if (parts.length < 3 || parts.length > 5) fail("Use import to list candidates, then import <source-id> | <subject> | <key> [| expires=YYYY-MM-DD] [| confidence=0..1].");
    field(parts[0], "Legacy source ID", 180, true);
    subject = field(parts[1], "Subject", 80, true);
    key = field(parts[2], "Key", 80, true);
    settings = options(parts.slice(3), now);
  }
  // All asynchronous source work finishes before the atomic add. No legacy writes.
  let raw: unknown;
  try { raw = await context.services.readContext(["memory"]); }
  catch { return fail("Owned legacy memory is unavailable. No memory-review cards were changed; retry import later."); }
  if (!Array.isArray(raw) || raw.length > 500) fail("Legacy context must be an owned, bounded list of at most 500 candidates. No cards were changed.");
  const parsed = raw.map(candidate);
  const occurrences = new Map<string, number>();
  for (const item of raw) {
    if (record(item) && item.kind === "memory" && typeof item.id === "string") occurrences.set(item.id, (occurrences.get(item.id) ?? 0) + 1);
  }
  const candidates = parsed.filter((entry): entry is Candidate => entry !== null && occurrences.get(entry.id) === 1);
  if (!listing) {
    const selected = candidates.find((entry) => entry.id === parts[0]);
    if (!selected) fail("That source is missing, ambiguous, or not importable. Run import again. Only uniquely identified owned memory with 1–1200 characters and a valid source date can be copied; use capture for a selected excerpt.");
    return addCard(context, now, subject, key, selected.text, `Legacy memory ${selected.id}`, settings, { kind: "legacy", id: selected.id, updatedAt: selected.updatedAt });
  }
  const state = await read(context);
  const selected = page(candidates, number);
  const skipped = raw.length - candidates.length;
  const lines = [
    `Owned legacy memory candidates: ${candidates.length}; page ${number}/${Math.max(1, Math.ceil(candidates.length / PAGE_SIZE))}.`,
    "These are source snapshots, not approved facts. Import one by its stable source ID; global legacy memory is unchanged.",
    ...selected.map((entry) => {
      const existing = state.cards.find((card) => card.origin.kind === "legacy" && card.origin.id === entry.id);
      return `• ${safe(entry.id)}${existing ? ` (already imported: ${existing.id})` : ""}: ${excerpt(entry.text, 180)}; source updated: ${entry.updatedAt ?? "unknown"}`;
    }),
  ];
  if (!candidates.length) lines.push("No importable owned legacy memories were returned. Capture a fact with a source to start.");
  if (skipped) lines.push(`${skipped} context entries were skipped (wrong kind, duplicate ID, this feature's context, invalid data, or text over 1200 characters).`);
  lines.push("Copy: import <source-id> | <subject> | <key> [| expires=YYYY-MM-DD] [| confidence=0..1]");
  return lines.join("\n");
}

/**
 * Read-only opt-in adapter for a parent runtime using this feature's scoped store.
 * Includes only explicitly confirmed, fresh, unexpired, nonconflicting claims.
 * Returned text remains untrusted user data, never instructions or verified truth.
 */
export async function readApprovedMemoryContext(context: Pick<AgentFeatureContext, "store" | "now" | "timezone">): Promise<AgentContextItem[]> {
  const now = clock(context);
  const state = await read(context);
  const eligible = state.cards.filter((card) => reasons(card, state.cards, now).length === 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const unique: Card[] = [];
  for (const card of eligible) {
    if (!unique.some((other) => sameSlot(other, card) && sameFact(other.fact, card.fact))) unique.push(card);
  }
  return unique.map((card) => ({
    id: `memory-review:${card.id}`, kind: "memory", title: `${card.subject} / ${card.key}`,
    text: card.fact, updatedAt: card.updatedAt, status: "user-confirmed",
    metadata: {
      featureId: "memory-review", cardId: card.id, revision: card.revision,
      subject: card.subject, key: card.key, source: card.source, capturedAt: card.capturedAt,
      confirmedAt: card.confirmedAt, expiresOn: card.expiresOn, expiryTimezone: now.timezone,
      confidence: card.confidence, origin: card.origin,
    },
  }));
}

const help = `Memory review — private claims, provenance, and explicit approval.
Commands (after /nobo-help agent memory-review):
capture <subject> | <key> | <fact> | <source> [| expires=YYYY-MM-DD] [| confidence=0..1]
list [page] · show <id> [historical-revision] · review [page]
correct <id> <revision> | <fact> | <source> [| expires=<date-or-none>] [| confidence=<rating-or-unknown>]
confirm <id> <revision>
forget <id> <revision> confirm
import [list [page]]
import <legacy-source-id> | <subject> | <key> [| expires=YYYY-MM-DD] [| confidence=0..1]
Example: capture me | work-city | I work in Chicago | My update today | confidence=0.9
Then show the returned ID and confirm its revision. Revision checks protect newer edits.
Use one subject/key for one claim slot; different text in the same slot flags a possible conflict. No model guesses are used.
Review includes unconfirmed, expired, 90-day stale, and potentially conflicting cards. Expiry includes the whole supplied local date. Confidence is an optional user rating, not a verified probability.
Correction keeps omitted expiry/confidence and resets approval; expires=none and confidence=unknown clear them. A past expiry must be renewed/cleared before confirming.
At most 100 cards and the last 6 revisions per card; forget deletes the card and its retained history. Pipes delimit fields and cannot appear inside them. No external changes or automatic legacy-memory rewrites.`;

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  try {
    if (typeof command !== "string" || command.length > 4_000) fail("Command must be text of at most 4000 characters.");
    const trimmed = command.trim();
    if (!trimmed || trimmed === "help") return help;
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)!;
    const action = match[1];
    const input = (match[2] ?? "").trim();
    const now = clock(context);
    const parts = input.split("|").map((part) => part.trim());

    if (action === "capture") {
      if (parts.length < 4 || parts.length > 6) fail("Use capture <subject> | <key> | <fact> | <source> [| expires=YYYY-MM-DD] [| confidence=0..1].");
      return reply(await addCard(context, now, field(parts[0], "Subject", 80, true), field(parts[1], "Key", 80, true), field(parts[2], "Fact", FACT_LIMIT), field(parts[3], "Source", SOURCE_LIMIT), options(parts.slice(4), now), { kind: "user" }));
    }
    if (action === "import") return reply(await importCommand(input, context, now));
    if (action === "list" || action === "review") {
      const number = pageNumber(input);
      const state = await read(context);
      const cards = state.cards.filter((card) => action === "list" || reasons(card, state.cards, now).length)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      const selected = page(cards, number);
      if (!cards.length) return action === "review" && state.cards.length
        ? "No cards need review. All current claims are confirmed, fresh, unexpired, and without a same-key conflict."
        : "No memory cards yet. Use capture me | work-city | I work in Chicago | My update today, or import to inspect owned legacy candidates.";
      return reply([
        `${action === "review" ? "Review queue" : "Memory cards"}: ${cards.length}; page ${number}/${Math.ceil(cards.length / PAGE_SIZE)}. As of ${now.today} (${safe(now.timezone)}).`,
        ...selected.map((card) => `• ${card.id} r${card.revision} — ${excerpt(card.subject, 50)} / ${excerpt(card.key, 50)}: ${excerpt(card.fact, 140)}\n  ${status(card, state.cards, now)}`),
        "Use show <id> for the source, conflict IDs, revision history, and review commands.",
      ].join("\n"));
    }
    if (action === "show") {
      const tokens = input.split(/\s+/);
      if (tokens.length > 2 || !ID_PATTERN.test(tokens[0]) || (tokens[1] !== undefined && (!/^[1-9]\d*$/.test(tokens[1]) || !Number.isSafeInteger(Number(tokens[1]))))) fail("Use show <id> [historical-revision]. Find IDs with list.");
      const state = await read(context);
      return reply(show(getCard(state, tokens[0]), state.cards, now, tokens[1] === undefined ? undefined : Number(tokens[1])));
    }
    if (action === "correct" || action === "confirm" || action === "forget") {
      if (action === "correct" ? parts.length < 3 || parts.length > 5 : parts.length !== 1) fail("Use correct <id> <revision> | <fact> | <source> [| expires=YYYY-MM-DD] [| confidence=0..1], confirm <id> <revision>, or forget <id> <revision> confirm.");
      const target = mutationTarget(parts[0], action === "forget");
      const fact = action === "correct" ? field(parts[1], "Fact", FACT_LIMIT) : "";
      const source = action === "correct" ? field(parts[2], "Source", SOURCE_LIMIT) : "";
      const settings = action === "correct" ? options(parts.slice(3), now) : {};
      return reply(await change(context, (state) => {
        const card = getCard(state, target.id);
        checkRevision(card, target.expected, now);
        if (action === "forget") return {
          value: { version: 1, cards: state.cards.filter((entry) => entry.id !== card.id) },
          result: `Forgot ${card.id} and its retained history. Any separate legacy memory is unchanged.`,
        };
        if (action === "confirm" && card.expiresOn && card.expiresOn < now.today) fail(`This card expired after ${card.expiresOn}. Correct it with a new expires date or expires=none before confirming.`);
        const updated: Card = {
          ...card, ...(action === "correct" ? { fact, source, ...settings } : {}),
          confirmedAt: action === "confirm" ? now.iso : null,
          updatedAt: now.iso, revision: card.revision + 1,
        };
        updated.history = [...card.history, revision(updated, action)].slice(-MAX_HISTORY);
        const value: State = { version: 1, cards: state.cards.map((entry) => entry.id === card.id ? updated : entry) };
        return { value, result: `${action === "confirm" ? "Confirmed" : "Corrected"} ${card.id} (revision ${updated.revision}).\nReview: ${status(updated, value.cards, now)}.\n${action === "correct" ? `Approval was reset. Check show ${card.id}, then confirm ${card.id} ${updated.revision}.` : `User confirmation records your review; it does not independently verify the claim. Use show ${card.id} for provenance.`}` };
      }));
    }
    return "Unknown memory-review command. Use help for capture, list, show, review, correct, confirm, forget, and import.";
  } catch (error) {
    return error instanceof MemoryReviewError ? reply(error.message)
      : "Memory review is unavailable; no successful change was confirmed. Retry, or use show to check the latest saved revision.";
  }
}

export const feature: AgentFeature = {
  id: "memory-review",
  title: "Memory review and provenance",
  description: "Review sourced personal claims, expiry, conflicting keys, and explicit memory approval.",
  help,
  execute,
};

export default feature;
