# Time-blocked day planner

Command ID: `day-planner`. Every command returns a private reply through the parent agent-feature router. This module is ready for integration; it does not register its own route.

Build an on-demand, deterministic proposal around your tasks, working hours, fixed breaks, and owned calendar events. It never writes to a calendar or calls a model. Tasks remain in the planner until you remove them; scheduling does not mark them complete.

## A complete flow

Use `/nobo-help agent day-planner` before each command below:

```text
settings hours 09:00-17:00
settings breaks 12:00-12:30,15:00-15:15
add Review launch checklist | 45 | high | 2026-10-23T10:00
add Draft proposal | 90 | normal | 2026-10-23T16:00
add File receipts | 20 | low
tasks
plan 2026-10-23
show
remove <full-task-id-from-tasks>
plan 2026-10-23
```

Use a current or future date when running these examples. `add` returns a stable UUID, and `tasks` lists those IDs. To change a task, remove its ID and add the replacement. Any successful task/settings edit clears the saved plan so `show` cannot present an outdated task list as current.

The plan lists task blocks, blocked intervals with source IDs, and a reason for every unscheduled task. Overlapping events and breaks are merged into nonoverlapping unavailable intervals. Tasks may fill a smaller earlier gap even if a higher-priority, longer task was placed later.

## Commands and limits

- `help`: syntax and examples; also returned for an empty command.
- `tasks`: all saved tasks and IDs, with deadlines normalized to UTC.
- `add <title> | <minutes> | <priority> [| <deadline>]`: title 1–160 characters without line breaks or `|`; duration is an integer 1–720 minutes; priority is `high`, `normal`, or `low`. Up to 50 tasks.
- `remove <full-task-id>`: delete one task and invalidate the saved plan.
- `settings`: inspect working-hour/break preferences and the supplied timezone.
- `settings hours HH:mm-HH:mm`: a same-day interval; start must precede end. Only the end may be `24:00`. Default: `09:00-17:00`.
- `settings breaks HH:mm-HH:mm[,HH:mm-HH:mm]`: up to four nonoverlapping breaks, sorted automatically. Default: `12:00-12:30`. Breaks only block the portion within working hours. `settings breaks none` removes all breaks.
- `plan YYYY-MM-DD`: compute and save one proposal for today or a future date in your supplied timezone. Real dates in years 1900–2200 are accepted. For today, start at the current minute if exact, otherwise round up to the next full minute. An ended workday reports all tasks as unscheduled.
- `show`: display the last successful plan, using its original timezone, creation time, and event snapshot. Rerun `plan` to refresh calendar context.
- `clear confirm`: delete all tasks, the plan, and preferences; restore default working hours/breaks. This also explicitly recovers invalid or unsupported stored data. `clear` alone only explains the confirmation syntax.

The state holds at most 50 tasks, four breaks, 200 event labels, and one plan. A new successful plan replaces the old one; no history is kept. A plan has at most 254 nonoverlapping blocks. The persisted document is validated against a 150,000-character JSON bound. Replies are limited to 27,000 characters. At most 12 unavailable intervals are displayed in detail (with up to two source IDs each); omitted intervals still block scheduling. All normal task rows and unscheduled reasons remain visible. Slack mention/link delimiters in user/source text are neutralized for display.

## Timezones and DST

The runtime's `context.timezone` is authoritative. There is no server-local or silent UTC fallback, and this feature does not change your timezone preference.

Deadlines are **finish-by** times. `2026-10-23T16:00` means local wall time in the supplied timezone, converted once when adding the task. Later timezone changes do not move that deadline. An explicit offset or `Z` specifies an absolute instant, independently of the supplied zone:

```text
add First repeated hour | 30 | high | 2026-11-01T01:30-05:00
add Second repeated hour | 30 | high | 2026-11-01T01:30-06:00
```

In `America/Chicago`, the local time `2026-11-01T01:30` is ambiguous and rejected without an offset. `2026-03-08T02:30` does not exist and is also rejected. Choose an unambiguous local boundary for working hours/breaks; these preferences do not accept offsets. The error identifies the problematic date, time, and zone. A failure preserves any previous plan.

Durations count actual elapsed minutes, so a task crossing a clock change can have different-looking local start/end times. Plan rows display UTC offsets to distinguish repeated hours. A `00:00-24:00` workday is 23 or 25 actual hours at ordinary spring/fall transitions; half-hour shifts and skipped dates are handled as well. A midnight end on the following date is labeled with that date.

## Scheduling behavior and limitations

Tasks are sorted by priority, earliest deadline within that priority, creation timestamp, then stable ID. Each is assigned to its earliest remaining continuous slot that finishes by its deadline. Existing events/breaks are hard constraints and adjacent intervals use an exclusive end. Higher-priority tasks can leave lower-priority tasks with urgent deadlines unscheduled. This is a deterministic greedy schedule, not a global optimizer or a promise that every mathematically possible combination will be found.

Tasks are never split. There are no dependencies, travel buffers, recurring tasks, automatic completion, overnight working hours, automatic replanning, calendar writes, or focus timers. Breaks are fixed wall-time intervals, not periodic rest rules. There is no model/search use. Event titles/text are untrusted data and cannot trigger tools or commands.

The schedule only knows the owned event context the adapter supplies. An empty context is explicitly reported and does not verify any external calendar. Failed context reads, invalid event intervals, oversized context, cancellation before saving, and invalid local times do not replace the saved plan. A concurrent task/settings edit or another successfully saved plan causes an in-flight stale proposal to be discarded. Updating tasks/settings is atomic; UUIDs and timestamps are generated outside retryable store transforms.

## Exact parent integration requirements

1. Register the named/default `feature` export from `lib/agent-features/day-planner.ts` under **`day-planner`**. Wire `/nobo-help agent day-planner <command>` and its private discovery/help entry. There are no shared routing or registry changes in this commit.
2. Supply the normal workspace/user/feature-scoped `AgentFeatureContext`, current `now`, a valid IANA `timezone`, and atomic retryable `store.update`. The only key this feature reads/writes is **`state` within its feature namespace**. Store version is 1. Identity checks, private delivery, command deduplication, and persisted-state lifecycle remain runtime responsibilities.
3. Implement `services.readContext(["event"])` using caller-owned events, including the calendar import feature when integrated. Return a **complete** bounded set of at most 200 event records; do not silently truncate it. The current shared method accepts no date-window parameter, so the planner asks for the owned event set and clips it itself. If the source cannot return that complete set, fail the call; supporting larger calendars requires a parent-owned contract extension for complete windowed reads.
4. Every busy event must have a unique nonempty `id` (at most 120 characters, no control characters or surrounding whitespace), `kind: "event"`, a string `title` (at most 2,000 characters), and the following metadata:

   ```ts
   {
     startAt: "2026-10-23T10:00:00-05:00", // or UTC ISO with Z
     endAt: "2026-10-23T11:00:00-05:00",   // exclusive; strictly after startAt
     busy: true                          // optional; defaults to true
   }
   ```

   Both timestamps must have explicit offsets or `Z`; naive timestamps, missing ends, duplicate IDs, or malformed records reject the entire proposal. No inference from `dueAt`, natural-language text, or an assumed duration occurs. Record `status: "cancelled"` / `"canceled"`, or `metadata.busy: false`, to skip a nonblocking event. Normalize other transparency/status spellings in the adapter.

5. Convert all-day events to absolute start/end instants using the calendar's intended timezone, preserving the **exclusive end date**; the same metadata shape then works for all-day or multiday events. `allDay` may be included for provenance but does not alter scheduling. Date-only `startDate`/`endDate` metadata is not consumed here. Expand any supported recurrence in the calendar adapter before supplying concrete occurrences, with distinct IDs. Propagate calendar import/completeness failures instead of silently dropping conflicts.

No new dependencies, model configuration, external grants, secrets, Redis key access, outbound messaging, or calendar-write adapter are required.

## Verification

From the worktree, with Node 24 available on `PATH`:

```sh
node --import tsx --test tests/agent-day-planner.test.ts
npm run typecheck
git diff --check
```

Tests use only the shared in-memory store fixture and fake services. They cover complete command flows, priority/deadline ordering, merged blockers, empty/error states, bounded retention/output, invalid persisted state, DST gaps/overlaps and non-hour changes, all-day/overnight event boundaries, retries, concurrent changes, cancellation, and provider failure preservation.
