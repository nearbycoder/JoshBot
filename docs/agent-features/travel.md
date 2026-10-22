# Travel itinerary assistant

`travel` keeps a private, coherent itinerary with transport, lodging, activities, constraints, and packing progress. Timeline ordering and transfer checks use actual instants across timezones. Everything works without generation, search, or owner-context services. The optional preparation brief is deterministic and cites saved entry/item IDs.

The registered entry point is `/nobo-help agent travel <command>`, with private replies. See the [expansion status](../personal-agent-expansion.md) for release readiness.

## A working trip

Create a trip with an explicit home timezone, a transfer buffer in minutes, and optional constraints:

```text
/nobo-help agent travel trip Japan visit | America/Chicago | 60 | Carry-on only; vegetarian meals
```

Copy the returned UUID wherever `<trip-id>` appears. The minimum defaults to 60 minutes if omitted; the allowed range is 0–1440 whole minutes. Constraints are user notes, not automatically enforced rules. Separate fields with `|`; literal pipes cannot appear inside fields. Optional fields should be omitted, not left empty.

```text
/nobo-help agent travel add-leg <trip-id> | Outbound flight | ORD | HND | 2026-11-02T10:00-06:00 | America/Chicago | 2026-11-03T14:00+09:00 | Asia/Tokyo | Check terminal in airline app
/nobo-help agent travel add-leg <trip-id> | Airport shuttle | HND | Tokyo | 2026-11-03T15:00+09:00 | Asia/Tokyo | 2026-11-03T16:00+09:00 | Asia/Tokyo
/nobo-help agent travel add-stay <trip-id> | Tokyo hotel | Tokyo | 2026-11-03T16:00+09:00 | Asia/Tokyo | 2026-11-06T11:00+09:00 | Confirmation email saved privately
/nobo-help agent travel add-activity <trip-id> | Museum | Tokyo | 2026-11-04T09:00+09:00 | Asia/Tokyo | 2026-11-04T10:00+09:00
/nobo-help agent travel timeline <trip-id>
/nobo-help agent travel check <trip-id>
```

This timeline shows the overnight flight before the shuttle and hotel even if records were entered in another order. The flight's elapsed duration is 780 minutes. The date/zone changes are informational notices. The 60-minute HND connection meets the saved minimum. Staying in a hotel while visiting a museum is normal, so it is not reported as an overlap conflict.

Confirmation notes are optional, unverified reminders. Store non-secret notes such as “confirmation email saved privately.” Do not paste passwords, door/access codes, passport/payment information, or sensitive booking references. Obvious labeled credentials (such as `password: …`, `PNR=…`, or bearer tokens) are rejected. The feature does not identify or redact every possible secret; input remains the user's responsibility.

## Commands

The following omit the common `/nobo-help agent travel` prefix:

```text
help
trip
show
trip <title> | <IANA home zone> [| <minimum transfer minutes> | <constraints>]
trip constraints <trip-id> | <minimum transfer minutes> | <constraints or ->
trip remove-entry <trip-id> | <entry-id>
trip delete <trip-id> confirm

add-leg <trip-id> | <title> | <from> | <to> | <departure> | <departure IANA zone> | <arrival> | <arrival IANA zone> [| <confirmation note>]
add-stay <trip-id> | <title> | <location> | <check-in> | <IANA zone> | <check-out> [| <confirmation note>]
add-activity <trip-id> | <title> | <location> | <start> | <IANA zone> | <end> [| <confirmation note>]

timeline <trip-id> [page]
entry <trip-id> <entry-id>
check <trip-id>
show <trip-id>
show <trip-id> brief

packing <trip-id>
packing <trip-id> add | <item> | <item> ...
packing <trip-id> done <packing-id>
packing <trip-id> undo <packing-id>
packing <trip-id> remove <packing-id>

archive <trip-id>
archive <trip-id> undo
```

`trip` and bare `show` list active and archived trips. `show <trip-id>` includes the trip overview, full constraints, packing counts, and a compact chronological index of **every saved entry ID**, with UTC start times and shortened title previews. Use full UUIDs from the output. To correct a dated entry, remove it and add a replacement. New records receive new IDs; existing IDs remain stable. The trip title, home timezone, and individual packing labels are fixed after creation; remove/recreate the relevant record if necessary. Titles beginning with `constraints `, `remove-entry `, or `delete ` are reserved by the `trip` subcommands.

`timeline <trip-id>` defaults to page 1. Each page shows up to **five complete entries**, including full titles, locations, endpoint dates/timezones, elapsed durations, and confirmation notes. The header gives the page count; navigation provides exact previous/next commands. For example, a 40-entry trip has pages 1–8:

```text
show <trip-id>
timeline <trip-id> 8
entry <trip-id> <entry-id-from-the-index>
packing <trip-id>
```

`entry <trip-id> <entry-id>` retrieves one complete entry and its note directly, including for archived trips. The compact index, each full timeline page, and individual entry views fit below 28,000 characters even with maximum-length text and Slack escaping. No saved entry details depend on a truncated summary. Page numbers start at 1; invalid/unavailable pages or unknown entry IDs return guidance without changing data. Pages are recalculated in actual chronological order on each read, so adding/removing entries can change page positions and counts; use stable entry IDs when revisiting a particular record. `packing <trip-id>` retrieves the full packing list separately.

For example:

```text
packing <trip-id> add | Charger | Rain jacket
packing <trip-id> done <charger-packing-id>
show <trip-id> brief
trip constraints <trip-id> | 90 | Avoid stairs; carry-on only
check <trip-id>
```

The brief shows the next or ongoing saved entry relative to the supplied current time, remaining packing items, missing confirmation-note counts, constraints, and the same deterministic checks. After increasing the minimum to 90 minutes, the 60-minute HND transfer is flagged. Use `-` to clear constraint text. Packing addition is atomic: duplicate items or an invalid field reject the entire addition.

## Date semantics and check limits

- Every date must include `Z` or a numeric UTC offset and a named IANA timezone. Use local dates in 2000–2100, minute precision or optional whole seconds. Fixed-offset timezone names and abbreviations such as `CST` are rejected; `UTC` is accepted. Entries store canonical UTC ISO timestamps plus IANA zones.
- The entered wall time and offset must round-trip through that zone. Invalid dates, DST gaps, and offset mismatches are rejected before writing. For New York's repeated hour, `2026-11-01T01:30-04:00` and `2026-11-01T01:30-05:00` mean two different instants one hour apart. An end must be later in actual time, even if local clocks go backward across DST or the date line.
- Timeline rows show each endpoint's local time, offset, and timezone, plus actual elapsed minutes. The start is also displayed in the runtime-supplied user timezone. No server-local timezone is used. The trip home timezone is retained as an explicit planning reference; it never silently replaces endpoint zones.
- All pairs of transport/activity entries are checked for overlap. Touching endpoints are allowed. Overlapping stays receive a separate lodging warning. Hotel intervals represent occupancy windows, not continuous required attendance, so they do not conflict with activities or transport inside them. Check-in/out travel and physical attendance are not inferred.
- Consecutive transport/activity entries are compared for transfer gaps. The user minimum applies if either entry is transport or the location label changes. Zero minutes between different labels is flagged as an impossible recorded transfer. A different location with a longer gap still gets a missing-connection notice; no distance, route duration, terminal change, or airline minimum is invented.
- Use consistent location labels. Comparison ignores case and repeated spaces; it does not know that `HND` and `Haneda Airport` refer to the same place. Check results are based only on entered dates and labels, not live schedules or booking verification. Free-text constraints are displayed for manual review.
- Date-boundary and timezone notices explain valid changes as well as potential mistakes. They are not necessarily conflicts. Actionable conflict/transfer notices appear before informational clock/date notices. At most 50 notices are displayed per check; the output reports the remaining count.
- No bookings, provider contact, outbound messages, account changes, live pricing, weather, visa advice, or financial advice. The preparation brief is a deterministic summary, not model-generated travel research.

## Retention and integration

State is bounded to 10 trips total, including archived trips, with 40 dated entries and 40 packing items per trip. Titles/locations/packing labels allow 100 characters, confirmation notes 300, and constraints 800. Commands allow 8,000 characters. Replies are capped below 28,000 characters after Slack escaping. Long check/preparation summaries may explicitly indicate truncation; all saved IDs and details remain available through the compact `show` index, paginated `timeline`, individual `entry`, and separate `packing` views. No records are silently evicted.

The shared `itineraries` value also has a **470,000-byte UTF-8 budget**, measured from serialized JSON on every atomic update. Unicode and JSON escaping count at their actual encoded size, so this budget can be reached before the record-count limits. The budget reserves one byte per `true` packing/archive flag for its possible change to `false`; accepted records can still be marked packed/unpacked and archived/reopened at capacity. This keeps new state below the 480,000-byte feature safety threshold and the runtime's 512,000-byte hard limit. Content growth, including longer constraint notes, must fit the budget.

Bare `trip` or `show` displays current budget usage. Quota rejection leaves the entire command unapplied and explains how to free space: `trip remove-entry <trip-id> | <entry-id>`, `packing <trip-id> remove <packing-id>`, or `trip delete <trip-id> confirm`. Clearing constraints with `trip constraints <trip-id> | <minimum> | -` also frees space. Archiving retains data and does not free quota. Valid older records above this feature budget remain readable; lifecycle changes and progressive reductions are permitted, but further growth is rejected until they fit.

`archive` keeps a read-only trip and all of its entries; `archive <id> undo` reopens it. `trip delete <id> confirm` permanently removes the trip, entries, and packing list from this feature's state. There is no background expiration, automatic export, or cross-feature retention behavior. Invalid persisted shapes are refused without overwriting them; runtime maintainers must repair such records.

Runtime contract:

1. Shared routing and Home help expose `travel` under `/nobo-help agent travel` and keep responses private.
2. The runtime supplies owner/workspace/feature-scoped storage with atomic compare-and-swap updates. The sole local key is `itineraries`; its JSON schema version is `1`. Updates validate existing state, use synchronous pure transforms, and create IDs/timestamps outside transforms. A concurrent archive/deletion wins when a mutation retries against it.
3. The runtime supplies one request time and the caller's IANA timezone, checks identity/access and suppresses duplicate request delivery. The feature additionally rejects duplicate itinerary additions.
4. Replies are delivered as private text, with user text escaped for Slack control syntax. Travel uses no generation, search, owner-context reads, background jobs, external accounts or API access.

Each invocation makes zero generation calls and zero searches, within the shared limits of eight generations and six bounded searches. Work is bounded by the trip/entry limits and uses the runtime's 120-second deadline, prompt cancellation, and late-write guards; it starts no background work. The feature needs no changes to the shared runtime/store.

Verification uses only fake stores/services:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-travel.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```
