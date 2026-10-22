# Meeting preparation briefs (`meeting-prep`)

Use `/nobo-help agent meeting-prep help` for commands. This is one of the original twenty personal agents deployed in PR #58, with private replies and Home discovery. See [verified release status](../personal-agent-expansion.md).

Prepare for a meeting you explicitly describe using relevant information already owned by you. A packet includes your stated purpose and attendees, matching owner-context excerpts, source-reported open commitments, a proposed agenda, and suggested questions. Facts and suggestions appear in separate sections. This is preparation before a meeting; it does not process transcripts or modify the toolbox's manual agendas.

Meeting prep can read your private toolbox notes/goals, confirmed calendar imports, eligible approved memory cards, and your follow-ups/reminders in the current channel. Artifacts and legacy personal memory are not connected. See [source coverage](context.md).

## Commands and example flow

All examples use the private entry point `/nobo-help agent meeting-prep`. Replace `<id>` with the full `mp-…` identifier returned by `prepare` or `list`. The date below is an example: choose a future time when trying it.

```text
/nobo-help agent meeting-prep help
/nobo-help agent meeting-prep prepare Atlas launch | purpose: Agree the launch date; attendees: Ana, Dev; when: 2026-11-12T10:00:00-06:00; Resolve the Atlas rollout risks.
/nobo-help agent meeting-prep list
/nobo-help agent meeting-prep show <id>
/nobo-help agent meeting-prep add-context <id> | Orchid budget approval is a dependency. I promised to bring a revised estimate.
/nobo-help agent meeting-prep refresh <id>
/nobo-help agent meeting-prep show <id> 1
/nobo-help agent meeting-prep delete <id> confirm
```

1. `prepare <title> | <details>` reads permitted owner context in bounded sequential groups and saves packet 1. Both title and details are required. Plain details work too: `prepare Atlas launch | Decide whether the rollout is ready.` The free text becomes the purpose when `purpose:` is omitted.
2. `show <id>` reads the latest saved packet without calling a provider. `list` displays the retained meetings and flags pending context.
3. `add-context <id> | <text>` saves an additional supplied source and marks it pending. It does not rewrite a historical packet. `show` displays pending text so it is inspectable immediately.
4. `refresh <id>` rereads owner context, uses all added notes in matching, and saves the next packet. Source excerpts from previous packets remain available through `show <id> <packet-number>` until they age out of retention.
5. `delete <id> confirm` removes this meeting, its added context, and all its packet versions. It never removes the underlying owner notes, goals, or reminders.

Optional `purpose:`, `attendees:`, and `when:` fields are case-insensitive, separated by semicolons or newlines, and may appear only once. Other segments remain supplied context. Avoid semicolons/newlines inside a field value. Everything after the first `|` belongs to details/context, so subsequent pipes are accepted as text. Attendees are text you supply, not resolved user accounts.

`when:` accepts an ISO date and time with `Z` or a numeric offset, such as `2026-11-12T10:00:00-06:00`. Invalid dates, ambiguous offset-less times, and past times at creation are rejected. With no `when:`, the packet explicitly says the time is unknown. All displayed times use the runtime-supplied user timezone, including date boundaries and daylight-saving offsets. A retained meeting can still be refreshed after its supplied time has passed; the packet labels that fact. `add-context` supplements the meeting rather than editing its original purpose, attendees, or time; prepare a new meeting to replace those fields.

## Evidence and suggestions

- `[M]` identifies the original meeting details and stable meeting ID.
- `[C1]` through `[C5]` identify the added context in that packet, including stable note IDs and capture times.
- `[S1]` through `[S6]` identify owner-source snapshots. Each includes source kind, original stable source ID, title, a bounded excerpt, reported status if supplied, and update time if known. Labels are local to a packet; use the original source IDs when comparing packets.

Matching is deterministic: shared lowercase words of at least three characters, with common English meeting words removed. A title-word match scores three points; an excerpt-word match scores one. Only positive matches are included; source kind and ID break ties. Matching uses the meeting title, details, and all added context. It scans at most the first 200 returned records and retains at most six matches. There is no semantic search, model inference, web search, or attendee lookup. Mentioning another person does not grant access to their private data.

Goals, follow-ups, and reminders are presented as open commitments only when their reported status is `open`, `active`, `pending`, `in-progress` (also `in_progress`/`in progress`), `todo`, `scheduled`, `overdue`, or `blocked`. Recognized closed states are `done`, `completed`, `complete`, `closed`, `cancelled`, `canceled`, `archived`, `dismissed`, and `resolved`. Matching is case-insensitive. Missing or other statuses get an explicit “verify status” prompt; they are not assumed open. A due time is shown only if it is a valid offset-bearing timestamp. Date-only deadlines are shown as calendar labels. Closed items may still appear as relevant background excerpts.

A valid `YYYY-MM-DD` deadline is preserved verbatim in the packet, with no invented midnight or timezone. For example, an open goal due `2026-10-21` viewed on October 22 in your timezone displays `due 2026-10-21 (date only; overdue)`. A date equal to your request's local calendar date is “due today”; a later date is “upcoming”. Viewing the same saved packet from another timezone can change this relative label, while its stored deadline stays unchanged. Offset-bearing deadlines remain instants, displayed in your timezone and compared against the exact request time. Impossible dates and offset-less date/time strings are unavailable deadlines; `when:`, `capturedAt`, and `updatedAt` still require timestamps. Existing saved packets remain readable without a migration; refresh to capture dates that older packets omitted, while historical packets keep their original snapshots.

The agenda and questions are deterministic suggestions grounded in these cited inputs, not assertions that a decision was made or work completed. Source-reported facts are not independently verified. A due marker is relative to the supplied current time, even when viewing a historical packet. Matching can miss relevant sources or include irrelevant ones; an empty match set is not proof that no commitments exist. Add distinctive project/context words to improve the next refresh.

## Retention, limits, and failure behavior

- At most **12 meetings**, in creation commit order. A successful new `prepare` evicts the oldest retained meeting when full. Viewing, adding context, and refreshing do not change this order.
- At most **3 successful packet versions per meeting**, with increasing packet numbers. Each includes its own owner-source excerpts and added-note snapshot; titles and original details are immutable and shared across versions.
- At most **5 added notes per meeting**, **800 characters per note**. Titles allow **120 characters**, details **1,600**, and commands **2,000**. There is no export file; `show` is the readable packet and deletion is explicit.
- Saved JSON is limited to **480,000 UTF-8 bytes**, below the runtime's storage ceiling. Large Unicode packets can reach this limit before the item counts above. The attempted change is rejected without replacing saved work; delete an older meeting and retry to free space.
- Owner-source snapshots retain up to **140 characters per title**, **600 per excerpt**, **160 per source ID**, and **60 per status**. Extra source metadata and URLs are not stored. Sources with unsupported kinds or invalid identifiers are skipped; invalid source dates are treated as unavailable. Excerpts are marked when clipped.
- User and source text is inert data. Slack angle-bracket controls/mentions are escaped. Display fields are bounded after escaping as well, keeping replies below the 28,000-character target even for adversarial ampersand-heavy text.
- A failing owner-context provider or a malformed non-array response leaves existing state unchanged. A failed `prepare` does not save a meeting or evict one; a failed `refresh` preserves the last packet and pending notes. Valid empty context still produces a useful supplied-input packet. Individual malformed source records are skipped.
- Concurrent additions use atomic updates. Refresh saves only when the meeting's revision still matches the revision read before context retrieval. Newer edits, successful refreshes, and deletion win; stale work is discarded with retry guidance. Atomic transforms are pure, synchronous, and safe to retry. UUIDs and timestamps are generated outside them.
- Persisted schema, field sizes, source shapes, notes, history, and revision relationships are validated. Invalid data is reported without silently resetting it. The scoped data must be restored by the runtime administrator if corrupted.

## Runtime and source contract

1. `registry.ts` registers the named/default `feature` from `lib/agent-features/meeting-prep.ts` as `meeting-prep`. `index.ts` dispatches `/nobo-help agent meeting-prep <command>` through the shared runtime; the Slack route returns private text and Home exposes its help. The shared route preserves multiline command text; individual commands still enforce their input rules.
2. Enforce caller identity and **private-only response delivery** for every command. The module returns plain text and has no Slack client or sending capability. Supply runtime deduplication for retried command requests, as defined by the shared contract; this feature does not independently deduplicate `requestId` values.
3. The runtime supplies the existing `AgentFeatureStore` interface, scoped to workspace/user/feature, with atomic compare-and-swap/retry semantics for `update`. This module uses only local key **`packets`**, schema **1**. Do not give it arbitrary Redis-key access. No migration of shared data is needed.
4. The runtime supplies `context.now` as a valid `Date`, the user's explicit IANA `context.timezone`, and optionally `context.signal` for cancellation during preparation. Never substitute server-local timezone silently.
5. `services.readContext(kinds)` requests `note`, `goal`, `follow-up`, `reminder`, `memory`, `event`, and `artifact`. The integrated sources supply toolbox notes/goals, confirmed calendar events, eligible approved cards, and owned current-channel follow-ups/reminders. `artifact` remains a recognized but unconnected kind; legacy personal memory is also excluded. Records carry stable IDs, titles, text, and genuine optional `updatedAt`, `dueAt`, and normalized `status`. The consumer displays due times only for offset-bearing timestamps, so date-only goal deadlines are not converted to invented instants. The adapter orders events first, then deadlines and updates, while this feature scans only the first 200 records. Empty eligible sources return no records; source errors reject. See [source coverage](context.md).
6. No changes to the shared feature contract, dependency manifest, lockfile, or other features are required. `services.generate` and `services.search` are unused. No accounts, timers, jobs, calendar writes, model credentials, or outbound messaging permissions are needed.

## Verification

With Node 24, run the targeted suite and typecheck from the repository root:

```sh
node --import tsx --test tests/agent-meeting-prep.test.ts
npm run typecheck
git diff --check
```

The tests use the shared fake store/services and cover the complete flow, source provenance, unknown/closed commitment status, input/date validation (including extreme timestamps), user-timezone boundaries, historical excerpts, retention and byte limits, failure preservation, concurrent edits/refresh/deletion, repeatable atomic transforms, corrupted persisted data, untrusted source text, response bounds, and cancellation. No live APIs or inference tests are needed.

## Source capacity recovery (foundation follow-up)

Prepare/refresh read the same fixed source kinds in bounded sequential groups. A capacity failure is distinct from temporary unavailability and preserves every saved packet and added note. Use `/nobo-help agent meeting-prep list`, then `show <meeting-id>` for the saved packet. Reduce relevant source records in their original tools, such as `/nobo-help tools notes list`, then `edit <note-id> | <shorter body>`. Meeting-title/details filters apply after reading; changing them cannot reduce source-read bytes. See [shared source capacity handling](context.md#capacity-handling-in-the-foundation-follow-up).
