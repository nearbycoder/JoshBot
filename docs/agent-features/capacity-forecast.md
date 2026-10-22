# Capacity forecast

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

`/nobo-help agent capacity-forecast` compares low/high effort assumptions with explicitly supplied weekly capacity. It does not assign people, read calendars, or claim probabilistic confidence.

Start with `/nobo-help agent capacity-forecast create November delivery | 2026-11-02 | 2`. Replace `FORECAST` with the returned full ID and `PACKAGE` with a returned work-package ID:

```text
/nobo-help agent capacity-forecast capacity FORECAST | 1 | 600
/nobo-help agent capacity-forecast capacity FORECAST | 2 | 600
/nobo-help agent capacity-forecast package FORECAST add Documentation | 500 | 900 | 1 | 2
/nobo-help agent capacity-forecast forecast FORECAST
/nobo-help agent capacity-forecast what-if FORECAST capacity | 2 | 300
```

Low effort allocates 500 minutes to week 1; high effort allocates 600 to week 1 and 300 to week 2. Reducing the second week to 300 still fits. Reducing it to 100 instead leaves 200 high-scenario minutes overflowing the finish window. What-if reports compare baseline and hypothetical overflow/unassessed totals first, followed by complete scenario details. They never save hypothetical inputs.

## Allocation and uncertainty

Each package has an inclusive earliest/latest allowed week and explicit low/high whole-minute estimates. Scenarios run independently. Sort packages by earliest week, retaining entered order for ties; allocate divisible effort into earliest known available minutes within the package's window. Never borrow a later week outside that window. Week rows expose load, capacity, overflow due, unassessed remainder due, and Monday–Sunday civil dates. Every package retains its allocation vector and finish-window outcome.

An unset capacity is **unknown**, neither zero nor free time. Allocation uses only known capacity and is labeled provisional when any week is unknown. Unknown week rows say “load unassessed.” If a package's remaining work has an unknown eligible week, classify it as unassessed instead of asserting overflow. If all its eligible capacities are known, classify remainder as known-window overflow. Allocation-vector zeros at unknown positions mean no allocation was made there; they do not assert zero capacity. Explicit capacity zero is a meaningful known constraint.

This is a deterministic, bounded greedy scenario analysis, not an optimal feasibility proof. For example, flexible work entered first can consume a week needed by a later tight-window package; the report honestly shows that heuristic's overflow. Low/high values are assumptions, not probability estimates or guarantees about actual effort. There are no package dependencies, indivisibility constraints, people assignments, or within-week scheduling.

## Commands

Append to `/nobo-help agent capacity-forecast`:

```text
create TITLE | MONDAY | WEEKS
edit FORECAST | TITLE | MONDAY | WEEKS
capacity FORECAST | WEEK | MINUTES
capacity-clear FORECAST WEEK confirm
package FORECAST add LABEL | LOW | HIGH | EARLIEST-WEEK | LATEST-WEEK
package FORECAST edit PACKAGE | LABEL | LOW | HIGH | EARLIEST-WEEK | LATEST-WEEK
package FORECAST remove PACKAGE confirm
forecast FORECAST [page]
what-if FORECAST capacity | WEEK | MINUTES [page]
list [page]
show FORECAST [page]
export FORECAST
delete FORECAST confirm
help
```

`edit` preserves capacities/packages by week number and initializes newly added weeks as unknown. Shortening is refused if a package extends beyond the new horizon or removed weeks have supplied capacities. Edit/remove packages and explicitly `capacity-clear` those weeks first. `capacity-clear` removes a supplied value, restoring unknown; it does not store zero. Confirmed package/root removals discard owned data without hidden history. `delete FORECAST` without confirmation prints the exact confirmation command.

Dates must be real `YYYY-MM-DD` Mondays. There are 2–8 weeks, indexed from one. Capacity is 0–10,080 whole minutes per week. Package low effort is 0–80,640; high is 1–80,640 and cannot be below low. Windows cannot reverse or exceed the horizon. Title limit is 160 UTF-8 bytes; package label 400. Pipe fields are trimmed and use `\|` for literal pipes and `\\` for literal backslashes. Unknown/trailing escapes, extra fields, nonfinite/exponent/decimal minute inputs, and invalid pages are refused. The complete command limit is 16,000 UTF-8 bytes. Adjacent whitespace counts toward parser field bounds.

## State, privacy and retrieval

Version 1 stores at most eight forecasts, eight weeks and 24 packages per forecast, using stable UUID-based IDs and visible revisions/timestamps. New content is capped at 32,768 serialized UTF-8 bytes; the feature ceiling is 49,152. No report or what-if output is retained. Admission projects every revision to its maximum; all other growth is new content, so this explicitly bounds the entire remaining mandatory lifecycle. Each exported envelope is also checked against 24,576 bytes. Counts can be limited by bytes first. Quota refusal preserves saved records; use list/export/confirmed delete for recovery. No eviction, expiry, or background cleanup occurs.

Lists use up to ten roots per current page. `show FORECAST [page]` exposes every retained field as complete JSON detail with stable IDs. `forecast` and `what-if` have their own deterministic page routes. Pages are at most 3,500 JavaScript units and show the current revision; restart at page 1 when it changes. Exact compact `export` includes feature/version/record and is bounded to 24,576 UTF-8 bytes. Plaintext slash replies retain inert URLs/mention syntax without double escaping. Readable older records over byte limits can be inspected and removed; schema-invalid data is preserved without reset and help stays available.

All sources are entered data in this feature namespace. There are no model, search, source-adapter, sibling-feature, network, or external action calls. Dates use shared civil arithmetic, independent of server timezone and DST; no civil label is exposed as a shifted midnight event. Metadata budgets are 0 generations/searches/context reads, 8 store reads, and 4 store updates. Commands use at most one logical read or update. Mutations validate inside pure synchronous owner-scoped atomic transforms, with IDs/time generated outside retries. The inherited abort signal governs work; an already-dispatched save may have completed, so inspect before retrying after interruption.

## Validation

The five actual-runtime/in-memory tests in `tests/agent-capacity-forecast.test.ts` cover the documented workflow, independent allocation math, unknown versus zero capacity, unmet finish windows, stable greedy-order limitations, all edits/removal, bad input, maximum eight-week/24-package retrieval, Unicode quotas and corrupt-state preservation. They use throwing model/search/context services and do not validate live Slack or deployment.

```sh
node --import tsx --test tests/agent-capacity-forecast.test.ts
```
