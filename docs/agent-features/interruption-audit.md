# Interruption audit

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Records user-entered civil dates, categories, interrupted tasks, disruption/recovery minutes and measured/estimated basis. `3 + 8` and `5 + 4` report **20 known minutes**. Unknown components contribute no invented minutes and have separate counts; zero is known. Complete-entry total medians exclude incomplete entries; recovery medians use known recovery values. Reports break down categories, dates and measurement basis. Chosen prevention rules are suggestions supplied by the user, with no causal claims or Slack inference.

Start with `/nobo-help agent interruption-audit log 2026-10-22 | chat | Writing guide | 3 | 8 | estimated`, then `review 2026-10-19 | 2026-10-25`. Prefix every command with `/nobo-help agent interruption-audit`. Replace IDs with returned full IDs.

- `log DATE | CATEGORY | TASK | DISRUPTION | RECOVERY | measured/estimated`; minutes are integers 0–1440 or `unknown`.
- `rule CATEGORY | ADVICE`; `edit RULE_ID | CATEGORY | ADVICE`.
- `edit LOG_ID | DATE | CATEGORY | TASK | DISRUPTION | RECOVERY | measured/estimated` replaces every log field.
- `measure LOG_ID | DISRUPTION | RECOVERY | measured/estimated` fills or replaces measurements using reserved lifecycle capacity.
- `review START | END` saves/replaces one inclusive review range. `edit RANGE_ID | START | END` changes it; `report RANGE_ID` renders it against current saved entries.
- `clear ID date/category/task/disruption/recovery/basis/advice confirm` removes the named applicable field. Undated logs are excluded and counted; cleared basis becomes unknown. Delete the range to remove its required dates.
- `list [page N]`; `show ID [page N rev R stamp HASH]`; `export ID`; `delete ID confirm`. All three record types appear in list. Copy emitted continuations exactly.

Literal pipes/backslashes use `\|` / `\\`. Accepted fields are recoverable in lossless plain-text JSON detail pages or complete export. Root lists show ten records per page in ID order and may recompute. Report pages bind the entire contributing state, not just the saved range. Detail pages bind the individual record. Both carry revision plus SHA-256 content stamps, so confirmed erasure at a saturated revision also invalidates old continuations.

Version 1 strict state rejects unknown fields, enums/types, duplicate IDs, invalid dates and unsupported versions without resetting data. Each mutation captures intended content before entering the retryable CAS transform, then checks every attempt; unrelated changes retry. There are no source reads, model/search calls, timers, eviction or hidden history. State is private to the signed workspace/user and feature.

Limits: 80 logs, 12 rules, one range; category 80, task 240, advice 400 UTF-8 bytes; commands 16000 bytes; ordinary replies 3500 JS units; complete per-record exports 24576 bytes. State admission is 32768 bytes and the hard cap is 49152. Admission also reserves the single review configuration and projects every record's maximum revision and measurement fields, including serialization overhead. Lifecycle measurement updates and confirmed removal remain available after admission fills. Byte limits may precede count limits. Use list/show/export before explicit deletion to free space. All service budgets are zero except eight logical state reads and four updates per invocation.

Local verification: `node --import tsx --test --test-concurrency=1 tests/agent-interruption-audit.test.ts` covers arithmetic, schema preservation, real CAS contention, revision ceiling, Unicode/escaped retrieval and complete continuations, scope isolation, and saturation followed by measurement completion/removal. Fake backing storage uses the actual runtime and scoped store. It does not establish live Slack, Redis or deployment behavior.

Revisions have a finite maximum of 9007199254740991. At that value, a record accepts only explicit erasure; an exhausted collection revision blocks all non-removal writes, including creation. One exhausted record does not block edits to other records when the collection has revision room. Known exhaustion rejects before source work and is checked again on every CAS retry. Inspection, saved reports and export remain available. Export before explicit field/child removal or `delete ID confirm`; those commands retain exact intended-record guards and may saturate revisions. This is a permanent finite limit, not a transient retry or corrupt-state error; deletion does not reset the collection revision.

Confirmed `delete ID confirm` also recovers a schema-valid legacy collection above 49152 bytes, within the shared store's 512000-byte readable ceiling. It validates the entire old and new state, binds the exact intended record on every CAS attempt, strictly reduces serialized bytes and cannot grow surviving lifecycle reservations. Surviving records and source snapshots are unchanged; repeated deletion can reach empty. Malformed data stays untouched. This exception applies only to deleting a whole record: create/edit, field or child removal and lifecycle admission checks retain their existing limits. No automatic reset, eviction or truncation occurs.
