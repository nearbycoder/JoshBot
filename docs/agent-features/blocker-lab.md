# Blocker lab

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Start with `/nobo-help agent blocker-lab open Draft keeps slipping | Need a repeatable explanation`. Use its returned full case ID. Every command below follows `/nobo-help agent blocker-lab`:

```text
observation CASE add I restarted the outline three times
hypothesis CASE add Audience is unclear
test CASE HYPOTHESIS | Ask reader to choose one audience | Reader selects one audience | 10
next CASE
result CASE TEST | supports | Reader selected beginners
```

Hypotheses and tests return child IDs. `next` chooses the lowest-cost unrun saved test, with stable ID ties. If none exists it offers a concrete setup command using a saved hypothesis or a command to create one. A supporting result never asserts causation or automatically closes the case. Outcomes are explicit `supports`, `refutes`, or `inconclusive` judgments with exact reported observations and request timestamps.

`review CASE` separates reported observations from guesses, counts each hypothesis's explicit outcome labels and flags unanswered links. `link CASE FROM | TO | evidence|dependency|decision | question` records an open causal question. Evidence links go from an observation to a hypothesis. Dependency and decision links connect hypotheses. `paths CASE HYPOTHESIS` traverses each of those two kinds independently with a visited set, marking cycles/convergence without repeating traversal. These are entered, unverified paths. Links count toward the same twenty-child cap as statements/tests.

Edit with `edit CASE title|problem text`, `observation CASE edit CHILD text`, `hypothesis CASE edit CHILD text`, `test-edit CASE TEST | HYPOTHESIS | action | expected | minutes`, or `link-edit CASE LINK | FROM | TO | kind | question`. Re-enter `result` to correct its label and observation. Completed test designs and tested hypotheses require explicit result removal before rewriting. `status CASE open|paused|closed` is user-controlled; paused/closed cases recommend no action. `remove CASE observation|hypothesis|test|link|result CHILD confirm` removes exactly that owned part. Remove referencing links/tests before their statements; dangling references are refused. No edit history is hidden.

`suggest CASE` makes one optional model call from the entered problem and observations, accepting up to five short unsaved conjectures/questions. No generated test or factual conclusion is stored. Failure leaves the deterministic workflow intact; a concurrent edit/delete discards late output. Input ≤16,000 UTF-8 bytes, instructions <4,000 bytes, output ≤4,000 units, each suggestion ≤480 bytes; post-response checks are not a provider token limit.

`list [page N]` lists ten current cases in creation-time/ID order. `show CASE [page N] [rev N]`, `review`, and `paths CASE HYPOTHESIS [page N] [rev N]` use complete ≤3,500-unit pages with revision-bound continuations. `export CASE` returns complete JSON ≤24,576 UTF-8 bytes including envelope. `delete CASE confirm` deletes the root and its children; bare delete offers its confirmation command.

Escape literal pipes as `\|` and backslashes as `\\`; unknown escapes fail. Titles allow 120 bytes, problem/statements/action/expected text 768, link questions 512, result observations 256; test cost is an integer 0–10,080 minutes. Twelve roots / twenty combined children per root are ceilings, subject to 32,768 new-content bytes and 49,152 total bytes. Admission projects outcomes with maximum observation escaping, timestamps, status and revision growth for all accepted tests. Results/status transitions use this reserve. No clipping, expiry or eviction occurs.

Private entered data and this feature's scoped store are the only sources. Metadata budgets: 1 generation, 0 searches, 0 context reads, 8 reads, 4 updates. Ordinary commands use one read and at most one update; optional assistance uses two reads/no writes. No sends, assignment, timers or external actions. Tests use the real runtime/store and fake providers, covering workflow, paths/cycles, edits, limits, full retrieval and stale output. Parent owns registration and production verification.
