# Learning transfer

Implemented in this isolated batch; **not yet registered or deployed**. Parent integration owns lazy registration, independent review and release.

Turn supplied learning into a specific application and compare a predeclared prediction with your own observations. Nothing changes learning cards, goals or external accounts. Provenance labels and excerpts are user supplied, not verified documents.

Start with `/nobo-help agent learning-transfer create Use smaller PRs | Workshop notes | Keep each change focused on one purpose`. Copy the full returned application ID into these commands (prefix each with `/nobo-help agent learning-transfer`):

```text
apply APPLICATION | Next bug fix | Split the refactor from the behavior fix
predict APPLICATION | Reviewer can assess each PR in one sitting
observe APPLICATION | Reviewer completed both reviews without clarification
reflect APPLICATION | Keep the split; include a short dependency note
review APPLICATION
```

A lesson stays **planned** until a complete plan has a current observation. A user report makes it **tried**; a reflection bound to that plan and observation revision makes it **reviewed**. These are workflow states, not proof of success. Review shows the prediction, actual reports, gaps and adjustment. Observation dates are civil labels, initially derived from the invocation clock in its explicit timezone.

## Inspect and correct

`help` includes every parser form. `list [N]` lists current applications in ID order, ten per page. `show APPLICATION [page N] [rev R]` exposes every retained field and full observation ID. `review` supports the same pagination. Follow the exact revision-bound continuation; restart if edited. `export APPLICATION` returns one complete compact JSON envelope, never a clipped preview.

- `edit APPLICATION lesson|sourceLabel|sourceExcerpt|opportunity|action|prediction | TEXT` replaces the selected field. `apply` replaces opportunity/action; `predict` replaces prediction.
- `clear APPLICATION lesson|sourceLabel|sourceExcerpt|opportunity|action|prediction|reflection confirm` erases a field.
- `observation APPLICATION edit OBSERVATION | YYYY-MM-DD | TEXT` changes its date/text and explicitly reasserts that report against the current complete plan.
- `observation APPLICATION remove OBSERVATION confirm` erases one report.
- `reflect APPLICATION | TEXT` replaces the adjustment after a current observation.
- `delete APPLICATION confirm` removes the whole application and its owned evidence. Without `confirm`, deletion only explains its scope.

Literal pipes use `\|`; literal backslashes use `\\`. Slash output is plain text. Source/lesson/action/prediction changes increment the plan revision: earlier observations and reflection remain accessible but stale. Observation changes increment an observation revision and stale the reflection. Every edit/removal/evidence assertion captures the intended application revision before the update and checks it on every CAS retry; unrelated applications can change safely.

## Bounds and state

Schema version 1; UUIDs are stable full IDs. Strict validation rejects extra fields, duplicate IDs, bad civil dates, invalid revisions and malformed state without resetting it. There is no migration, eviction, expiry, background work or retained revision snapshot history. Help remains available if state needs maintainer repair. The known shared-store limitation at this parent revision is that a stored JSON `null` is indistinguishable from absence on a read; a mutation validates the raw null and preserves its bytes. The parent owns that shared fix.

At most 20 applications and five observations per application. Lesson and source label: 120 UTF-8 bytes each; source excerpt: 600 JS units and 1,800 bytes; opportunity: 180 bytes; action: 300; prediction, report and adjustment: 240 each. Boundaries reject rather than clip. State is at most 49,152 serialized UTF-8 bytes; content admission is 32,768; each complete export envelope is at most 24,576. Bytes may bind before counts.

Every admitted application projects all five maximum-size observations, maximum plan fields/reflection, dates, full IDs, JSON escaping and safe-integer revision growth. Later lifecycle updates use that reservation. New lesson/provenance content must pass admission again. List/save reports both actual and projected bytes. Export then explicitly delete an application to recover space; a full state never prevents deletion.

Zero generations, searches and context reads. Per-invocation logical store budgets: 8 reads, 4 updates (normal commands use one initial read and at most one update). Work is bounded by 20 applications × five observations. No service/provider initialization is required for the deterministic core.

## Local evidence

Node 24.22.1, real runtime/scoped store with in-memory exact CAS and throwing services: `node --import tsx --test --test-concurrency=1 tests/agent-learning-transfer.test.ts`. Six tests cover the complete workflow, all edit/removal paths, stale assessment and safe unrelated CAS retries, corruption preservation, exact fields/date/tenant boundaries, and lifecycle saturation/full pagination/export. Fake-backed checks do not establish live Slack delivery or production performance.
