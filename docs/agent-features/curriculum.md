# Learning curriculum

Implemented locally; **not yet registered or deployed**. Parent owns lazy registration, independent review and release.

Start `/nobo-help agent curriculum create Learn SQL joins | 3 | 25`. With the returned full COURSE ID, add `unit COURSE add Inner joins | 2 | Correctly explain matching rows` and `unit COURSE add Left joins | 2 | Explain unmatched left rows`. Copy both returned unit IDs into `requires COURSE LEFT | INNER`. All commands use the `/nobo-help agent curriculum` prefix. `plan COURSE` allocates whole sessions; `demonstrate COURSE INNER | Explained a worked example correctly` records user evidence and unlocks the dependent unit. Allocation never demonstrates mastery.

## Study behavior

A bounded topological traversal rejects missing IDs, duplicate edges and cycles, visiting shared prerequisites once. The plan packs whole sessions into at most 12 weeks. Dependent allocations are explicitly conditional on future demonstrations; only currently ready units appear as the next eligible unit. A prerequisite not fully allocated prevents allocation of its dependents. Overflow reports known remaining sessions; unknown estimates remain additional unquantified work. Week numbers are relative study slots, not dates or scheduled events. Capacity is sessions/week × minutes/session, without splitting a session.

Missing label/readiness is **unknown**, missing prerequisite demonstration is **blocked**, and a current explicit report is **user-demonstrated**, never certification. Unit/readiness/estimate/prerequisite edits stale that unit's demonstration and all transitive dependents. Target changes stale every demonstration. Evidence remains accessible. Capacity edits do not change competence. Removing a unit removes incoming references and stales dependents. Reopening erases that unit's evidence and stales dependents. No elapsed-time auto-unlocking.

## Exact management commands

After the feature prefix:

```text
create TARGET | SESSIONS-PER-WEEK | MINUTES-PER-SESSION
unit COURSE add LABEL | ESTIMATE-SESSIONS | READINESS-TEST
unit COURSE edit UNIT | LABEL | ESTIMATE-SESSIONS | READINESS-TEST
unit COURSE clear UNIT label|estimateSessions|readinessTest confirm
unit COURSE remove UNIT confirm
requires COURSE UNIT | PREREQUISITE-ID[,PREREQUISITE-ID...]
requires COURSE UNIT clear confirm
demonstrate COURSE UNIT | EVIDENCE
evidence COURSE UNIT | YYYY-MM-DD | EVIDENCE
reopen COURSE UNIT confirm
edit COURSE target|sessionsPerWeek|sessionMinutes | VALUE
clear COURSE target|sessionsPerWeek|sessionMinutes confirm
plan COURSE [page N] [rev R]
show COURSE [page N] [rev R]
list [N]
export COURSE
delete COURSE [confirm]
help
```

`requires` replaces the prerequisite set. Demonstrate/evidence replace the explicit report; evidence also edits its civil date. Initial demonstration dates use the request's explicit timezone. Literal pipes use `\|`, backslashes `\\`. Full IDs are stable; show exposes every field. Continuations bind the record revision and reject edited pages. Export is complete JSON. Every update/delete/demonstration captures the intended course revision and validates it inside every CAS retry, while unrelated courses can change.

## Capacity and validation

Strict version 1 schema, 8 courses, 24 units and 60 edges/course; sessions/week 1–14, minutes/session 1–180, estimates 1–168. Target/label: 120 UTF-8 bytes; readiness and evidence: 240 each. Clear commands represent missing numeric settings as null and missing text as empty. Whole course deletion removes its units/evidence.

49,152 serialized state bytes; 32,768 content admission; 24,576 complete per-course export envelope. Dynamic projection reserves maximum JSON-escaped evidence, civil date, IDs and safe-integer revisions for every admitted unit. Filling all promised demonstrations remains possible even when content capacity is exhausted. Bytes may bind before counts. List/save reports actual and projected usage; export then delete to recover space. No auto-eviction, TTL, background work or snapshots.

Unknown versions, corrupt JSON, duplicate IDs, inconsistent demonstration references and cycles preserve stored bytes. Help remains available; repair requires a maintainer. The shared-store JSON-null read limitation is owned by a separate fix; attempted mutations still validate raw null and preserve it.

Zero model, search and context calls. Metadata limits 8 state reads/4 logical updates per invocation. Normal commands read once and update at most once. Bounds are small: 24 nodes/60 edges and at most 168 session slots per plan.

Node 24.22.1: six fake-backed tests through the real runtime/store cover catalog learning, shared prerequisites, cycle/horizon/unknown cases, complete edit/reopen/removal, stale and independent CAS retries, maximum-unit lifecycle saturation and lossless pages/export, corruption and owner isolation. Run `node --import tsx --test --test-concurrency=1 tests/agent-curriculum.test.ts`. These checks do not certify production performance or Slack delivery.
