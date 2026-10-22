# Calendar import and availability

`calendar` is a private, on-demand calendar snapshot. Paste ICS, review the proposed events, and confirm before they become part of your agenda, availability, or conflict results. It does not fetch URLs, connect accounts, send invitations, book time, or modify external calendars. No model or search calls are used.

The registered private route is `/nobo-help agent calendar <command>`. See the [expansion status](../personal-agent-expansion.md) for release readiness.

## Import a calendar

Paste this whole command as text, without Markdown code fences:

```text
/nobo-help agent calendar import preview BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//My personal calendar//EN
BEGIN:VEVENT
UID:planning-20261023@example.test
DTSTART;TZID=America/Chicago:20261023T090000
DTEND;TZID=America/Chicago:20261023T100000
SUMMARY:Project planning
LOCATION:Home office
END:VEVENT
BEGIN:VEVENT
UID:away-20261026@example.test
DTSTART;VALUE=DATE:20261026
DTEND;VALUE=DATE:20261027
SUMMARY:Away
END:VEVENT
END:VCALENDAR
```

The preview shows the event IDs, times, number of additions/changes, and a confirmation command. Copy its token into:

```text
/nobo-help agent calendar import confirm <preview-token>
```

Only the latest preview is valid; it expires after 30 minutes. `import cancel <preview-token>` discards it. `import <ICS>` is an alias for `import preview <ICS>`. Previewed events are excluded from agendas and the parent context adapter until confirmed.

UID identifies an event within your private calendar. Reimporting the same UID updates that event after confirmation and preserves its removal ID. Identical reimports preserve the event's update timestamp. Other saved events remain, including events omitted from a later paste: this is an additive/update import, not full-calendar synchronization. Duplicate UIDs inside one paste are rejected. Namespaced UIDs matter when combining exports from different calendars.

## Inspect your time

Every command uses `/nobo-help agent calendar` as its prefix:

| Command | Behavior |
| --- | --- |
| `help` | Syntax, examples, and supported-input limits. |
| `list` | All saved events, stable removal IDs, and any pending-preview token. |
| `agenda 2026-10-23` | Events touching that local date, including overnight events. |
| `free 2026-10-23 \| 45m` | Maximal free windows with at least 45 elapsed minutes. |
| `free 2026-10-23 \| 2h` | Same check for two hours; bare numbers mean whole minutes. |
| `conflicts` | Overlapping busy-event pairs across the saved snapshot; up to 20 pairs displayed, with the total count. |
| `remove cal_<24-hex-characters> confirm` | Delete the exact ID from `list`. |
| `clear confirm` | Delete every saved event and the pending preview. |

Availability covers the **whole local day**, midnight to the next midnight, with no inferred working hours or buffers. A 23-hour or 25-hour DST day uses its actual elapsed duration. Busy intervals are merged before finding gaps; adjacent events do not conflict. Transparent events and timed events without an end do not block time. All-day busy events block their full date range. Empty calendars explicitly report that the real calendar has not been checked.

All results use the runtime-supplied user timezone, and timed output includes UTC offsets. No server-local timezone fallback is used. An event ending exactly at midnight does not appear on the next day's agenda. Events with no duration appear on their start date.

`list` renders all-day dates and removal IDs directly, without converting midnight to an instant. It orders events by local start date, with all-day entries first on each date. This keeps records discoverable and removable after a timezone preference change even if an all-day endpoint becomes ambiguous or nonexistent. For example, an all-day `2026-11-01` event imported in UTC remains listed after switching to `America/Havana`.

`agenda` and `free` first filter all-day events by their stored civil-date range `[startDate, endDate)`, then resolve relevant intervals in the viewing timezone. That November event cannot break an unrelated October 23 query or a query on its exclusive end date. A requested day with ambiguous/nonexistent midnight, or a relevant event with an unresolved endpoint, still produces an explicit error. Whole-calendar `conflicts` and the complete context adapter remain strict and do not silently omit unresolved events.

`remove` and `clear` without confirmation provide instructions and do not delete anything. Successful removal or clearing also invalidates any pending import, so a stale confirmation cannot restore a removed event. Normal commands refuse malformed saved state without changing it; `clear confirm` is the explicit destructive recovery option.

## Supported ICS subset

Input is one `VCALENDAR` with `VERSION:2.0` and 1–100 flat `VEVENT` components. Each event requires a nonempty `UID` and `DTSTART`. `SUMMARY`, `LOCATION`, `DTEND`, `TRANSP:OPAQUE|TRANSPARENT`, and `STATUS:CONFIRMED|TENTATIVE` are supported. Untitled events use “Untitled event.” Tentative events are busy unless transparent.

Supported time forms:

- `DTSTART:20261023T140000Z` uses explicit UTC.
- `DTSTART;TZID=America/Chicago:20261023T090000` uses the installed IANA timezone data; quoted TZID values are accepted too. Supported identifiers are `UTC` and validated slash-form IANA names such as `America/Chicago`, `Asia/Kathmandu`, or `Etc/UTC`; bare abbreviations such as `EST` are rejected.
- `DTSTART:20261023T090000` is floating input and is resolved once in the runtime-supplied timezone at import. Its saved instant does not move if your timezone preference changes.
- `DTSTART;VALUE=DATE:20261023` represents an all-day date, with no TZID. All-day dates remain date-based and are interpreted in the current viewing timezone.

`DTEND` is exclusive and must be strictly after `DTSTART`, with matching date/date-time types. Without `DTEND`, an all-day event lasts one day; a timed event is a point in time. These endpoint conventions and line unfolding follow [RFC 5545, sections 3.1 and 3.6.1](https://www.rfc-editor.org/rfc/rfc5545.html). CRLF and LF input, space/tab line continuations, and escaped text commas, semicolons, backslashes, and newlines are supported. Displayed titles and locations flatten embedded whitespace.

The importer deliberately rejects the entire paste for:

- Recurrence (`RRULE`, `RDATE`, `EXDATE`, `EXRULE`, `RECURRENCE-ID`); there is no recurrence expansion.
- `DURATION` (supply `DTEND`), `VTIMEZONE` definitions, `VALARM`, and other nested/non-event components.
- Custom/unknown/offset TZIDs, `X-WR-TIMEZONE`, numeric-offset DATE-TIME values, timezone parameters on all-day dates or UTC values, leap seconds, malformed/duplicate scheduling fields, or invalid dates.
- Nonexistent or ambiguous local times at timezone transitions. Use explicit UTC values to select an occurrence. If a queried local midnight is ambiguous or nonexistent, that date's availability is rejected rather than guessed.
- Cancellation events, non-Gregorian calendars, and `METHOD` values other than `PUBLISH`. Remove cancelled events explicitly. Invitation/request/cancellation processing is not implemented.
- Unknown event properties, including vendor-specific busy-time overrides. This strict policy avoids silently changing scheduling semantics.

`PRODID`, `X-WR-CALNAME`, and `X-WR-CALDESC` calendar metadata are accepted but not retained. Standard event metadata (`DTSTAMP`, `CREATED`, `LAST-MODIFIED`, `SEQUENCE`, `DESCRIPTION`, `ATTENDEE`, `ORGANIZER`, `URL`, `CLASS`, `CATEGORIES`, `COMMENT`, `CONTACT`, `GEO`, `PRIORITY`, `RESOURCES`, `RELATED-TO`, `ATTACH`) is ignored and never fetched or executed. Import order, not `SEQUENCE` or `LAST-MODIFIED`, controls explicit updates; review the preview before confirming an older export.

Many full calendar exports contain recurrence or embedded timezone definitions. Those exports need a source-generated non-recurring UTC/IANA subset to use this importer; unsupported components are not silently stripped.

## Bounds and retention

- At most 100 confirmed events plus one preview containing at most 100 events; no automatic eviction or deletion of old events.
- The complete feature command (including `import preview`) must fit 48,000 UTF-16 code units/JavaScript characters, matching the shared runtime. The UTF-8 input-byte limit below applies independently.
- At most 65,536 UTF-8 bytes, 2,000 physical lines, and 8,192 characters per unfolded line per import.
- UID: 512 characters; summary and location: 160 characters each. Overlong fields are rejected.
- Every write measures `Buffer.byteLength(JSON.stringify(state), "utf8")`, including the full record, JSON escaping, Unicode, revision, and pending-preview envelope. Imports allow at most **432,000 bytes** for the projected confirmed state and **464,000 bytes** for confirmed events plus preview. Every lifecycle write must remain strictly below **480,000 bytes**, below the shared store's 512,000-byte ceiling.
- The 32,000-byte difference between confirmed and preview admission budgets reserves space for a subsequent small edit/preview; the additional 16,000 bytes below the feature ceiling reserve lifecycle headroom. A large preview can still exceed quota: paste fewer events at a time. Admission checks both the staged state and projected confirmation atomically, so accepted previews can be confirmed and existing entries can still be edited individually, cancelled, removed, or cleared near quota. Changes that increase the confirmed data beyond its quota must be shortened or preceded by deletion.
- Calendar dates and resolved UTC event dates must be between 1970 and 2100. The day after a queried/all-day start date must also fit that range.
- Availability duration: 1–1,440 whole elapsed minutes. Normal replies fit under 28,000 characters; conflict lists are capped at 20 pairs and long displayed titles are abbreviated.
- Raw ICS and ignored metadata are not persisted. Confirmed data remains until removed/cleared. An expired preview cannot be confirmed; its bounded parsed data remains until replaced, cancelled, or cleared.

`list` and import previews show actual serialized storage usage. Quota failures leave both the saved events and the previous preview unchanged and explain how to free space: keep your original ICS, cancel a pending preview with `import cancel <preview-token>`, use `list` then `remove <event-id> confirm`, or delete all private calendar data with `clear confirm`. Smaller batches or shorter UID/summary/location text can also fit. Unicode and JSON escaping count toward the byte quota, so event and character counts alone do not establish available storage.

Keep your original ICS if you need an export/backup. There is no export command, live sync, recurrence support, working-hours preference, or external calendar write capability.

## Runtime and event-context contract

1. The registry and Home help expose `calendar`; the shared slash route delivers private replies and preserves multiline command text.
2. The runtime supplies the authenticated workspace/user/**calendar**-scoped JSON store, one request time and the caller's IANA timezone. Local key `calendar-v1` holds one bounded versioned record. Store transforms are atomic/retryable, and request deduplication is handled by the runtime. The feature has no raw Redis access.
3. The [owned-context service](context.md) invokes the exported adapter when a caller requests `event` context:

   ```ts
   import { readCalendarEventContext } from "./agent-features/calendar.js";

   const importedEvents = await readCalendarEventContext(
     calendarScopedStoreForAuthenticatedOwner,
     ownerTimezone,
   );
   ```

   The service selects the **same owner's calendar namespace**, exposes it through a read-only store, and merges the returned items into `services.readContext(["event"])`. Consumers must not pass their own morning-brief/day-planner namespace to this helper.

4. Each returned `AgentContextItem` has `kind: "event"`, stable ID `calendar:cal_<24-hex>`, original title, human-readable `text`, last actual import-change `updatedAt`, start instant `dueAt`, and `status: "busy" | "free"`. Its metadata has:

   | Field | Meaning |
   | --- | --- |
   | `source` | Literal `"calendar"`. |
   | `calendarEventId`, `uid` | Removal ID and original imported UID. |
   | `startAt`, `endAt` | ISO UTC strings for a half-open interval `[startAt, endAt)`. |
   | `allDay`, `busy` | Booleans; consumers must skip `busy === false` and zero-duration intervals for blocking. |
   | `timezone` | Source/resolution zone for timed events; supplied viewing zone for all-day events. |
   | `location` | Imported location, possibly empty. |
   | `startDate`, `endDate` | Present only for all-day events; ISO dates with exclusive end. |

   Pending previews are excluded. Up to 100 events are returned in chronological order; the caller filters its requested date/horizon. No context text or metadata should be treated as model instructions, executable commands, or proof of a live booking. Unlike date-scoped commands, the adapter must resolve the complete interval set and throws if any saved event endpoint is ambiguous/nonexistent in the viewing timezone. Do not catch and drop individual busy events to produce partial context. Adapter failures propagate: report calendar unavailable instead of claiming an empty calendar or guaranteed availability; `list` and confirmed removal remain available for recovery.

Registration, private delivery, source scoping and cancellation are implemented in the shared runtime. Calendar adds no dependencies or external accounts.

The feature uses **zero generation calls, zero searches, and zero owner-context service calls** per invocation. Local parsing and interval work are bounded by the input/event limits. The parent runtime supplies the 120-second deadline, prompt cancellation, and signal-guarded store writes. The feature checks cancellation before starting and propagates cancellation reasons instead of masking them as storage failures; it performs no background work or service retries. Replies remain within the runtime's 28,000-character limit. Shared runtime/store files are references only and are not copied into this feature branch.

## Targeted verification

The actual-runtime regression uses the integrated runtime/store with an in-memory CAS backend and fake services:

```sh
node --import tsx --test tests/agent-calendar.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

The regression covers UTC import followed by Havana fall-back/spring-forward and Apia skipped-date viewing, successful list/removal and unrelated/exclusive-end date queries, affected-date errors, strict complete context, unchanged persisted data, and ordinary 23/25-hour DST days.

Tests also use isolated JSON stores and fake services, including callback retries and a deletion/confirmation race. They cover import-to-confirm-to-delete flow, line folding/text decoding, timezone and all-day semantics, DST gaps/folds and unusual offsets, interval merging, input/state bounds, invalid-state recovery, storage failures, and adapter provenance. Unicode/JSON-escaping fixtures fill storage near quota, verify actual serialized byte usage and atomic rejection, and then exercise edit, confirmation, cancellation, removal, and clearing. Additional checks cover the shared command limit and abort propagation. No production services or live inference are exercised.
