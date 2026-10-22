# Relationship follow-through

Implementation module: `lib/agent-features/relationships.ts`. Command ID: `relationships`.
Parent routing/registry integration is required before these commands are available in Slack.

Remember the people you choose to enter, what mattered in your last interaction, how often you want to reconnect, and promises you made. `due` explains its suggestions; `brief` prepares you to reconnect; `draft` creates a private, editable outreach template. No contact discovery, Slack scraping, automatic reminders, or outreach is performed.

## A complete flow

Prefix every command below with `/nobo-help agent relationships`. Copy the full `rel_…` contact ID returned by `add`; names are not identifiers. Two people may have the same name.

```text
add Maya Chen | 30 | Met at the neighborhood garden; prefers weekend catch-ups
log <contact-id> | 2026-09-20 | Discussed the spring planting plan
log <contact-id> promise | Share my seed list | 2026-10-22
due
brief <contact-id>
draft <contact-id> | Spring planting ideas
```

On October 22, a 30-day cadence from September 20 is **two calendar days overdue**, since October 20. The seed-list promise appears separately as due. A draft quotes the latest touchpoint, the earliest-dated open promise (if any), and your optional topic. It cites the exact contact, touchpoint, and promise IDs below the message. Review and edit it before copying it anywhere.

Private context notes are **excluded from the draft**. They appear in your private brief/show views. The template does not invent shared experiences, say a promise was fulfilled, or commit you to a new date. Drafting does not save anything or change when you last connected.

After actually following through:

```text
log <contact-id> kept | <promise-id>
log <contact-id> | today | Shared the seed list and compared planting plans
```

Marking a promise kept alone does not imply you connected. A new meaningful touchpoint explicitly restarts the cadence from that touchpoint's date.

## Commands

| Command after the prefix | Behavior |
| --- | --- |
| `help` | Syntax, example, limits; also works when storage/timezone is unavailable. Empty input shows help. |
| `add <name> \| <days> [\| <private context>]` | Create a contact with a cadence of 1–365 calendar days. `pause` is also accepted in place of days. No touchpoint is assumed. |
| `log <contact-id> \| <YYYY-MM-DD or today> \| <meaningful touchpoint>` | Record something that already happened. Backdated entries are allowed; future entries are rejected. |
| `log <contact-id> note \| <private context>` | Append a private context note without changing the meaningful-touchpoint date. |
| `log <contact-id> promise \| <promise you made> [\| <YYYY-MM-DD>]` | Record an open promise. An optional due date can be past, present, or future. An undated promise remains visible in brief/show but does not independently trigger `due`. |
| `log <contact-id> kept \| <promise-id>` | Mark your promise fulfilled; repeating this command leaves the original completion timestamp intact. |
| `cadence <contact-id> <days or pause>` | Change the interval or pause reconnect suggestions. Due promises remain visible while cadence is paused. Resume by setting a numeric interval. |
| `due [YYYY-MM-DD]` | Suggest contacts whose cadence or dated open promises are due, with explanations. Default: today in your supplied timezone. Future previews use the current records, cadence, and promise status; historical snapshots are not supported. |
| `brief <contact-id>` | Show cadence status, three latest context notes, three latest dated touchpoints, and all open promises. |
| `draft <contact-id> [\| <topic to include>]` | Generate a deterministic editable template from saved facts and your optional topic. One earliest-dated open promise is included; undated promises follow dated ones. No model is required or called. |
| `list` | List your contacts with stable IDs, cadence, last meaningful-touchpoint date, and open-promise count, plus current serialized UTF-8 storage usage. |
| `show <contact-id>` | Inspect all retained notes, touchpoints, and promises, including kept promises. Long text may be shown as a snippet. |
| `show <contact-id> <entry-id>` | Inspect the complete retained note, touchpoint, or promise text. Entry IDs appear in log replies and show/brief output. |
| `delete <contact-id>` | Show the exact confirmation command without deleting anything. |
| `delete <contact-id> confirm` | Remove the contact and all its notes, touchpoints, and promises from this feature. |

Use literal `|` characters only as field separators. Names are single-line text. Dates must be real Gregorian dates in `YYYY-MM-DD` format. IDs must match exactly; prefixes or names are not accepted in place of IDs.

## Cadence and sorting

- The most recent **dated meaningful touchpoint** anchors cadence, even if an older interaction is entered later. Notes, promises, cadence changes, briefs, and drafts do not count as interactions.
- Cadence is calendar-date arithmetic in the runtime's supplied timezone, not elapsed blocks of 24 hours. A one-day cadence logged on a spring DST transition is due the next calendar day even if fewer than 24 hours have passed. Invalid/missing timezones produce an error rather than using server-local time.
- A contact without any logged meaningful touchpoint is suggested as an initial check-in, with that lack of history stated explicitly. Pausing its cadence suppresses this suggestion.
- `due` orders contacts by their oldest due cadence date or open-promise deadline. A never-logged contact has the selected preview date as its priority. Exact ties use stable IDs. Undated promises remain visible in briefs.
- These are suggestions from your records, not a prediction of someone else's preferences or a scheduled reminder. Date-only records are interpreted in the currently supplied timezone; changing your timezone does not rewrite historical dates.

## Storage, privacy, and limits

All commands and replies must be delivered privately. Only explicitly entered facts are used. The module does not read other NoBo context, scrape Slack, search the web, call a model, send messages, or change external accounts. Untrusted text stays literal text; Slack angle-bracket mention/link syntax is escaped in replies.

State is bounded to 50 contacts. Each contact keeps:

- Eight context notes, newest recorded first. Adding a ninth removes the oldest note and says so.
- Twenty meaningful touchpoints, ordered by interaction date, then recording time, then stable ID. Adding a newer entry trims the oldest retained touchpoint and says so. An attempted backfill outside the retained twenty is rejected without changing state.
- Twelve total promises. Open promises are never evicted. At capacity, adding a promise removes the oldest-recorded kept promise; if all twelve remain open, the command asks you to mark a genuinely fulfilled one kept first.

Names are limited to 100 characters, context notes to 500, touchpoints to 600, and promises/draft topics to 400. Commands are capped at 4,000 characters, and replies at 27,500 characters. Show/brief/list use bounded snippets; inspect a retained entry by its ID for its complete text.

The complete JSON value is also measured with `Buffer.byteLength(JSON.stringify(state), "utf8")` inside every atomic update. New contacts, notes, touchpoints, and promises must fit within **460,000 bytes**, including IDs, timestamps, JSON escaping, and Unicode. This aggregate quota can be reached before the record-count limits. A rejected edit changes nothing and gives the attempted byte count plus shorter-text/deletion guidance. Use `list` to inspect usage and `delete <contact-id> confirm` to free space; a replacement note or touchpoint can also fit if it removes a larger entry under the normal retention rules.

An additional **19,000 bytes** are reserved for lifecycle updates, with a hard feature ceiling of **479,000 bytes**, below both the parent's 480,000-byte feature budget and its 512,000-byte store ceiling. Even at maximum content capacity, all 600 possible open promises can be marked kept and all 50 cadences paused: these changes add at most 13,350 bytes total. Reads, drafts, and deletion remain available when the content quota is full. Marking a promise kept consumes a little reserved space; it does not itself free storage. Additional content may require deleting contacts once lifecycle updates have used the reserve.

Contacts remain until explicitly deleted. There is no time-based expiry, automatic contact merging, per-entry editing, promise cancellation, attachment handling, recurring job, or durable draft history. Add a new note to record changed context. Delete the contact to remove all of its stored data; deletion cannot retract a response already delivered by the parent runtime. If saved state fails validation, the module refuses to overwrite it and asks for maintainer repair.

Drafts deliberately use a template and quoted source text, so they may need stylistic editing. There is no natural-language model polishing or inference dependency. Provider outages cannot overwrite relationship state because no provider is called and drafts are read-only. Store failures are reported without confirming a write; ambiguous store outcomes are left to the parent's transaction/deduplication layer.

## Exact parent integration needs

1. Import the named `feature` (also exported as default) from `lib/agent-features/relationships.ts` and register it under the exact ID `relationships`. Route `/nobo-help agent relationships <command>` to `feature.execute(command, context)` and expose its `title`, `description`, and `help` in private help/Home discovery. No shared-contract changes are needed.
2. Supply the caller's authorized **workspace/user/feature-scoped** `AgentFeatureStore`. This module uses only the namespace-local key `relationships.v1`, with a `{ version: 1, contacts: [...] }` JSON envelope. Different users/features must receive isolated namespaces. It neither reads nor builds raw Redis keys.
3. Use the parent's atomic retryable `store.update` with isolated JSON value semantics and its 512,000-byte ceiling. All edits validate the latest state and clone it; UUIDs and timestamps are prepared outside the synchronous callback. Each retry rechecks the feature's byte quota against the proposed updated state, so competing writes cannot overfill it. Retried callbacks preserve intervening edits and do not resurrect deleted contacts. Parent-level request deduplication remains necessary for duplicate command delivery.
4. Supply a valid `context.now` instant and the user's explicit `context.timezone`; never silently substitute the host's local timezone. The module uses these fields for dates and timestamps. It checks an already-aborted signal before starting work; the parent runtime owns the 120-second deadline, prompt cancellation, and signal-guarded store writes. This module performs only bounded local processing and scoped store operations, with no background tasks.
5. Deliver all replies privately and preserve escaped text. Replies remain below the runtime's 28,000-character cap. No model/search/owner-context adapter capabilities, permissions, scheduling hooks, dependencies, or environment variables are added by this feature. `context.services` is unused: each invocation makes zero generation calls and zero searches, within the parent's limits of eight and six respectively.

No shared routing, registry, contract, package, lockfile, or other feature changes are included in this implementation commit.

## Verification

With Node 24 on the path:

```sh
node --import tsx --test tests/agent-relationships.test.ts
npm run typecheck
git diff --check
```

The targeted tests cover the complete add-to-delete flow, drafts and promise completion, empty/invalid inputs, timezone/date/DST boundaries, sorting and backdated entries, retention caps, malformed stored JSON, pure transform retries, concurrent edits, deletion winning over a stale write, private store isolation, unused/failing service stubs, storage errors, and output size/escaping. Quota tests use exact UTF-8 JSON boundaries (including CJK, emoji, quotes, and unpaired-surrogate escaping), preserve state on rejected writes, retry against a concurrently exhausted quota, and complete all 600 promises plus 50 cadence pauses after filling the content budget. An already-cancelled invocation also makes no mutation. No production services or live inference are used.
