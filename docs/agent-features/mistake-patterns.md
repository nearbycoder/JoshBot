# Mistake pattern review

Implemented locally; **not yet registered or deployed**. Parent owns registration, independent review and release.

Start `/nobo-help agent mistake-patterns record 2026-10-22 | Review | Missed an edge case | testing`. Then use the same prefix with `rule add Before review, list three boundary cases | testing | 2026-10-23`. With the returned RULE ID, record `opportunity RULE | 2026-10-24 | success | Boundary list caught an empty input bug`, then `patterns testing` and `review RULE`. Enter observations when they occur; dates are user-entered civil labels, without timezone conversion or inferred event instants.

Review compares incidents before the start date (`<`) and after it (`>=`, including the start day). It reports recorded opportunity successes/failures and the failure fraction among those reports. An empty opportunity bucket has an **unknown denominator**. Incident records and opportunity reports are separate incomplete logs: dividing incident counts by opportunity counts would invent a sampled recurrence rate. Zero incidents alone never establishes improvement. Overlapping category rules are shown without assigning causality. Categories are user labels, not diagnoses.

## Commands after the feature prefix

```text
record YYYY-MM-DD | SITUATION | OBSERVABLE-ERROR | CATEGORY
rule add RULE-TEXT | CATEGORY | START-YYYY-MM-DD
opportunity RULE | YYYY-MM-DD | success|failure | EVIDENCE
patterns [CATEGORY] [page N] [snapshot HASH]
patterns [page N] [snapshot HASH] | CATEGORY
review RULE [page N] [rev R] [snapshot HASH]
link CASE | RULE
unlink CASE confirm
edit CASE date|situation|observableError|category | VALUE
edit RULE text|category|startDate | VALUE
clear CASE date|situation|observableError|category confirm
clear RULE text|category|startDate confirm
opportunity RULE edit OPPORTUNITY | YYYY-MM-DD | success|failure | EVIDENCE
opportunity RULE remove OPPORTUNITY confirm
list [N] [snapshot HASH]
show ID [page N] [rev R]
export ID
delete ID [confirm]
help
```

Cases may be explicitly linked to a same-category rule. Unlink before changing linked categories. Deleting a rule removes its owned opportunities and unlinks retained cases; deleting a case removes only that case. Clear dates become unknown, retained outside dated buckets. Clearing other fields preserves the record for correction. Remove an opportunity to erase its required date/outcome/evidence together.

Rule text/category/start changes increment its content revision. Existing opportunities remain visible but stale and excluded from current denominators. Editing an opportunity explicitly reasserts it against the current complete rule. Every mutation captures its target revision and checks it inside every CAS retry. Linking additionally checks the intended rule revision. Unrelated case changes survive retries. Root UUIDs and opportunity UUIDs are stable and fully exposed by show/export/review.

Plain slash text uses `\|` for literal pipes and `\\` for backslashes. List is current ID order, ten roots per page. Show pages expose all data and bind the root revision. Reviews also bind a digest of the full input state because changed cases affect a rule review. Copy the generated continuation; restart when changed. Patterns are labeled current summaries, not immutable reports. Complete export is one compact JSON envelope including owned opportunities.

## Limits and integration

Strict version 1, at most 60 cases, 12 rules and 60 opportunities total. Each accepted rule reserves one maximum first follow-up (including a count slot); additional opportunities are admitted as new content. Case links and safe-integer revision growth are projected too. The first opportunity stays projected at maximum size so removing it cannot consume the completion reservation. No eviction, TTL, snapshots, workers or services.

Situation: 180 UTF-8 bytes; observable error: 300; category: 80; rule: 240; opportunity evidence: 160. State: 49,152 bytes; new content: 32,768; complete root export envelope: 24,576. Bytes can bind before counts. List/save displays actual/projected use; export and explicit delete recover capacity. Inspection/deletion does not require new-content admission.

Zero model/search/context calls; metadata allows eight logical state reads and four updates per invocation. Normal commands read once and update at most once. Corrupt/unknown state preserves raw bytes; help is available and repair requires a maintainer. This checkout starts before the shared JSON-null read fix; parent has integrated `6725cde`, which distinguishes corrupt/null data from absence. No local workaround or shared edit is included.

Use the pipe form of `patterns` for literal category labels containing pagination words or escaped pipes/backslashes. Generated filtered continuations use that form and bind the full state snapshot.

Node 24.22.1: seven real-runtime/store fake-backed tests cover civil boundaries, denominator honesty, overlapping rules, all edits/removals, stale and unrelated CAS retries, maximum counts, dynamic first-follow-up reservation, complete pagination/export, changed list/pattern/review snapshots, strict persisted enums, invalid state/inputs and tenant isolation. Run `node --import tsx --test --test-concurrency=1 tests/agent-mistake-patterns.test.ts`. No live Slack/provider/production tests or release approval is claimed.

Domain validation and quota failures return private actionable help text. Unknown backend errors expose no raw exception details and direct inspection before retry. Runtime cancellation still propagates.

Explicit removals remain available when only the root revision reaches its valid ceiling (9,007,199,254,740,991); that revision stays at the ceiling. Creation of children, edits and new lifecycle reports at that ceiling are refused. Every intended mutation is also bound to the complete record's content stamp, including every CAS retry. Unrelated records may change and retry safely. No stored fields, schema versions or budgets were added.

Copy the complete emitted continuation: `rev R` now carries `NUMBER:CONTENT_HASH`. A continuation requires the content hash even when a removal leaves the numeric revision unchanged. Start again with `show ID` if an old numeric-only continuation is rejected. Page 1 without a token remains available. Complete pages and exports retain their existing limits.

Deleting a rule captures its linked-case set and each case content stamp. Concurrent new links or changed linked cases require a fresh explicit deletion. Unlinking retained cases at the root revision ceiling preserves their other fields and invalidates saved detail continuations.

The separate rule/evidence versions also have the finite safe-integer limit (9,007,199,254,740,991). This astronomical boundary is intentional: an operation needing a new semantic version is refused with a finite-history explanation before any save, even if it is a selective removal. Existing data is valid and unchanged; it does not need repair or retry. Versions are never reused and historical associations are never rewritten or erased to make the operation fit. Use `export ID` for the complete record, then `delete ID confirm` only if you intend to erase that entire root and its owned history. A new separate record can be created from data you explicitly re-enter. Unrelated roots remain intact. This is distinct from root-revision saturation: the supported removals still work at the root ceiling when the needed semantic versions have capacity.

Whole-rule deletion remains available even with an exhausted rule version and linked cases at their root revision ceilings; the cases are retained and unlinked without rewriting their evidence.
