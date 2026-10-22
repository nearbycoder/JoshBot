# Number audit

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Locally implemented and tested with the real scoped memory-store/runtime fixture. No live calls, installs, model, search, context access or external changes.

Create an audit with `create Launch metrics`. Copy its full returned AUDIT ID into:

```
check AUDIT add percent-change | 20,12 | -40 | 0.01 | percent
check AUDIT add sum | 15,25,10 | 55 | 0 | minutes
run AUDIT
correct AUDIT CHECK | 50
run AUDIT
```

The first run shows exact −40 percent and a mismatch of 50 minutes against 55. Use the sum's returned CHECK ID to correct the claim. Run then recomputes both passing checks; no result history or certification is retained.

`check AUDIT edit CHECK | OPERATION | OPERANDS | CLAIM | TOLERANCE | UNIT` replaces the check's complete explicit inputs while keeping its ID. `check AUDIT remove CHECK confirm` erases all of them. `edit AUDIT | title | TEXT` and `clear AUDIT title confirm` maintain the title. Required numerical inputs can be removed by removing their check. `list [PAGE]`, `show AUDIT [PAGE]`, `export AUDIT`, and `delete AUDIT confirm` cover retrieval and whole-audit deletion. Copy emitted continuations unchanged: revision and full-content hash reject stale pages. All retained fields, IDs and units are present in complete JSON export.

Supported operations are sum, percent-change and weighted-average. Comma-separated operands have syntax `value[@unit]`; weighted operands use `value[@unit]:weight`, e.g. `10:1,20:3` with claim 17.5. Weights must pair with values, be nonnegative, and have positive total. Common units apply to unannotated values (percent-change uses `base`); explicit mixed units are rejected, not converted. Percent output must be `percent`. Percent-change divides `(after − before) × 100` by the signed before value, including negative bases; a zero baseline is undefined. This is arithmetic over user-entered data, not external verification.

Numbers are plain signed decimals, maximum six fractional places and absolute magnitude 1,000,000,000. Exponents, negative zero, unsafe magnitudes and expressions are rejected. BigInt fixed-point inputs and rational intermediates avoid floating-point comparisons. Tolerance uses the exact rational. Displays retain a reduced exact fraction; nonterminating values also show a 12-place approximation rounded half away from zero. Tiny nonzero values are never displayed as zero.

Limits: 12 audits, 20 checks/audit, 20 operands/check; title 160 UTF-8 bytes and unit 40 ASCII characters. Commands are at most 16,000 UTF-8 bytes. State/content limits are 49,152/32,768 serialized UTF-8 bytes; each complete export including envelope is at most 24,576. Count and byte limits both apply. Admission reserves maximal revision growth; run does not add stored results. Replies are paginated at 3,500 JavaScript units. Pipes/backslashes in pipe fields use `\|` / `\\`; outer field whitespace is trimmed.

Every write binds the entire intended record before entering a retryable CAS transform. Unrelated concurrent changes can retry; same-record edits/erasure reject stale intent. No random IDs or clocks are generated inside transforms. Record revisions stop at 999,999,999: all non-erasure writes refuse, while inspect/export and confirmed erasure remain available. No collection or assessment counter exists; UUIDs are never recycled. An exhausted record does not block writes to another. Erasures never restore prior content. There is no reset or eviction. Fully valid, individually exportable legacy aggregates over the feature byte quota can be reduced with confirmed whole-root deletion; retained records remain identical. Other writes keep quota and lifecycle checks. Malformed state is preserved exactly.

Verification: `node --max-old-space-size=1024 --import tsx --test --test-concurrency=1 tests/agent-number-audit.test.ts` (Node 24). Tests exercise the worked example, rational boundaries, tiny values, edits/removal, limits, complete emitted-page retrieval, legacy aggregate recovery, schema preservation, isolation, real CAS contention, cancellation and sanitized backend errors. These checks make no performance, live Redis, Slack delivery or deployment claim. Static help is the authoritative complete parser grammar in the metadata module.
