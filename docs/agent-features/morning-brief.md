# Personal morning briefing

`morning-brief` builds an on-demand, private day-ahead summary from your reminders, follow-ups, goals, notes, and imported events. It ranks up to five priorities, shows up to four of today's imported events, cites each record's kind and original ID, and reports missing sources. It does not read channel history.

The module is implemented; the parent integration must register the entry point and supply the source adapters before these commands are available in Slack.

## Commands

Prefix commands with `/nobo-help agent morning-brief`.

| Command | Behavior |
| --- | --- |
| `help` | Show syntax and examples without loading sources. |
| `brief` | Build a fresh brief using saved preferences. An empty command also runs `brief`. |
| `brief launch preparation` | Use a one-off focus, leaving the saved focus unchanged. |
| `show`, `settings`, `settings show` | Display all saved preferences; do not fetch personal context. |
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

The separate imported agenda is chronological, so an overdue task backlog cannot hide every meeting. Valid event ranges can span midnight or multiple days. Date-only ranges have an exclusive end date. Events ending exactly at today's midnight belong to the preceding day. Confirmed events that ended earlier today remain in today's agenda, marked `ended`, but are removed from priorities. An event without an end time is explicitly marked `end unknown`; no duration is invented. Repeated DST clock times display their UTC offset.

Coverage reports only the records returned by the adapters. “No usable records returned” can mean empty, unavailable, or unconnected; the shared contract cannot distinguish those cases. Missing or stale imported events do not establish calendar availability. A category containing only completed or distant records is distinguished from an empty category. Invalid records, duplicate records, disabled categories and the context scan limit are disclosed.

## Limits and retention

- No model calls, web search, reminders sent, calendar writes, account changes, recurring job creation, or external actions. Everything is deterministic and works without inference access.
- At most 500 returned records are examined, five priorities and four agenda entries are rendered. The response discloses truncation. There may be other records outside the adapter's own coverage; the feature cannot discover them.
- Matching uses the first 500 title characters and 4,000 body characters. Displayed titles are capped at 110 characters and excerpts at 160 before escaping. Responses stay below Slack's approximately 28,000-character limit.
- Only one small JSON document is stored at feature-local key `settings`: `{ "version": 1, "focus": "", "sources": ["reminder", "follow-up", "goal", "note", "event"] }`. No source documents, generated briefs, history, timestamps, or model output are retained. Preferences remain until reset; `show` displays all retained user preferences. Reset removes user-supplied content and leaves the default document.
- Malformed or unknown-version preferences are preserved until `settings reset confirm`; they are not silently overwritten. Source failures leave settings unchanged. Settings changes use pure synchronous atomic transforms; a brief in flight never writes over newer preferences.
- All commands are single-line and at most 500 characters. No empty source selection or duplicate categories. Invalid timezones and clocks fail visibly without falling back to server time.

## Exact parent integration requirements

1. Import the named `feature` (also the default export) from `lib/agent-features/morning-brief.ts`, register ID **`morning-brief`**, and add private help/Home routing for `/nobo-help agent morning-brief <command>`. The module returns text only; the parent owns identity checks and private Slack delivery. No shared-file changes or new dependencies are required by this implementation.
2. Supply the shared `AgentFeatureContext` with a valid runtime `now`, the caller's IANA `timezone`, and a workspace/user/feature-scoped store. Implement `store.update` with atomic retry semantics. No cross-feature store reads are performed here.
3. Implement `services.readContext(kinds)` for **`reminder`, `follow-up`, `goal`, `note`, `event`**, returning only caller-owned, authorized records. The feature calls it once per brief, only for selected categories. Incomplete/unknown category availability currently has no separate signal; an empty category is honestly described as empty or unconnected. A thrown error produces a retryable failure response without a cached or fabricated brief.
4. Map each returned record to a nonempty `title`, string `text` (empty is fine), stable original `id`, `kind`, optional `status`, `dueAt`, and `updatedAt`. IDs must be 1–160 characters without whitespace, controls, bidi controls, angle brackets, square brackets, ampersands or backticks. Citation format is `[kind original-id]`. Duplicates are collapsed by `(kind, id)`, choosing the latest valid timestamp in `updatedAt`; equal revisions prefer a terminal status, then a deterministic tie-break. Use real updated timestamps to avoid stale content winning a tie.
5. Normalize **completed/inactive status**. The excluded values, case-insensitively, are `done`, `complete`, `completed`, `closed`, `cancelled`, `canceled`, `archived`, `deleted`, `resolved`, `paused`, `disabled`, `inactive`, and `reached`. Missing or other string statuses remain eligible. In particular, the goals adapter must mark achieved goals completed; the feature cannot infer completion from arbitrary metadata. The reminders adapter should provide the next due occurrence for active recurring reminders, not the original start date.
6. Map a commitment's deadline to `dueAt`. Accepted dates are valid `YYYY-MM-DD` civil dates or ISO timestamps with `T` and explicit `Z`/`±HH:MM` offset, optional seconds and up to three fractional-second digits. Floating datetime strings, impossible dates and malformed offsets are rejected. Offset-free civil dates are intentional. Do not convert a date-only goal deadline into midnight UTC.
7. Feed **imported calendar occurrences** as `kind: "event"`, with `dueAt` as the start; `metadata.startAt` is supported as a fallback when `dueAt` is absent. Optional `metadata.endAt` is the exclusive end; it must use the same date-only/timed representation and be later than the start. Date-only starts mean all-day events; optional `metadata.allDay: true` must agree with that representation. Invalid event ranges become undated context and are omitted from the agenda. A missing end is supported. Expand only recurrence supported by the calendar feature, use stable occurrence IDs, and normalize cancelled statuses. This module does not import ICS or expand recurrence itself.

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

No direct reminder, follow-up, toolbox or calendar service imports are needed. The shared read-only context boundary owns those adapters; the feature does not access Redis, Slack or a production model.

## Verification

Run only the feature's tests and the typecheck in its isolated worktree:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-morning-brief.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

The tests use fake services and the shared in-memory store. They cover the complete preference/brief/reset flow, bounded ranking, source selection and missing-input honesty, timezone midnight boundaries, DST changes, all-day/multi-day/elapsed events, malformed source and persisted data, duplicate revisions, hostile excerpts, output limits, provider failures, cancellation, atomic retries and concurrent changes. No live inference, production reads or Slack sends are used.
