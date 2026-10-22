# Decision outcome journal

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Start with `/nobo-help agent decision-journal record Use a short signup form | Reduce friction | 2026-11-20`. Use the returned full decision ID; these commands follow `/nobo-help agent decision-journal`:

```text
expect DECISION | completion rate | 60 | percent
lock DECISION
outcome DECISION | completion rate | 48 | percent | 2026-11-20
review DECISION
lesson DECISION | Test the audience before changing the form
```

Review preserves the original rationale and expectation, shows the dated user-reported outcome, and computes actual minus predicted: **−12 percentage points** in this example. Percent and `%` labels produce percentage-point differences, not relative percent changes. All other units remain literal. Outcome metric and unit must exactly match a locked expectation; there is no implicit unit conversion. Missing outcomes are explicit. Lessons and outcome capture timestamps remain separate from original reasoning.

Before lock, use `edit DECISION choice|rationale|reviewDate text`, `expect-edit DECISION EXPECTATION | metric | value | unit`, or `remove DECISION expectation EXPECTATION confirm`. Metrics must be unique. Lock requires at least one expectation and freezes all original fields and expectations. There is no unlock or overwrite of locked originals: record a separate decision for a changed prediction.

Re-enter `outcome` to correct its value/date; one current outcome per expectation retains its ID. `lesson-edit DECISION LESSON | text` edits a reflection; `remove DECISION outcome|lesson CHILD confirm` removes one. These explicit changes are not an audit history; the frozen original is the hindsight protection. Numbers range from −1,000,000 to 1,000,000 with at most three decimal places. Civil dates are validated Gregorian labels and stay unchanged; request timestamps use the injected clock.

`list [page N]` lists ten current decisions sorted by creation time/ID. `due [page N]` includes all decisions whose review date is on/before the request's local civil day, sorted by review date/ID and showing outcome coverage. It neither schedules work nor writes channel decisions. `show DECISION [page N] [rev N]` and `review` expose full original and later information through ≤3,500-unit pages. Continuations carry revisions and refuse changed records. `export DECISION` returns exact complete JSON ≤24,576 bytes including envelope. `delete DECISION confirm` deletes all its expectations, outcomes and lessons; bare delete shows the confirmation.

Literal pipes/backslashes require `\|` / `\\`. Choice labels are 120 UTF-8 bytes, rationale/lessons 768, metric labels 96, units 48. There are twenty roots, eight expectations/outcomes and five lessons each, subject to 32,768 new-content bytes / 49,152 total bytes. Every admission projects one maximum numeric outcome with ID, date, timestamp, lock and revision growth per expectation. Lock and outcome completion use reserved capacity; later lessons are optional content. No clipping or silent eviction occurs.

The feature is deterministic, using only entered data and its workspace/user-scoped store. Metadata budgets are 0 generations/searches/context reads, 8 store reads, 4 updates; ordinary commands use one read and at most one update. CAS conflicts invalidate stale edits, including edits racing with lock. Tests cover the exact workflow, hindsight/unit refusals, civil dates, full capacity/retrieval and reserved completion with real runtime/store fixtures. No live service, registration or deployment verification is claimed.
