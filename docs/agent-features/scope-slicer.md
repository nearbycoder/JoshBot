# Scope slicer

`/nobo-help agent scope-slicer` fits a coherent set of deliverables inside a minute budget while preserving mandatory prerequisites. It reports acceptance criteria and explicit cuts, without claiming work was completed.

Start with `/nobo-help agent scope-slicer create Guide v1 | 180`. Replace `SCOPE` with the returned full scope ID and `INSTALL`/`SHOTS` with returned item IDs:

```text
/nobo-help agent scope-slicer item SCOPE add Install guide | must | 90 | A clean install succeeds
/nobo-help agent scope-slicer item SCOPE add Screenshots | could | 60 | Three accurate screenshots
/nobo-help agent scope-slicer requires SCOPE SHOTS | INSTALL
/nobo-help agent scope-slicer slice SCOPE
/nobo-help agent scope-slicer what-if SCOPE | 100
```

The required install guide costs 90 minutes. Screenshots add 60, since their already-required prerequisite is counted once: 150 total within 180. At a hypothetical budget of 100, the guide remains included and screenshots are explicitly deferred, leaving ten minutes. At 70, mandatory scope is infeasible by 20; the report keeps the guide in the required core instead of quietly cutting it. What-if changes none of the saved values.

## Required closure and optional fit

Required roots are every `must` item plus items explicitly marked with `select`. Recursively include every prerequisite of each root. A visited set counts shared prerequisites once, including a `could` prerequisite of a `must` item. The full required core is always exposed, with its cost. If it exceeds budget, report infeasibility and do not add optional items.

When the core fits, consider remaining `should` items before `could`, preserving entered order within each priority. Compute the candidate's whole prerequisite closure, subtract already included items, and disclose the incremental cost. Include the complete additional closure only if it fits the remaining budget; otherwise retain the item as deferred with its reason. Items brought in as prerequisites have zero additional cost when subsequently considered themselves. This is a bounded deterministic heuristic, not a maximum-value/count optimizer or exponential search. It deliberately does not invent value scores.

The report shows every included item in prerequisite order, its classification, minutes and full acceptance criterion. Deferred items retain their acceptance criteria and reasons. An empty required core is explicitly identified: it is not proof that an empty delivery is useful. Selection means required inclusion, never completion or acceptance verification. No people, dates, scheduling, or external work are inferred.

## Commands

Append to `/nobo-help agent scope-slicer`:

```text
create TITLE | MINUTE-BUDGET
edit SCOPE | TITLE | MINUTE-BUDGET
item SCOPE add LABEL | must/should/could | MINUTES | ACCEPTANCE
item SCOPE edit ITEM | LABEL | must/should/could | MINUTES | ACCEPTANCE
item SCOPE remove ITEM confirm
requires SCOPE ITEM | PREREQUISITE
unrequire SCOPE ITEM | PREREQUISITE confirm
select SCOPE ITEM
unselect SCOPE ITEM confirm
slice SCOPE [page]
what-if SCOPE | MINUTE-BUDGET [page]
list [page]
show SCOPE [page]
export SCOPE
delete SCOPE confirm
help
```

`select` makes an optional item and its prerequisites required without changing its priority. `unselect` explicitly removes that override; a `must` or otherwise-required prerequisite remains required. Item edits retain prerequisite edges and the selection flag. Root edits preserve all item fields. `requires` adds one local edge; duplicates, missing/foreign IDs, self-cycles and longer cycles are rejected atomically. Cycle errors show the full path. `unrequire` explicitly removes an edge. An item still required by another cannot be removed until those edges are removed; deleting an unreferenced item also removes its own incoming prerequisites and selection. All destructive removals require `confirm`. Root deletion removes owned children; no hidden history is retained. `delete SCOPE` without confirmation returns the precise confirmation command.

Budget accepts 0–80,640 whole minutes; zero is useful for exposing mandatory infeasibility. Item effort is 1–10,080. Priority must be exactly `must`, `should`, or `could`. Title limit 160 UTF-8 bytes, label 400, acceptance 1,200. Required fields cannot be blank. Pipe fields are trimmed and separated with `|`; `\|` retains a literal pipe and `\\` a literal backslash. Unknown/trailing escapes, excess fields, malformed/nonfinite numbers, and invalid pages are refused. Adjacent whitespace counts toward parser bounds. The command ceiling is 16,000 UTF-8 bytes.

## State, quota and retrieval

Version 1 stores at most eight scopes, 24 deliverables and 60 edges per scope. Stable UUID-based IDs, revisions, creation/update timestamps, original priorities, acceptance text, prerequisites and selection flags are visible. The topological and visited-set closure operations are bounded by these counts; optional evaluation is at most one bounded graph traversal per item.

New content must fit 32,768 serialized UTF-8 bytes and the final feature cap is 49,152. Admission also constructs the maximum remaining lifecycle projection: all revisions have their maximum digit width and every selection uses `false`, the longer JSON boolean. Reports/what-if are unsaved, so there are no other mandatory expanding fields. All enveloped records must remain within the 24,576-byte export ceiling. This is an explicit lifecycle proof beyond the fixed 16,384-byte reserve. Byte limits can precede count limits. All accepted selection toggles fit their reserve. Quota refusal preserves old data; list/export/confirmed removal recover capacity. No automatic eviction or expiry occurs.

Current list pages have up to ten roots. `show SCOPE [page]` returns complete JSON detail; `slice`/`what-if` expose complete computed reports through their own repeatable page routes. Every page is at most 3,500 JavaScript units, retains intact IDs/commands, and shows the current revision. Restart at page 1 if it changes. Exact compact `export` includes the feature/version/record envelope within its 24,576-byte exception. Slash replies are plaintext, keeping URLs/mention syntax inert without double escaping. Readable older over-quota records remain inspectable/removable. Schema-invalid or unsupported data is preserved and cannot be reset by ordinary mutations; help remains available.

All data is entered explicitly into this feature's owner-scoped namespace. There are no model/search/context reads, private sibling access, external actions, caches or background work. Resource budgets are 0 generations/searches/context reads, 8 store reads and 4 store updates; ordinary commands use one read or update. IDs and timestamps are created outside pure synchronous store transforms; atomic retries preserve concurrent changes. The inherited runtime deadline/signal applies. A save already dispatched may have completed after interruption, so inspect before repeating it.

## Validation

Six tests in `tests/agent-scope-slicer.test.ts` use the actual runtime/scoped store and in-memory backend with throwing services. They cover the exact first example, full edit/select/remove workflow, transitive/shared mandatory closure, explicit mandatory overflow, optional incremental-cost ordering, atomic graph/input refusals, final maximum-capacity retrieval, and Unicode quota admission followed by every selection toggle. Wrong-type saved priorities are preserved without reset. These tests do not claim live Slack or deployment validation.

```sh
node --import tsx --test tests/agent-scope-slicer.test.ts
```
