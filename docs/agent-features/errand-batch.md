# Errand windows

Local, unregistered and not deployed. `errand-batch` belongs to **Organize life** and checks entered estimates on demand. It does not use maps, opening-hours lookup, directions, booking, notification, generation, search or context.

The catalog workflow creates `/nobo-help agent errand-batch create Saturday errands | 2026-10-24 | 09:00 | 120 | home`, then adds Library (15 minutes, 09:00–12:00) and Repair shop (20 minutes, 10:00–11:00). Enter `travel ID | home | SHOP | 20`, `travel ID | SHOP | LIBRARY | 15`, and `travel ID | LIBRARY | home | 10`, substituting returned stop IDs. `plan ID` gives shop arrival **09:20**, **40-minute wait** until 10:00, finish **10:20**, library **10:35–10:50**, and home **11:00**: exactly **120 minutes**, including all waiting, travel, service and return.

Commands after `/nobo-help agent errand-batch`:

```text
create TITLE | YYYY-MM-DD | DEPARTURE | AVAILABLE_MINUTES | HOME_LABEL
stop ID add NAME | SERVICE_MINUTES | OPEN-CLOSE
stop ID edit STOP | NAME | SERVICE_MINUTES | OPEN-CLOSE
stop ID remove STOP confirm
stop ID clear STOP name/window/serviceMinutes confirm
travel ID | FROM | TO | MINUTES
untravel ID | FROM | TO | confirm
plan ID [PAGE [rev TOKEN]]
edit ID | FIELD | VALUE
clear ID FIELD confirm
list [PAGE]
show ID [PAGE [rev TOKEN]]
export ID
delete ID [confirm]
help
```

Root fields: `title`, `date`, `departure`, `availableMinutes`, `startLabel`; edit additionally accepts explicit IANA `timezone`. Clearing a required field makes the plan incomplete. All stop fields are replaceable and clearable; removing a stop explicitly removes its incident travel legs. Directed leg identity is its exact `(from,to)` pair, visible in show/export; setting travel updates that pair, while `untravel` removes it. `home` is the reserved endpoint; other endpoints are complete stop IDs. No reverse leg is inferred.

Greedy order is earliest closing instant, then entered order. For each stop, the algorithm adds travel, waits for opening, and adds service. If it cannot finish before closing and within the outing budget, it reports the stop as infeasible and keeps the prior location/time for subsequent candidates. Missing legs/windows/service durations remain unknown and unscheduled. Final return is always checked: missing return leaves total/feasibility unconfirmed; late return displays the overrun. This bounded heuristic does not claim an optimal route, directions or verified hours.

Times use `HH:mm` or `HH:mmZ`/`HH:mm±HH:mm`, including each endpoint of `OPEN-CLOSE`. For example the fold-day window `01:30-05:00-02:30-06:00` has explicit endpoint offsets. The existing pure `day-planner/time.ts` resolver is reused without importing the day-planner feature. Caller timezone is saved explicitly; date/time/offset round-trips must match it. Ambiguous local times require offsets; nonexistent times and mismatching offsets reject. Dates are 1900–2200, the shared resolver's range. There is no overnight window/outing, no 24:00 shortcut, and the 1–720-minute elapsed budget must end on the same civil day. Durations remain absolute elapsed minutes across DST; display includes timezone offsets. Service/travel are 0–720 integer minutes. Labels ≤160 UTF-8 bytes; timezone ≤100. Literal pipes/backslashes use `\|`/`\\`.

Schema 1: ten outings, twelve stops, up to 156 directed legs per outing (13 locations × 12 destinations). New content ≤32,768 serialized UTF-8 bytes; state ≤49,152; complete export envelope ≤24,576. Counts and bytes both apply. Plans are unsaved, so lifecycle reservation is actual maximum revision width, without speculative output buffers. Explicit removal works at the revision ceiling and after content saturation. No retained plan history/cache exists.

Show JSON pages reconstruct the exact export, including all 156 legs. Plan/detail continuations bind revision and content fingerprint, so removal at a saturated revision invalidates old pages. Full-state validation preserves malformed raw data; intended-record snapshots reject conflicting edits/removals during actual CAS retries and permit unrelated-record retries. All output is private under the existing scoped runtime.

Verification: nine tests via `node --import tsx --test --test-concurrency=1 tests/agent-errand-batch.test.ts` on Node 24 cover the exact 120-minute catalog example, unknown/infeasible return, fold/gap/offset/day boundaries, complete field/child lifecycle, maximum matrix reconstruction, revision-ceiling removal, saturated content, actual CAS deletion races, corrupt shapes/raw preservation, isolation and metadata/help parity. Generation/search/context budgets 0/0/0; logical reads/updates 8/4. No live integration or release approval is implied.
