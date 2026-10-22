# Weekly personal review

`weekly-review` synthesizes seven calendar days of your personal goals, habits, journal, follow-ups and notes. It shows explicitly dated completions and journal-reported wins, commitments worth checking, recorded activity, simple patterns and next-week suggestions. Every finding cites a saved source reference. It does not require a model or web search.

This module is ready for parent integration; the command route below is not registered by this feature branch. All responses must be private.

## Commands

After parent integration, use `/nobo-help agent weekly-review <command>`:

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

- The latest **12 snapshots** are retained, ordered by invocation timestamp then UUID. Every successful `review` adds one, including an empty review or a repeat of the same week. Older snapshots and their reflections expire automatically; use `show` to copy a review before expiry or `delete` to remove it sooner.
- At most **1000 supplied records** are examined, then at most **five eligible sources per category** are selected (25 total). Explicit completions and flagged commitments are prioritized, then recent dates and stable IDs. Each section shows at most six findings, so the result is a bounded review of selected evidence, not an exhaustive report. Warnings identify omitted/invalid records and categories without eligible sources.
- Source titles are limited to 96 stored characters, excerpts to 200, findings to 260, and reflection text to 1000. Rendering applies additional limits after Slack escaping; output remains below 28,000 characters. A snapshot retains references and short excerpts, not full source documents.
- Reviews read current available records, not historical versions. Late edits and backfilled journal/habit dates may appear in a past week. Current open statuses edited after the requested end date are not used to infer historical stalled commitments. Sources without enough valid date/status evidence are omitted or shown only as recorded activity.
- Date-only values remain literal calendar dates; ISO timestamps must include `Z` or an explicit offset and are converted into the supplied timezone. No server-local timezone is used. Old toolbox habit dates were explicitly UTC-labelled dates; the adapter must preserve those declared calendar labels rather than manufacture midnight timestamps. The feature cannot reconstruct an original local instant from a date-only record.
- Invalid persisted state is not silently reset. The command returns a scoped-record diagnostic and leaves it untouched. Invalid individual source records/dated fields are skipped with a warning. A source-provider failure saves no new review and leaves existing state unchanged.
- New snapshots merge atomically with current state. Reflections bind `latest` to a specific ID before updating, cannot recreate a deleted/expired snapshot, and cannot overwrite a reflection with a later timestamp. Equal-timestamp reflection edits use atomic commit order. No async operations, ID generation or clock reads occur inside store transforms.

## Exact parent integration needs

1. Import the named/default `feature` from `lib/agent-features/weekly-review.ts`, register its exact ID `weekly-review`, and wire `/nobo-help agent weekly-review …` plus private discoverable help/Home entries. Shared routing/registry is intentionally unchanged here.
2. Supply `AgentFeatureContext` with the caller's workspace/user scope, request timestamp, timezone, optional abort signal, and atomic scoped `store`. This feature uses only the local store key `reviews`; the parent must namespace it by workspace, user and feature. Store transforms can retry and must preserve the shared atomic-update contract.
3. Implement the read-only `services.readContext(["goal", "habit", "journal", "follow-up", "note"])` adapter using **caller-owned authorized records only**. Include both open and completed follow-ups, not just the legacy open-only list. Give each record a stable ID; namespaced IDs such as `goal:<entry-id>` and `follow-up:<record-id>` are recommended. Supported source IDs are 1–128 characters without whitespace, controls, `<`, `>` or `&`.
4. Populate `kind`, `title`, `text`, `updatedAt`, `dueAt` and `status` from authorized source records. Raw titles/text may be up to 10,000/100,000 characters and are truncated before persistence. Metadata fields below are optional but enable the substantive review sections. Unknown fields are ignored; arbitrary metadata is never persisted.

   - Goals: `metadata.target`, `metadata.current` (finite nonnegative numbers up to 1 billion); `metadata.history` with up to 366 `{ at, value }` check-ins, mapped from toolbox `entry.data.history`; `dueAt` from `entry.data.due`. Completion requires an explicit completed status plus `metadata.completedAt`. **Do not invent `completedAt` from `updatedAt` or from reaching a numeric target.** Numeric progress is still useful without completion history. A goal with no status and `current < target` is considered open.
   - Habits: `metadata.days` as up to 366 explicit `YYYY-MM-DD` check-in dates, with duplicates deduplicated; `metadata.target` as an integer 1–7; optional `metadata.createdAt`. Map from `entry.data.days/target` and `entry.createdAt`. An explicit empty `days` array means zero recorded check-ins; absent `days` means the count is unknown. Archived/cancelled/deleted/paused habits are excluded.
   - Journal: `metadata.day`, integer `metadata.mood` 1–5, and optional `metadata.wins`, mapped from toolbox data. `text` should include the entry body/lessons. `day` is preferred over the edit date; if absent, the localized `updatedAt` supplies the journal date.
   - Follow-ups: `status`, `dueAt`, `metadata.completedAt`, optional `metadata.createdAt`; map the existing `completedAt` field explicitly. Supply a truthful `updatedAt` from the record's latest known creation/completion/edit event. Open statuses recognized are `open`, `active`, `in-progress`, `in_progress`, `pending`, `todo`, `blocked`, `stalled`. Completed statuses are `done`, `completed`, `complete`, `achieved`, `reached`.
   - Notes: `title`, `text` from the body, and a truthful `updatedAt`.

5. Ensure explicit ISO timestamps include seconds and `Z`/an offset (up to three fractional digits), and date-only fields are valid Gregorian `YYYY-MM-DD`. Missing metadata is acceptable; malformed date values are not guessed. No model/search adapter work is required for this feature, and it makes no direct Redis, Slack, network, scheduler or production-service calls.

No new packages, contract fields, account grants, background jobs or outbound messages are required.

## Verification

Run only the owned test file during parallel feature development, then typecheck and check whitespace:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-weekly-review.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

The tests use the supplied scoped in-memory store and fake context services. They cover complete/empty flows, source provenance, input/persisted-data validation, timezone and DST boundaries, historical uncertainty, bounded retention/output, provider errors, cancellation, retry-safe transforms, simultaneous saves and reflection/delete races. No live inference or external writes are tested.
