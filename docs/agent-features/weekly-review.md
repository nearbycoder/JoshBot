# Weekly personal review

Use `/nobo-help agent weekly-review help` for commands. This is one of the original twenty personal agents deployed in PR #58, with private replies and Home discovery. See [verified release status](../personal-agent-expansion.md).

`weekly-review` synthesizes seven calendar days of your personal goals, habits, journal, follow-ups and notes. It shows explicitly dated completions and journal-reported wins, commitments worth checking, recorded activity, simple patterns and next-week suggestions. Every finding cites a saved source reference. It does not require a model or web search.

Reviews read your private toolbox goals, habits, journal, and notes, plus your follow-ups in the channel where you run the command. Other channels are outside this review. See [source coverage](context.md).

## Commands

Use `/nobo-help agent weekly-review <command>`:

```text
/nobo-help agent weekly-review help
/nobo-help agent weekly-review review
/nobo-help agent weekly-review review 2026-10-22
/nobo-help agent weekly-review history
/nobo-help agent weekly-review show latest
/nobo-help agent weekly-review reflect latest | Protected mornings helped. Next week I will make one smaller commitment.
```

`review 2026-10-22` includes October 16–22 in your supplied timezone. Without a date, the end date is today in that timezone, and the review warns that today is still in progress. Future end dates are rejected. Calendar days span daylight-saving changes correctly; seven days need not equal 168 hours.

Each review creates a new immutable snapshot with a full `wr-<UUID>` ID. Copy that ID from the review or `history` to use these commands:

```text
show wr-12345678-1234-4234-8234-123456789abc
reflect wr-12345678-1234-4234-8234-123456789abc | I will scope the beta follow-up to one decision.
delete wr-12345678-1234-4234-8234-123456789abc confirm
```

The sample UUID is illustrative; use an actual saved ID. `show` defaults to `latest`. Reflections accept 1–1000 characters, may contain `|`, and replace that review's previous reflection. A reflection stays separate from source-backed findings. `delete` requires the full ID and the literal word `confirm`, removing the snapshot and reflection. It does not delete original source records.

An empty week still creates a snapshot for reflection and explains how to add useful source data. `history`, `show`, `reflect`, `delete` and `help` do not read source services.

## What the review means

- **Completed work:** goals/follow-ups with an explicit completed status and completion date inside the window; journal wins are identified as user-reported wins. A done status plus a recent edit is not treated as a known completion date.
- **Stalled commitments to check:** open goals/follow-ups whose due date precedes the review's end date, whose last recorded update predates the window, or whose status explicitly says blocked/stalled. In-window goal progress prevents an inactivity flag. These are prompts to check a commitment, not proof of inactivity. Due on the end date is not yet considered overdue.
- **Activity:** latest dated goal progress, dated journal entries, notes and other records updated in the window. Targets are explicitly described as current targets.
- **Patterns:** unique habit check-in dates, mean journal mood over distinct recorded dates, and repeated English words found in more than one source category. Mood does not fill in missing days; topic overlap does not establish causality. For duplicate journal dates, the record with the latest update is preferred (stable source ID breaks remaining ties).
- **Suggestions:** consider a smaller next action or revised scope/date for an open commitment, realistic habit check-in dates, a measurable next goal checkpoint, or one priority from a repeated topic. These are deterministic suggestions; no external task is created or completed.

Source titles/excerpts are quoted data, and Slack angle-bracket markup is escaped. Instructions inside a source never execute. A note merely saying “done” does not become a verified completion.

## Retention and practical limits

- Up to the latest **12 snapshots** are retained, ordered by invocation timestamp then UUID, subject to the byte quota below. Every successful `review` adds one, including an empty review or a repeat of the same week. The thirteenth accepted snapshot expires the oldest snapshot and its reflection; use `show` to copy a review before expiry or `delete` to remove it sooner.
- Snapshots, excluding reflection objects, must occupy **less than 400,000 serialized UTF-8 bytes**. Every write also checks that the entire JSON state is **below 480,000 bytes**, under the runtime's 512,000-byte value limit. Byte counts use `Buffer.byteLength(JSON.stringify(value), "utf8")`, including Unicode and JSON escaping. The 80,000-byte difference reserves space for all 12 maximum-length reflections (even six-byte JSON escapes per character), their timestamps and later lifecycle changes. Adding or replacing a reflection does not consume the snapshot budget.
- Large Unicode-heavy reviews can fill the snapshot budget before 12 records. A review that would exceed the budget is rejected atomically, with all existing snapshots/reflections preserved; the byte quota does not silently evict extra records. `history` shows actual total/snapshot byte usage. To free space, use `history`, copy an older review with `show <id>`, then run `delete <id> confirm` and retry. Accepted snapshots retain room for reflection updates and deletion even when another review is rejected.
- At most **1000 supplied records** are examined, then at most **five eligible sources per category** are selected (25 total). Explicit completions and flagged commitments are prioritized, then recent dates and stable IDs. Each section shows at most six findings, so the result is a bounded review of selected evidence, not an exhaustive report. Warnings identify omitted/invalid records and categories without eligible sources.
- Source titles are limited to 96 stored characters, excerpts to 200, findings to 260, and reflection text to 1000. Rendering applies additional limits after Slack escaping; output remains below 28,000 characters. A snapshot retains references and short excerpts, not full source documents.
- Reviews read current available records, not historical versions. Late edits and backfilled journal/habit dates may appear in a past week. Current open statuses edited after the requested end date are not used to infer historical stalled commitments. Sources without enough valid date/status evidence are omitted or shown only as recorded activity.
- Date-only values remain literal calendar dates; ISO timestamps must include `Z` or an explicit offset and are converted into the supplied timezone. No server-local timezone is used. Old toolbox habit dates were explicitly UTC-labelled dates; the adapter must preserve those declared calendar labels rather than manufacture midnight timestamps. The feature cannot reconstruct an original local instant from a date-only record.
- Invalid persisted state is not silently reset. The command returns a scoped-record diagnostic and leaves it untouched. Invalid individual source records/dated fields are skipped with a warning. A source-provider failure saves no new review and leaves existing state unchanged.
- New snapshots merge atomically with current state. Reflections bind `latest` to a specific ID before updating, cannot recreate a deleted/expired snapshot, and cannot overwrite a reflection with a later timestamp. Equal-timestamp reflection edits use atomic commit order. No async operations, ID generation or clock reads occur inside store transforms.
- Each `review` makes one context read and **zero generation/search calls**; all other commands make zero service calls. This stays within the runtime's eight-generation/six-search budgets. The runtime supplies the 120-second deadline, prompt cancellation and guarded storage writes; the feature respects the supplied abort signal and uses only those scoped services/store. No independent background work continues a cancelled command.

## Runtime and source contract

1. `registry.ts` registers the named/default `feature` from `lib/agent-features/weekly-review.ts` as `weekly-review`. `index.ts` dispatches `/nobo-help agent weekly-review <command>` through the shared runtime; the Slack route returns private text and Home exposes its help. The shared route preserves multiline command text; individual commands still enforce their input rules.
2. The runtime supplies `AgentFeatureContext` with the caller's workspace/user scope, request timestamp, timezone, optional abort signal, and atomic scoped `store`. This feature uses only the local store key `reviews`; the shared store namespaces it by workspace, user and feature. Store transforms can retry and must preserve the shared atomic-update contract.
3. `services.readContext(["goal", "habit", "journal", "follow-up", "note"])` reads private toolbox records and owned follow-ups in the signed current channel, including both open and completed follow-ups. Stable IDs use `toolbox:<tool>:<entry-id>` or `follow-up:<record-id>`. Supported source IDs are 1–128 characters without whitespace, controls, `<`, `>` or `&`. Preserve the field semantics below and the [shared coverage/error contract](context.md).
4. Populate `kind`, `title`, `text`, `updatedAt`, `dueAt` and `status` from authorized source records. Raw titles/text may be up to 10,000/100,000 characters and are truncated before persistence. Metadata fields below are optional but enable the substantive review sections. Unknown fields are ignored; arbitrary metadata is never persisted.

   - Goals: `metadata.target`, `metadata.current` (finite nonnegative numbers up to 1 billion); `metadata.history` with up to 366 `{ at, value }` check-ins, mapped from toolbox `entry.data.history`; `dueAt` from `entry.data.due`. Completion requires an explicit completed status plus `metadata.completedAt`. **Do not invent `completedAt` from `updatedAt` or from reaching a numeric target.** Numeric progress is still useful without completion history. A goal with no status and `current < target` is considered open.
   - Habits: `metadata.days` as up to 366 explicit `YYYY-MM-DD` check-in dates, with duplicates deduplicated; `metadata.target` as an integer 1–7; optional `metadata.createdAt`. Map from `entry.data.days/target` and `entry.createdAt`. An explicit empty `days` array means zero recorded check-ins; absent `days` means the count is unknown. Archived/cancelled/deleted/paused habits are excluded.
   - Journal: `metadata.day`, integer `metadata.mood` 1–5, and optional `metadata.wins`, mapped from toolbox data. `text` should include the entry body/lessons. `day` is preferred over the edit date; if absent, the localized `updatedAt` supplies the journal date.
   - Follow-ups: `status`, `dueAt`, `metadata.completedAt`, optional `metadata.createdAt`; map the existing `completedAt` field explicitly. Supply a truthful `updatedAt` from the record's latest known creation/completion/edit event. Open statuses recognized are `open`, `active`, `in-progress`, `in_progress`, `pending`, `todo`, `blocked`, `stalled`. Completed statuses are `done`, `completed`, `complete`, `achieved`, `reached`.
   - Notes: `title`, `text` from the body, and a truthful `updatedAt`.

5. Ensure explicit ISO timestamps include seconds and `Z`/an offset (up to three fractional digits), and date-only fields are valid Gregorian `YYYY-MM-DD`. Missing metadata is acceptable; malformed date values are not guessed. No model/search adapter work is required for this feature, and it makes no direct Redis, Slack, network, scheduler or production-service calls.

No new packages, contract fields, account grants, background jobs or outbound messages are required.

## Verification

With Node 24, run the targeted suite, typecheck and whitespace check:

```sh
node --import tsx --test tests/agent-weekly-review.test.ts
npm run typecheck
git diff --check
```

The tests use the supplied scoped in-memory store and fake context services. They cover complete/empty flows, source provenance, input/persisted-data validation, timezone and DST boundaries, historical uncertainty, bounded retention/output, provider errors, cancellation, retry-safe transforms, simultaneous saves and reflection/delete races. Quota tests measure serialized UTF-8 bytes with Unicode-heavy snapshots and worst-case escaped reflections, enforce the runtime/feature limits on every fake-store write, verify full-quota rejection preserves state, and prove deletion permits another review without concurrent overfilling. No live inference or external writes are tested.

## Source capacity recovery (foundation follow-up)

Reviews read the same fixed kinds in bounded sequential groups. Capacity failure saves no review and preserves reflections. `/nobo-help agent weekly-review show latest` remains available. Reduce relevant records in their original tools, such as `/nobo-help tools notes list`, then `edit <note-id> | <shorter body>`. The seven-day filter is applied after the source read; changing the end date cannot fix source capacity. See [shared source capacity handling](context.md#capacity-handling-in-the-foundation-follow-up).
