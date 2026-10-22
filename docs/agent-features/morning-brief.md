# Personal morning briefing

`morning-brief` builds an on-demand, private day-ahead summary from your reminders, follow-ups, goals, notes, and imported events. It ranks up to five priorities, shows up to four of today's imported events, cites each record's kind and original ID, and reports missing sources. It does not read channel history.

The module is implemented; the parent integration must register the entry point and supply the source adapters before these commands are available in Slack.

## Commands

Prefix commands with `/nobo-help agent morning-brief`.

| Command | Behavior |
| --- | --- |
| `help` | Show syntax and examples without loading sources. An empty command also shows help, matching the shared runtime. |
| `brief` | Build a fresh brief using saved preferences. |
| `brief launch preparation` | Use a one-off focus, leaving the saved focus unchanged. |
| `show`, `settings`, `settings show` | Display all saved preferences and their serialized UTF-8 byte usage; do not fetch personal context. |
| `settings focus launch preparation` | Save a focus of 1–160 characters. |
| `settings focus clear` | Remove the saved focus. `clear` is reserved in this command. |
| `settings sources reminders,follow-ups,goals,events` | Select one or more categories. Singular contract names also work. |
| `settings sources all` | Include all five categories, the default. |
| `settings reset confirm` | Erase preferences and restore defaults, including recovery from malformed saved settings. |

For example:

```text
/nobo-help agent morning-brief settings focus launch
/nobo-help agent morning-brief settings sources reminders,follow-ups,goals,notes,events
/nobo-help agent morning-brief brief
/nobo-help agent morning-brief brief customer follow-through
/nobo-help agent morning-brief show
```

The second brief uses `customer follow-through` once. `show` still displays the saved `launch` focus. Focus matches whole Unicode letter/number tokens in source titles and excerpts; any matching token counts. It helps order each urgency group and never hides other commitments. Matching is lexical, without semantic search, stemming, or a model.

## What a brief means

The supplied timezone determines today's date. Priority groups are ordered **Overdue → Today → Later → Undated**. Within a group, focus matches come first, then earlier dates/times, source category (`reminder`, `follow-up`, `goal`, `note`, `event`), and stable source ID. At the same date, an explicit time precedes a date-only deadline. A date-only deadline stays on that local calendar day; a timed deadline is converted from its explicit offset. An earlier time today remains in Today rather than Overdue.

- **Overdue:** incomplete commitments dated before the current local day. Past events do not become overdue tasks.
- **Today:** commitments dated today and imported events that overlap today.
- **Later:** dates after today through the next seven calendar days, inclusive. Farther dates are counted as excluded.
- **Undated:** source context without a usable date. Invalid dates are disclosed and never interpreted using server-local time.

For example, a follow-up due yesterday can appear as `1. Overdue · Obtain launch approval — due 2026-10-21 [follow-up fu-1]`. A related undated note can appear as context with `[note note-1]`. Source excerpts are labeled, flattened, escaped, and shortened; they are not instructions to the agent.

The separate imported agenda is chronological, so an overdue task backlog cannot hide every meeting. Valid event ranges can span midnight or multiple days. All-day events use their original civil `startDate`/`endDate` metadata when the calendar adapter supplies normalized timestamps alongside them. Those civil dates determine their placement in the caller's local day, including when the viewing timezone differs from the import timezone. The optional normalized timestamps are checked against midnight boundaries in the adapter's declared timezone. This supports 23-hour and 25-hour all-day events across DST without assuming a fixed duration.

Date-only ranges have an exclusive end date. Events ending exactly at today's midnight belong to the preceding day. Confirmed timed events that ended earlier today remain in today's agenda, marked `ended`, but are removed from priorities. An event without an end time is explicitly marked `end unknown`; no duration is invented. Repeated DST clock times display their UTC offset. Invalid civil dates, reversed or empty all-day ranges, and contradictory normalized boundaries are disclosed as undated and omitted from the agenda.

Coverage reports only the records returned by the adapters. “No usable records returned” can mean empty, unavailable, or unconnected; the shared contract cannot distinguish those cases. Missing or stale imported events do not establish calendar availability. A category containing only completed or distant records is distinguished from an empty category. Invalid records, duplicate records, disabled categories and the context scan limit are disclosed.

## Limits and retention

- No model calls, web search, reminders sent, calendar writes, account changes, recurring job creation, or external actions. Everything is deterministic and works without inference access.
- At most 500 returned records are examined, five priorities and four agenda entries are rendered. The response discloses truncation. There may be other records outside the adapter's own coverage; the feature cannot discover them.
- Matching uses the first 500 title characters and 4,000 body characters. Displayed titles are capped at 110 characters and excerpts at 160 before escaping. Responses stay below Slack's approximately 28,000-character limit.
- Only one small JSON document is stored at feature-local key `settings`: `{ "version": 1, "focus": "", "sources": ["reminder", "follow-up", "goal", "note", "event"] }`. No source documents, generated briefs, history, timestamps, or model output are retained. Preferences remain until reset; `show` displays all retained user preferences. Reset removes user-supplied content and leaves the default document.
- The feature enforces a **2,048-byte serialized UTF-8 preference budget**, measured with `Buffer.byteLength(JSON.stringify(settings), "utf8")`. This is well below the 480,000-byte feature ceiling and the shared store's 512,000-byte hard limit, leaving at least 477,952 bytes below the feature ceiling for later lifecycle changes. The 160 UTF-16-code-unit focus limit also bounds emoji, multibyte text, and JSON escape expansion. Valid preferences remain below 2,048 bytes even with all source categories and worst-case accepted text. No accepted records accumulate or consume processing headroom. `show` reports usage; shorten the focus, run `settings focus clear`, or run `settings reset confirm` to free space. A quota rejection never replaces saved preferences.
- Per invocation this feature uses **zero generation calls, zero searches, and at most one context read**, within the runtime's eight-generation/six-search limits. It relies on the shared runtime's 120-second deadline, prompt cancellation of pending service calls, and guarded store writes. It checks the abort signal around context retrieval and never writes a completed brief. Output stays below the runtime's 28,000-character cap without relying on runtime truncation.
- Malformed or unknown-version preferences are preserved until `settings reset confirm`; they are not silently overwritten. Source failures leave settings unchanged. Settings changes use pure synchronous atomic transforms; a brief in flight never writes over newer preferences.
- All commands are single-line and at most 500 characters. No empty source selection or duplicate categories. Invalid timezones and clocks fail visibly without falling back to server time.

## Exact parent integration requirements

1. Import the named `feature` (also the default export) from `lib/agent-features/morning-brief.ts`, register ID **`morning-brief`**, and add private help/Home routing for `/nobo-help agent morning-brief <command>`. The module returns text only; the parent owns identity checks and private Slack delivery. No shared-file changes or new dependencies are required by this implementation.
2. Use the parent-owned shared runtime/store and supply `AgentFeatureContext` with a valid runtime `now`, the caller's IANA `timezone`, and workspace/user/feature-scoped storage. The existing `store.update` atomic retry semantics and cancellation write guards are sufficient. No shared contract changes or cross-feature store reads are required.
3. Implement `services.readContext(kinds)` for **`reminder`, `follow-up`, `goal`, `note`, `event`**, returning only caller-owned, authorized records. The feature calls it once per brief, only for selected categories. Incomplete/unknown category availability currently has no separate signal; an empty category is honestly described as empty or unconnected. A thrown error produces a retryable failure response without a cached or fabricated brief.
4. Map each returned record to a nonempty `title`, string `text` (empty is fine), stable original `id`, `kind`, optional `status`, `dueAt`, and `updatedAt`. IDs must be 1–160 characters without whitespace, controls, bidi controls, angle brackets, square brackets, ampersands or backticks. Citation format is `[kind original-id]`. Duplicates are collapsed by `(kind, id)`, choosing the latest valid timestamp in `updatedAt`; equal revisions prefer a terminal status, then a deterministic tie-break. Use real updated timestamps to avoid stale content winning a tie.
5. Normalize **completed/inactive status**. The excluded values, case-insensitively, are `done`, `complete`, `completed`, `closed`, `cancelled`, `canceled`, `archived`, `deleted`, `resolved`, `paused`, `disabled`, `inactive`, and `reached`. Missing or other string statuses remain eligible. In particular, the goals adapter must mark achieved goals completed; the feature cannot infer completion from arbitrary metadata. The reminders adapter should provide the next due occurrence for active recurring reminders, not the original start date.
6. Map a commitment's deadline to `dueAt`. Accepted dates are valid `YYYY-MM-DD` civil dates or ISO timestamps with `T` and explicit `Z`/`±HH:MM` offset, optional seconds and up to three fractional-second digits. Floating datetime strings, impossible dates and malformed offsets are rejected. Offset-free civil dates are intentional. Do not convert a date-only goal deadline into midnight UTC.
7. Feed **imported calendar occurrences** through the existing `readCalendarEventContext(calendarScopedStore, callerTimezone)` helper in the parent-owned context adapter. Keep its `kind: "event"`, `dueAt`, `metadata.startAt`, `metadata.endAt`, `metadata.allDay`, `metadata.startDate`, `metadata.endDate`, and `metadata.timezone` fields unchanged. `dueAt` supplies the start, with `metadata.startAt` as a fallback. Timed ranges require an exclusive end later than the start when supplied. For `allDay: true`, a supplied civil date pair must contain real `YYYY-MM-DD` dates with `endDate > startDate`; these dates govern the briefing. Any provided normalized timestamps must be valid, ordered midnight boundaries matching the civil dates in `metadata.timezone` (or the caller's timezone when that field is absent). They need not span a multiple of 24 hours. All-day records with civil dates alone are also supported, as are the original date-only `dueAt`/`metadata.endAt` inputs. An all-day absolute timestamp without civil metadata remains ambiguous and is rejected. Invalid or contradictory event ranges become undated context and are omitted from the agenda. A missing end remains supported for ordinary date-only or timed inputs. Expand only recurrence supported by the calendar feature, use stable occurrence IDs, and normalize cancelled statuses. This module does not import ICS or expand recurrence itself. No shared-adapter transformation is needed for this fix.

Example event supplied by the parent adapter:

```json
{
  "id": "calendar-occurrence-42",
  "kind": "event",
  "title": "Launch planning",
  "text": "Review open launch questions.",
  "dueAt": "2026-10-22T11:00:00-05:00",
  "status": "active",
  "metadata": { "endAt": "2026-10-22T12:00:00-05:00" }
}
```

For an all-day ICS event with `DTSTART;VALUE=DATE:20261022` and `DTEND;VALUE=DATE:20261023`, the actual calendar helper viewed in `America/Chicago` supplies `dueAt: "2026-10-22T05:00:00.000Z"` plus `metadata: { "allDay": true, "startDate": "2026-10-22", "endDate": "2026-10-23", "startAt": "2026-10-22T05:00:00.000Z", "endAt": "2026-10-23T05:00:00.000Z", "timezone": "America/Chicago" }`. The October 22 brief shows it as all-day; the October 23 brief excludes it as a past event.

No direct reminder, follow-up, toolbox or calendar service imports are needed. The shared read-only context boundary owns those adapters; the feature does not access Redis, Slack or a production model.

## Verification

Run only the feature's tests and the typecheck in its isolated worktree:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-morning-brief.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Three cross-feature tests invoke the real calendar `import preview`/`import confirm` flow and `readCalendarEventContext` with an isolated in-memory calendar store, then pass the unmodified event context to the morning brief. They automatically load the local calendar module in the integrated checkout. In an isolated feature checkout without calendar files, point them at a read-only checkout or temporary export of the actual calendar module and its relative dependencies:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH MORNING_BRIEF_CALENDAR_MODULE=/path/to/JoshBot/lib/agent-features/calendar.ts node --import tsx --test tests/agent-morning-brief.test.ts
```

Without a local calendar module or that environment variable, only those three integration tests are explicitly skipped. A configured but missing module fails the tests. The follow-up was validated against the parent calendar helper with **26 passing tests and zero skips**. The real-import cases cover the October 22 regression, different import/viewing timezones, multi-day ranges, midnight-exclusive ends, and the 23-hour/25-hour DST days.

The tests use fake services and the shared in-memory store. They also cover the complete preference/brief/reset flow, bounded ranking, source selection and missing-input honesty, timezone midnight boundaries, elapsed events, malformed source and persisted data, contradictory all-day metadata, duplicate revisions, hostile excerpts, output limits, serialized UTF-8 byte usage with Unicode and JSON escaping, retained room for subsequent updates/reset, provider failures, cancellation, atomic retries and concurrent changes. No live inference, production reads or Slack sends are used.
