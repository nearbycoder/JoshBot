# Deliberate practice lab

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Start `/nobo-help agent practice-lab create Explain a technical tradeoff in two minutes`. With the returned full DRILL ID, use the same prefix:

```text
rubric DRILL add Clarity | 5 | State the decision and one reason
attempt DRILL | I would use a queue because it separates request time from processing.
score DRILL ATTEMPT | DIMENSION | 3 | Reason is clear; tradeoff is missing
progress DRILL
next DRILL
```

Rubric and attempt commands return stable full IDs. Supply every dimension's user score and evidence. An attempt is completed only when all snapshot dimensions have scores for the current response revision. Missing scores are unknown. Progress compares first/latest completed attempts in saved order **only within the same rubric version**. Relative weakness is score/maxScore: 8/20 ranks below 3/5 even though its raw score is higher. Next practice uses the current declared rubric and the latest completed attempt on that version; without one, it starts with the first declared dimension. No automatic correctness judgment or invented grades.

## Management and retrieval

After the feature prefix:

```text
edit DRILL task | TEXT
clear DRILL task confirm
rubric DRILL edit DIMENSION | LABEL | MAX-SCORE | DESCRIPTION
rubric DRILL clear DIMENSION label|maxScore|description confirm
rubric DRILL remove DIMENSION confirm
attempt DRILL edit ATTEMPT | RESPONSE
attempt DRILL clear ATTEMPT response confirm
attempt DRILL remove ATTEMPT confirm
score DRILL ATTEMPT | DIMENSION | SCORE | EVIDENCE
unscore DRILL ATTEMPT DIMENSION confirm
reopen DRILL ATTEMPT confirm
feedback DRILL ATTEMPT
help
list [N]
show DRILL [page N] [rev R]
progress DRILL [page N] [rev R]
next DRILL [page N] [rev R]
export DRILL
delete DRILL [confirm]
```

Task/dimension edits create a new rubric version. Each of at most six attempts retains one frozen task/rubric snapshot; there is no unbounded version history. Historical attempts remain honestly comparable on their own version, explicitly unable to assess the changed task/rubric. Removing an attempt erases its historical copies; removing a current dimension leaves historical evidence intact and accessible. All accepted fields can be replaced/cleared or erased with their containing record.

Response edits and reopen increment the response revision; retained score evidence becomes stale until explicitly rescored. Score replaces one score/evidence pair; unscore erases it. Every mutation captures the intended drill revision before updating and checks it on **every CAS retry**, including scoring, edits and deletions. Unrelated drills can change safely. Show exposes every snapshot, field and ID; page continuations bind the drill revision. Export is one complete JSON envelope. Literal pipes use `\|`, backslashes `\\`; slash output is plain text.

## Optional feedback

Feedback explicitly sends the selected attempt's response and rubric snapshot to the configured text model once. Its unsaved formative opinions must use actual snapshot dimension IDs, exact complete rubric descriptions and exact nonempty response quotes. It cannot write user scores. Strict response validation rejects extra grade fields, fabricated IDs/quotes, duplicates, malformed/refusal output and oversized complete replies. No retries or repair calls. Edits/deletion while generation is pending discard stale output; cancellation propagates without later writes. Historical feedback is explicitly labeled.

Model input ≤16,000 UTF-8 bytes, instructions ≤4,000; accepted raw output ≤4,000 JS units and complete reply ≤3,500. These post-generation checks do not cap upstream tokens/spend. No clipped evidence or fake continuation. Deterministic commands work with providers unavailable.

## Bounds and validation

Strict version 1; at most 10 drills, six current dimensions, six retained attempts with at most six snapshot dimensions and six scores each. Task 160 UTF-8 bytes; label 80; description/evidence 160; response 1,200. Max score is integer 1–100; user score 0–dimension maximum. Unsupported fields, references, inconsistent same-version snapshots and malformed revisions reject without overwriting data.

State ≤49,152 bytes, new content ≤32,768, complete export envelope ≤24,576. Dynamic projection reserves every accepted attempt's maximum response and every remaining score/evidence slot, numeric revision growth and JSON escaping. The first slot reserves at least the current-rubric attempt size even if the retained first attempt is historical, so explicit removal cannot eliminate the first-attempt reservation. Additional attempts are content admissions with their own reserved scores. Bytes may bind before count caps. List/save shows actual and projected use; export then explicitly delete to free space. No eviction, TTL, workers or private global cache.

Generation budget 1, searches/context 0, logical state reads 8/updates 4. Normal commands read once and update at most once; feedback adds one current-state reread. Parent integrated shared corruption diagnosis `6725cde` after this checkout's baseline; no shared-file edits or workaround are included.

Node 24.22.1: eight real-runtime/store fake-backed tests cover catalog progress, unequal maxima, historical comparisons, stale scores, all edits/removals, stale/unrelated CAS retries, optional exact evidence/oversize/refusal/cancellation, maximum counts, dynamic lifecycle saturation and complete retrieval/export, corrupt snapshots and owner isolation. Run `node --import tsx --test --test-concurrency=1 tests/agent-practice-lab.test.ts`. No live provider, Slack, production performance or release certification is claimed.

Domain validation and quota failures return private actionable help text. Unknown backend errors expose no raw exception details and direct inspection before retry. Runtime cancellation still propagates.

Explicit removals remain available when only the root revision reaches its valid ceiling (9,007,199,254,740,991); that revision stays at the ceiling. Creation of children, edits and new lifecycle reports at that ceiling are refused. Every intended mutation is also bound to the complete record's content stamp, including every CAS retry. Unrelated records may change and retry safely. No stored fields, schema versions or budgets were added.

Copy the complete emitted continuation: `rev R` now carries `NUMBER:CONTENT_HASH`. A continuation requires the content hash even when a removal leaves the numeric revision unchanged. Start again with `show ID` if an old numeric-only continuation is rejected. Page 1 without a token remains available. Complete pages and exports retain their existing limits.

Pending optional generation compares the full record content before returning. A same-revision erasure discards the draft and cannot repeat removed evidence or save a late result.

The separate rubric, attempt and response evidence versions also have the finite safe-integer limit (9,007,199,254,740,991). This astronomical boundary is intentional: an operation needing a new semantic version is refused with a finite-history explanation before any save, even if it is a selective removal. Existing data is valid and unchanged; it does not need repair or retry. Versions are never reused and historical associations are never rewritten or erased to make the operation fit. Use `export ID` for the complete record, then `delete ID confirm` only if you intend to erase that entire root and its owned history. A new separate record can be created from data you explicitly re-enter. Unrelated roots remain intact. This is distinct from root-revision saturation: the supported removals still work at the root ceiling when the needed semantic versions have capacity.
