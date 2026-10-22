# Project premortem

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Start with `/nobo-help agent premortem create Launch workshop | Attendees complete the exercise`. Use its returned full plan ID:

```text
risk PLAN add Setup consumes session | 3 | 4
trigger PLAN RISK | Two pilot users need more than ten minutes
mitigate PLAN RISK | Send setup sheet | Me
review PLAN
residual PLAN RISK | 2 | 3 | Pilot completed
```

These commands follow `/nobo-help agent premortem`. `risk` returns the risk ID. Review ranks original likelihood × impact descending, with stable ID ties, showing ordinal priority 12 for 3 × 4. This heuristic is not a probability. Missing triggers and mitigations stay visible even for low scores. Residual assessments retain original ratings and show the score difference, reason and request timestamp. All input is user-reported; owner labels do not assign work and status labels do not verify safety.

Use `edit PLAN title|outcome text`, `risk PLAN edit RISK failure | likelihood | impact`, or re-enter `trigger`, `mitigate`, `residual` to correct those fields. Original risk edits require explicitly removing an existing residual assessment first. `status PLAN RISK open|mitigating|monitoring|closed` changes the private label. `remove PLAN RISK risk|trigger|mitigation|residual confirm` removes exactly that owned part (mitigation includes its owner label). There is no hidden edit history.

`suggest PLAN` makes at most one model call for up to five hypothetical failure modes. These are unsaved conjectures; add selected risks and ratings manually. Failures preserve the saved plan. Concurrent edits/deletion invalidate late output. Input is ≤16,000 UTF-8 bytes, instructions <4,000 bytes, output ≤4,000 units, each suggestion ≤480 bytes. These post-response checks do not set an upstream provider token ceiling. No web search, source reads, schedules, sending or external actions occur.

`list [page N]` lists ten current plans, sorted by creation time and ID. `show PLAN [page N] [rev N]` exposes every retained field; `review` uses the same page/revision syntax. Exact continuation commands carry a revision and reject a changed record. `export PLAN` returns complete JSON ≤24,576 bytes including the envelope. `delete PLAN confirm` deletes its owned risks too; bare delete shows the confirmation command.

Pipe escapes are `\|` and `\\`, with other escapes rejected. Title/owner labels allow 120 bytes; failure, objective, trigger and mitigation 768; residual reasons 256. Twelve plans and twenty risks each are count ceilings; bytes can fill first. New content must fit 32,768 bytes, total state 49,152. Every admission projects all risks' maximum residual reasons, dates, ratings, statuses and revision growth. Residual/status completion uses the reserved capacity. Larger optional control text consumes content, with no clipping or eviction.

Metadata budgets: 1 generation, 0 searches, 0 context reads, 8 store reads, 4 logical updates. Most commands use one read/one update; suggestions use two reads and no writes. Tests cover the catalog workflow, controls, edits, full capacity/retrieval, Unicode completion and stale assistance with the real runtime/store. They do not verify registration, Slack delivery, live providers or deployment.
