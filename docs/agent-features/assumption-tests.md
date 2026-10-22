# Assumption tests

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Start with:

```text
/nobo-help agent assumption-tests create Shorter form increases responses | response count | at-least | 5 | 1 | 60
```

The declared statistic is the **arithmetic mean of the entered observation values**, with each observation equally weighted. A sample minimum counts entered observations, not people inside an aggregate count. This definition is fixed before lock and stated in help. Using the returned full experiment ID, continue after `/nobo-help agent assumption-tests`:

```text
method EXPERIMENT | Show the form to ten volunteers and count completions
lock EXPERIMENT
observe EXPERIMENT | 2026-10-23 | 6 | 40 | Six completed
evaluate EXPERIMENT
revise EXPERIMENT | Follow-up with a different audience
```

The example meets its predeclared mean threshold with n=1 and 40/60 minutes. An undersized sample remains insufficient. `at-most` supports upper-bound criteria; inclusive comparisons use integer thousandths and cross multiplication, avoiding decimal sum boundary errors. Effort is summed independently; exceeding the cap remains explicit even when the criterion is met. These self-reported measurements do not establish scientific proof, independence or causation. Observation dates are user-entered civil labels; capture/evaluation timestamps use the injected clock.

`lock` requires a procedure. Observations and evaluation require lock. `revise` adds a separate draft with the prior criterion/method and a reason, retaining the old design, observations and evaluated result. `edit EXPERIMENT belief|metric|direction|threshold|sampleMinimum|effortCapMinutes|revisionReason value` changes the current draft. Any such edit after lock, including `method`, creates a separate draft rather than changing the original. Lock the new draft before observations. Earlier versions are immutable and completely exported; at most three versions are retained. When observation slots are exhausted, create a separate experiment.

`observe-edit EXPERIMENT | OBSERVATION | date | value | effort | note` corrects a current-version observation. `remove EXPERIMENT observation|note OBSERVATION confirm` removes that current-version data and invalidates its evaluation. `remove EXPERIMENT method|revisionReason confirm` clears optional draft fields (a procedure is still required to lock). A literal `-` note means no note. Re-evaluate after observation changes. Numeric values range ±1,000,000 with three decimals; effort is nonnegative and the cap positive. The minimum is 1–20 observations; total observations across all versions are capped at twenty.

`list [page N]` lists ten current roots in creation-time/ID order. `show EXPERIMENT [page N] [rev N]` exposes every retained version, original field, observation and result through complete ≤3,500-unit pages. Continuations carry the root revision and reject stale pages. `export EXPERIMENT` returns complete JSON ≤24,576 UTF-8 bytes including envelope. `delete EXPERIMENT confirm` removes all versions and observations; bare delete offers its confirmation command.

Literal pipes and backslashes use `\|` and `\\`, with unknown escapes rejected. Belief labels allow 120 bytes, metric 96, procedure 768, revision reason/note 256. Twelve roots / three designs / twenty total observations are count ceilings; bytes can fill first. New content must fit 32,768 bytes; total state 49,152. Admission reserves a missing bounded procedure, enough numeric/no-note observations to satisfy the active sample minimum, lock, maximum evaluation and revision growth. Optional observation notes and extra observations beyond the minimum are new content. Numeric minimum-sample completion remains possible at capacity; no clipping or eviction is used.

Private entered data and this feature's scoped store are the only sources. Metadata budgets: 0 generations/searches/context reads, 8 reads and 4 updates. Ordinary commands use one read and at most one synchronous CAS update; IDs/time are computed outside retries. No inference, external action, schedule or background work exists. Tests cover the exact workflow, version locks, insufficient/exceeded results, exact decimal boundaries, malformed state, full retrieval, reserved completion and stale CAS changes through the actual runtime/store. Parent owns registration and production rollout.
