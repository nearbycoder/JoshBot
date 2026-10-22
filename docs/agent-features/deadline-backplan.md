# Deadline backplan

`/nobo-help agent deadline-backplan` computes latest starts through a bounded prerequisite graph, explicit working weekdays, excluded dates, and buffers. It reads no calendar or holiday service and performs no scheduling or external work.

Start with `/nobo-help agent deadline-backplan create Conference proposal | 2026-12-04 | mon,tue,wed,thu,fri`. Substitute the returned full plan ID for `PLAN` and milestone IDs for `ABSTRACT`/`REVIEW`:

```text
/nobo-help agent deadline-backplan milestone PLAN add Write abstract | 2 | 0
/nobo-help agent deadline-backplan milestone PLAN add Review draft | 1 | 1
/nobo-help agent deadline-backplan depends PLAN REVIEW | ABSTRACT
/nobo-help agent deadline-backplan exclude PLAN | 2026-11-26
/nobo-help agent deadline-backplan backplan PLAN
```

With these inputs, abstract work occupies December 1–2; review work occupies December 3, followed by its December 4 buffer. The explicit November 26 exclusion is retained even though it does not constrain this short critical path. Excluding December 2 instead moves the abstract to November 30–December 1. Dates remain civil labels.

## Exact date and graph semantics

Work duration counts inclusive working-day slots: a one-day milestone starts and finishes on the same working date. Its buffer occupies the next separate working slots after its work. The milestone's “ready after buffer” date is its effective end. A prerequisite's effective end must be **strictly before** every dependent's work start. A buffer of zero ends with the work; public holidays have no effect unless explicitly excluded.

The requested deadline is inclusive. If it is nonworking, use the previous permitted working day. The analysis horizon contains the 366 civil dates ending at the requested finish, including both endpoints; all weekday/exclusion traversal is bounded to this window. Creating/editing a deadline also requires it within 366 civil days either side of the invocation's local today. Stored historical plans remain inspectable as time advances.

A topological sort detects missing prerequisites and cycles. The backward pass visits dependents before predecessors. A shared predecessor takes the earliest end required by any dependent, so it cannot silently finish too late for one branch. If required work/buffers would extend before the horizon, the report says infeasible within the bounded horizon and refuses to present a partial schedule as feasible. Reducing effort, changing explicit rules/edges, or choosing another finish date can make it analysable.

A forward pass starts at today's first eligible working slot within the same window. Slack is latest start minus this prerequisite-constrained earliest start in working slots. A latest start before local today is an explicit deadline risk; dates are never silently shifted to hide it. If today precedes the bounded window, earliest starts are clamped to the window. Empty plans have unknown feasibility. “Feasible” means only under supplied dependency/working-day assumptions: unrelated work may overlap, and people/capacity are not modeled.

## Commands

Append to `/nobo-help agent deadline-backplan`:

```text
create TITLE | FINISH-DATE | WEEKDAYS
edit PLAN | TITLE | FINISH-DATE | WEEKDAYS
milestone PLAN add LABEL | WORK-DAYS | BUFFER-DAYS
milestone PLAN edit MILESTONE | LABEL | WORK-DAYS | BUFFER-DAYS
milestone PLAN remove MILESTONE confirm
depends PLAN MILESTONE | PREREQUISITE
undepend PLAN MILESTONE | PREREQUISITE confirm
exclude PLAN | DATE
include PLAN | DATE confirm
backplan PLAN [page]
list [page]
show PLAN [page]
export PLAN
delete PLAN confirm
help
```

`depends` adds one edge; duplicate edges are refused. Cycles, including self-dependencies, return their full ID path and leave the previous plan byte-for-byte intact. IDs must refer to milestones in this plan. `undepend` explicitly removes an edge. Removing a milestone required elsewhere is refused until those dependency edges are removed; deleting an unreferenced milestone also removes its own incoming prerequisites. All destructive removals require `confirm`. `include` removes an explicit exclusion; weekday rules still apply. Root edits preserve milestones and excluded dates. `delete PLAN` without confirmation returns the full confirmation command.

Dates must be real `YYYY-MM-DD` labels. Weekday codes are a nonempty, distinct comma-separated selection of `sun,mon,tue,wed,thu,fri,sat` (case-insensitive on input, canonical order on save). Work days are whole integers 1–366; buffer days 0–365. Larger total paths may be valid entered plans but infeasible within the analysis horizon. Title limit 160 UTF-8 bytes; milestone label 400. Fields use `|`, with `\|` for literal pipes and `\\` for literal backslashes. Unknown/trailing escapes and extra fields are rejected. Input is trimmed; adjacent whitespace counts toward parser bounds. Full command ceiling: 16,000 UTF-8 bytes.

## Storage, complete retrieval and privacy

Version 1 stores at most eight plans, 20 milestones, 60 prerequisite edges and 30 explicit excluded dates per plan. There is no hidden history. Original values, stable UUID IDs, graph edges, revisions and creation/update times are retained. Dates outside the analysis window can remain as explicit exclusions and are shown; they simply have no effect on that report.

New content is capped at 32,768 serialized UTF-8 bytes, total state at 49,152, and each export including its feature/version envelope at 24,576. Admission also projects all revisions to their maximum; reports are unsaved and there are no other mandatory expanding lifecycle fields. This proves remaining lifecycle space instead of relying only on the 16,384-byte margin. Byte limits may be reached before counts. Failed writes preserve previous state. List/export/confirmed delete recover capacity; readable older data above byte limits can still be inspected/removed. Full schema validation prevents mutations of malformed or unsupported state and never resets it; static help remains usable.

Lists have up to ten roots per current page. `show PLAN [page]` exposes all retained fields as complete JSON detail; `backplan PLAN [page]` exposes every dated milestone and assumption. Both page types stay at or below 3,500 JavaScript units, preserve IDs/commands, and identify the current revision. Restart page 1 after a revision changes. `export` returns exact compact JSON within its bounded exception. Slash responses are plaintext and do not double escape inert mention/link labels.

Dates use shared civil arithmetic and the injected `now`/IANA timezone, not server-local date conversion. Loops are bounded to 366 dates, 20 nodes and 60 edges. There are no model/search/context calls, sibling namespace reads, timers, caches, or external actions. Resource budgets: 0 generations/searches/context reads, 8 store reads and 4 store updates; ordinary commands need one read or update. The actual scoped store supplies owner isolation and atomic retries. IDs/time are generated outside pure synchronous transforms. Cancellation inherits the runtime deadline; an already-dispatched write may have completed, so inspect before retrying.

## Validation

Seven in-memory actual-runtime tests cover the exact first example, complete edit/removal, shared-prerequisite latest starts and slack, cycle-path/missing-dependency atomic refusal including a competing CAS retry, owner isolation, leap days/DST/local-today risk, bounded infeasibility, all maximum node/edge/date counts, final-page retrieval, Unicode quotas and corrupt-state preservation. No live model/Slack/production service or deployment was used.

```sh
node --import tsx --test tests/agent-deadline-backplan.test.ts
```
