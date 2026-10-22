# Checklist quality check

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

This feature audits entered procedure design; it never executes steps, records completion, reads toolbox checklists or passes release gates. Zero model, search, context and live calls.

Start with `create Publish a guide | Applies to the public documentation site`. Use its returned REVIEW ID:

```
step REVIEW add Check the page | none | Stop if links fail
step REVIEW add Open each example link | Every link resolves to the expected page | none
requires REVIEW FIRST | SECOND
audit REVIEW
move REVIEW SECOND | 1
audit REVIEW
```

Use the full returned STEP IDs as FIRST/SECOND. The initial audit identifies `Check` at action UTF-16 span `[0,5)`, missing verification, and the second step appearing after its dependent. Moving SECOND to position 1 repairs the order. Edit the first action and verification to repair the other findings.

Rules are deliberately finite. The English vague-word list is check, review, ensure, handle, manage, validate, matched case-insensitively as whole ASCII words anywhere in action. Duplicate detection uses NFC normalization, lowercase, trimmed/collapsed whitespace and exact equality. It does not infer semantic equivalence. Each textual finding names its immutable step ID, field, exact zero-based UTF-16 span and correction guidance. Prerequisite findings identify the exact referenced ID and order position. Cycles are allowed as auditable input and detected with bounded reachability; reordering cannot solve them. Unknown/dangling references are rejected in commands and persisted-state validation. No findings is not a safety/readiness certification.

Maintain every accepted field with `edit REVIEW | title | TEXT`, `edit REVIEW | applicability | TEXT`, or `step REVIEW edit STEP | action|verification|stopCondition | TEXT` (choose one field). `none` is reserved for absent verification/stop condition. Confirmed `clear REVIEW FIELD confirm` and `step REVIEW clear STEP FIELD confirm` erase those text fields. `requires-remove REVIEW STEP PREREQUISITE confirm` erases a relationship. `step REVIEW remove STEP confirm` erases the step and every incident reference. `move REVIEW STEP | POSITION` edits the complete order (1-based).

`list [PAGE]`, `show REVIEW [PAGE]`, and `export REVIEW` retrieve all retained fields; `delete REVIEW confirm` erases a whole root and its children. Copy emitted continuation commands unchanged: they include revision plus full-content hash. Reports are deterministic recomputations; no hidden assessment history is stored. Static metadata help contains the full parser grammar. Pipe-delimited text trims outer whitespace and supports `\|` and `\\` escapes.

Limits: 12 reviews, 30 steps and 60 references/review; title 160, applicability 1,000, each step field 500 UTF-8 bytes. Commands are at most 16,000 UTF-8 bytes; normal pages at most 3,500 JavaScript units. State/content/export including JSON envelope: 49,152/32,768/24,576 serialized bytes. Bytes can bind before counts. Admission reserves maximal revision growth; lint adds no saved output. No eviction or reset.

Mutations capture the exact full target before retryable CAS. Same-record edits/child changes/deletion reject stale work; unrelated-root changes retry safely. All non-erasure writes refuse at revision 999,999,999, while retrieval and erasure remain. There is no collection/assessment counter or recycled ID. Whole-root deletion alone can incrementally recover a fully valid, individually exportable legacy aggregate over byte quota; other erasures retain normal quota/projection gates. Malformed state is preserved byte-for-byte. Unexpected backend errors are sanitized and ambiguous saves direct inspection before retry.

Verification: Node 24, 1 GiB heap, `node --import tsx --test --test-concurrency=1 tests/agent-checklist-lint.test.ts`. Nine focused tests cover the worked example, exact spans/normalization, cycle and order oracle, max steps/references, full emitted retrieval, edits/cleanup, strict legacy recovery, invalid schema preservation, tenant isolation, real CAS conflicts, cancellation and diagnostic privacy. Typecheck also passes locally. These are fake-backend application checks, not live Redis, Slack or performance evidence.
