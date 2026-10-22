# Additional fifty agents: acceptance checklist

Implementation/review checklist, 2026-10-22. This is a specification, not a record that unimplemented features passed. Audit baseline: `7a30db374bf3df702af5e28413468a04dc571862` (deployed PR #58). Pair with the [UX contract](personal-agent-50-ux.md), [feature status](feature-status.md), and [owned-source contract](agent-features/context.md). Parent integration owns final execution and release evidence.

## Evidence rules and efficient test allocation

Use Node 24, fake storage/providers, a fixed request clock, and the real production entrypoints/adapters. No live inference, Slack posts, production data writes, deployment, or new credentials are required for acceptance. Do not multiply expensive shared tests by seventy or optimize for a test-count headline.

| Layer | Run here | Do not repeat in every feature |
| --- | --- | --- |
| Shared runtime/store/startup | Admission, deadlines, budgets, receipt dedupe, tenant isolation, CAS, abort, byte ceiling, lazy imports. | Seventy copies of the same runtime cancellation/Redis tests. |
| Shared Slack integration | Signed/private routing, ack order, no public fallback/memory recording, metadata catalog search/pagination/Home state. | Network-shaped Slack fixtures for every CRUD operation. |
| Source adapters | Real toolbox/calendar/memory/legacy shapes, ownership, completeness bounds, canonical dates, source failures. | Invented normalized `readContext` objects as the only proof that production sources work. |
| Each new feature | Distinct useful workflow, exact examples, its state schema/lifecycle, meaningful sources/fingerprints, per-command cost. | Tests that merely assert its title, echo implementation constants, or stub its own command parser. |
| Representative integration | Each newly used source path plus a consumer; all fifty minimal deterministic create/read or stateless scenarios through real routing. | Re-running every expensive edge case through all fifty modules. |

Build one shared fixture with a JSON-string `Map` implementing `AgentStateBackend.get/compareSet`, including controlled CAS contention and call counters. Wrap it with **real** `createAgentFeatureStore`, `createAgentFeatureServices`, `readAgentOwnedContext`, and `createProductionContextAdapters` where relevant. Inject fake Redis/access dependencies at the documented seams; do not replace the adapter under test. Pure feature algorithm tests may use `createAgentTestContext`, but its simple in-memory store does not establish CAS, quotas, or isolation.

Use deferred promises and injected/accelerated timers to reach cancellation/race states; never wait 120 seconds per test. Limit concurrent test workers (for example `--test-concurrency=2`) and run targeted checks during a five-feature batch. Run the full suite/typecheck/build once on the integrated revision, then repeat only for substantive changes or failures. An existing local Redis fixture may validate Lua once centrally; an in-memory adapter test must not be described as proof of live Redis behavior.

## Release gates

- [ ] **Exactly 50 additions**, ten batches of five, 70 unique registered personal-agent IDs. A catalog row records each addition's distinct input → operation → output and how it differs from the existing twenty agents, twenty toolbox tools, and core Slack features. Navigation/runtime work is excluded from the count.
- [ ] Each new agent owns only `<id>.ts`, `<id>.metadata.ts`, `tests/agent-<id>.test.ts`, and its guide unless the parent explicitly assigns more. Registry/Home/shared edits are integrated centrally.
- [ ] Every addition delivers a useful deterministic behavior with saved lifecycle or a complete stateless result. A prompt wrapper, renamed existing tool, or help-only registration is not accepted.
- [ ] Metadata satisfies the agreed `AgentFeatureMetadata` contract: id/title/description/help, group/keywords/example, optional lower-only `resourceBudgets`. Use one of the seven canonical labels in the UX spec. The implementation spreads the same metadata; help cannot drift into a second copy.
- [ ] The exact budget fields are `generations`, `searches`, `contextReads`, `storeReads`, `storeUpdates`. Values are nonnegative integers, bounded respectively by **8/6/8/64/32**; omitted values retain defaults. All new agents declare conservative explicit budgets, including zeros for unused services. CAS retry count is not a logical `storeUpdates` count.
- [ ] No new credentials/services, recurring timers, autonomous Slack delivery, calendar/account writes, direct provider SDK use, shell/tool execution, or bypass to arbitrary sibling storage.
- [ ] Evidence names the tested commit, environment, commands, pass/fail/skip counts, and material limitations. Historical PR #58's 1,093 tests do not certify later edits. No “deployed” claim without the parent's actual rollout evidence.

## Shared discovery and Slack checks

- [ ] Import registry/help in an instrumented cold process: zero feature implementation loads, provider/source initialization, timers, or private storage access. Executing one selected feature loads only that implementation and legitimate dependencies; repeated help does not execute it. A failed lazy import produces a private recoverable error, without poisoning future independent requests.
- [ ] All 70 IDs are reachable exactly once by walking catalog pages. Walk each group and multi-page search, including last/empty/invalid pages. IDs/examples never truncate; count/range/navigation remain correct after filtering. Case/space normalization and tied search rankings are deterministic.
- [ ] Verify normal reply/help/list target ≤3,500 units after escaping; native section ≤2,500 target and <3,000 absolute; catalog modal ≤20 blocks and ≤10 rows. Check maximum-length metadata and Unicode. A helper that silently takes twelve chunks is not complete pagination.
- [ ] Catalog and feature help require no feature Redis/backend/preference/source/model/search startup. Existing access policy is still enforced. Document this distinction instead of asserting that the entire Home/slash request has no I/O.
- [ ] Home controls only discover/display metadata. Tampered group/page/ID is rejected/reset; no Home action invents a signed channel or starts a personal workflow. Search is explicit submit, not provider-backed type-ahead.
- [ ] Home paging/filter/back updates one modal, preserves query/group/page, and respects view hashes. Closed views, missing triggers, and stale updates fail privately with an existing slash-command recovery path; no DM/channel fallback.
- [ ] Actual Bolt handler acknowledges before slow policy/startup/services. Fake unresolved dependencies prove ack is not delayed. Verify all success/error/busy/duplicate/cancel paths retain private response scope, inert user/model text, and no `task`/media/public message action.
- [ ] User text such as `<@UOTHER>`, `<!channel>`, `<https://example.test|label>`, ampersands, backticks, code fences, and Unicode cannot introduce active mentions or malformed blocks. Test for both under-escaping and double-escaping at the actual renderer, not just a string helper.
- [ ] Private command input/output is absent from channel conversation memory, shared artifacts, response-card payloads, global caches, and public fallbacks. Errors/logs/receipts do not expose private input, raw provider exceptions, or tokens.
- [ ] Help examples parse and run against actual modules. Copy every returned next command into the real dispatcher with its generated ID/token. An advertised `show`, `export`, `edit`, or `cancel` must exist; placeholders must not masquerade as saved objects.

## Privacy, storage, and state integrity

- [ ] Same item ID/key under another team, user, or feature is inaccessible. Missing/foreign IDs share a nonrevealing response. Identity and current channel derive from signed invocation fields, never command text, metadata, a cursor, or modal state.
- [ ] Invalid/blank identity, invalid feature/key IDs, unauthorized policy, and unknown route reject before source/provider work. Direct execution helpers cannot create an unscoped store.
- [ ] A redelivered trigger executes at most once. Duplicate receipt states, concurrent delivery, failure after mutation, and receipt-finalization failure never replay the mutation. Receipts contain only allowed hash/status metadata with 24-hour expiry, no private request/reply. Started/finished receipts are not proof that a result succeeded.
- [ ] Corrupt JSON, oversized JSON, unsupported schema version, null/wrong types, duplicate record IDs, invalid timestamps, nonfinite numbers, and inconsistent status/output combinations do not reset or overwrite prior state. Raw values are preserved; help remains available.
- [ ] Every stateful feature enforces record/history/key counts plus a UTF-8 serialized-byte quota. Test exact boundary and one byte over with CJK, astral emoji, combining marks, quotes/backslashes, and allowed control-character escaping. Invalid controls/lone surrogates are either explicitly rejected or handled consistently.
- [ ] Admission reserves worst-case bytes for all promised remaining previews/checkpoints/status/revision fields. Fill a representative Unicode record close to admission quota, then complete its lifecycle, cancel/confirm it, and delete it without exceeding the shared 512,000-byte ceiling. A create that fits while its mandatory confirmation cannot fit is a failure.
- [ ] A rejected create/edit/refresh leaves the previous record byte-for-byte intact. Quota recovery names a real list/delete route. Runtime-readable over-quota legacy records remain inspectable/deletable; no automatic eviction or unconditional reset.
- [ ] CAS transforms are synchronous and repeatable: no model/search/I/O/random-ID/time generation inside them. Force a retry and assert one logical provider operation, stable generated IDs, and preservation of unrelated concurrent edits. Check maximum 32 CAS attempts centrally.
- [ ] Validate full persisted schema before any mutation, including destructive paths. If corrupted state needs a special recovery command, its scope and confirmation are separately documented/tested; it is not silently used during ordinary operations.

## Stale work, cancellation, and honest status

Shared harness verifies abort/deadline at policy, backend initialization, preferences, lazy/services import, receipt acquisition, source read, model/search wait, and state-read boundaries. Once the caller is aborted, late resolve **and** late reject must be consumed without starting the next stage, generation, or new storage write. The original 120-second deadline covers all phases; later phases do not get a fresh allowance.

- [ ] Abort before the CAS is dispatched leaves state unchanged. Separately simulate CAS already in flight when abort occurs: document its uncertain outcome and ensure no second save or late success reply occurs. Do not assert rollback of a write already sent to Redis.
- [ ] The real scoped store prevents a late feature catch/finally block from writing a result or “interrupted” cleanup after abort. Persisted active leases remain inspectable/recoverable on a fresh invocation, without automatic regeneration.
- [ ] Begin a generated refresh, then edit the same record before resolving the model: the edit wins and stale output is discarded. Repeat with delete and cancel where supported; no resurrection. Repeat one conflict inside a retried CAS transform, not only before the first update.
- [ ] Two concurrent confirmations/resumes/retries cannot both advance one revision or checkpoint. The older preview/attempt token fails after replacement, expiry, cancellation, or source-changing edit.
- [ ] Where confirmation claims current sources, change a source after preview without changing the local record: confirmation rereads its declared kinds, compares the source fingerprint, and requires a fresh preview. Historical snapshot-only acceptance is labeled as such and does not claim live validation.
- [ ] Failed optional generation preserves saved input and last good output. Retry/resume uses saved IDs/checkpoints and does not require the user to retype the original material. No background retry or unbounded retry queue.
- [ ] Cancellation copy states only confirmed saves/checkpoints and does not promise to stop upstream billing. Timeout or unconfirmed commit tells the user to inspect before repeating a mutation.
- [ ] Admission rejects over-limit work before costly startup and receipt creation. Provisionally verify eight global/two workspace-user active invocations, release on all terminal paths, help remains usable, and saturation does not accumulate queued closures/promises. Final limits follow the performance report.
- [ ] Follow the performance foundation's documented behavior for providers that ignore abort. Fast cancellation response alone is not proof that upstream work stopped or admission bounds abandoned upstream calls; report any such limitation and test its chosen resource accounting.

## Production-source contract checks

For integration evidence, seed **real serialized source schemas**, not only objects already shaped like `AgentContextItem`. Build data through the toolbox/calendar/memory owning modules where practical. Invoke `createAgentFeatureServices(...).readContext(...)` with the production adapter and fake backend, then the consuming feature. Spies fail on unrequested reads or unexpected service calls.

| Representative fixture / action | Required result |
| --- | --- |
| Real toolbox goal with target/current/history and date-only due; consume in a planner/review addition. | Stable `toolbox:goals:<id>`, numeric/status semantics preserved, civil due date unchanged, no invented completion time. Changing recorded history changes relevant analysis. |
| Real note/bookmark with long text, ampersands, credential-bearing/non-HTTP URL; consume in an evidence draft. | Source ID never derives from title/index; clipping is disclosed; permitted URL preserved without active markup; forbidden URL does not become an actionable source. No URL fetch. |
| Confirm an ICS preview via the calendar feature, then read events through real context and a consumer. Include 100 events, all-day/DST boundaries, past events, transparent intervals, and zero-duration instants. | All confirmed events remain available; preview events excluded; exclusive ends and dates preserved; zero-duration/transparent intervals don't invent busy time. Malformed calendar causes failure, not “free all day.” |
| Capture/confirm a memory card via memory-review, then consume it; advance the clock, expire/conflict/unconfirm it. | Only currently eligible cards appear with provenance. The consumer refresh reflects removal from the permitted snapshot. Memory-review cannot recursively import its own approved cards as legacy memory. |
| Fake Redis `eval`/records through `createProductionContextAdapters` for follow-ups/reminders/monitors/digests. | Owner, current signed channel, explicit team checks all hold; denied policy prevents index reads. Exactly 200 IDs accepted; 201 fails even if filtering would leave fewer. No `SCAN`, `KEYS`, repair writes, channel history, monitor raw observations, or error payload leakage. |
| Request no kinds, repeated kinds, one kind, or unavailable kinds (artifacts/legacy memory). | `[]` does no source I/O; duplicates don't reread; only selected supported sources load. Unconnected sources are not invented or fetched. No arbitrary sibling feature/toolbox namespace access. |
| Source read rejects, hangs, exceeds limits, or returns malformed eligible records. | Sanitized source-specific failure; prior saved feature result preserved; no catch-and-empty “success.” Cancellation prevents subsequent source work. |
| Reorder identical sources; change content/status/due/URL/publication date; change only observation time. | Canonical fingerprints are order-stable; relevant evidence changes are detected; observation time alone doesn't create a content change. Scope/schema version is explicit. |
| Refresh after a source is absent; then access from a different permitted channel. | “Absent from this permitted snapshot,” not proven deletion, completion, or invalidation everywhere. No broader lookup to recover a foreign source. |

At least one meaningful consumer test must cover every source family introduced by the fifty. Reuse shared source fixtures, and repeat feature-specific tests only where the consumer transforms that source differently. The adapter's maximum 1,500 combined items is not permission to request all kinds or embed all text in every model call.

## Per-feature acceptance card

Each implementation batch returns a short filled card per feature, not a large boilerplate test suite:

```text
ID / primary group / distinct user outcome:
Useful deterministic first command and actual expected output:
Full progression (save → inspect → optional draft → review/edit → remove):
Stateless or saved? Stable ID/schema; record/history/UTF-8 quotas:
Exact source kinds; source availability/freshness/date limitations:
Budgets: generations, searches, contextReads, storeReads, storeUpdates:
Per-command tighter limits; optional generation input/output bounds:
Stale/duplicate/cancel semantics; checkpoint/confirmation ownership:
Full retrieval/page commands; empty/error/quota next actions:
Tests + commands + commit; constraints and justified N/A items:
```

- [ ] Happy path checks meaningful computed output or state transitions, not only presence of an ID/title. For instance a comparison ranks explicit alternatives correctly, a review preserves recorded dates, or an evidence-based draft rejects fabricated source IDs.
- [ ] At least one realistic follow-through changes the record after creation and shows a useful next step without re-entering all input. Stateless utilities instead demonstrate a nontrivial transformation and its input limits.
- [ ] Inspect/list/delete do not use generation/search. Optional generation is explicit, bounded, and validates malformed/empty/oversized output before saving. Source content cannot request executable tools, direct messages, or external mutations.
- [ ] Unknown enum/field, missing required argument, extra delimiters, invalid date/number, and non-owned ID fail helpfully without partial mutation. Exercise the parser against examples emitted in help and acknowledgements.
- [ ] A maximal list/detail/evidence fixture can recover its final record, full long fields, and every cited source through valid pages. No clipped IDs/tokens/URLs or fabricated export path; last-page navigation terminates.
- [ ] Show generated vs supplied/recorded information, scope and observation date, plus one actionable next command. “Ready,” “draft,” “confirmed,” “paused,” and “completed” reflect actual local lifecycle facts, not external work performed.
- [ ] Include feature-specific stale-edit/source-fingerprint/schema/quota tests where those behaviors exist. Mark inapplicable behaviors explicitly rather than implementing unused lifecycle machinery merely to satisfy a template.

## Bounded performance validation

Hard release gates are call counts, byte/count limits, bounded queues/concurrency, no eager implementation imports, and no idle work. Timing/RSS targets below are provisional regression budgets to calibrate with the performance agent's same-machine Node 24 baseline, not measured production promises.

| Workload | Budget / evidence |
| --- | --- |
| Help/catalog/search on 70 metadata entries | Zero feature/provider/source work; at most ten rows and twenty modal blocks. Target ≤512 KiB serialized static metadata for the full catalog, including help; inspect actual UTF-8 size. |
| Warm catalog/filter/search | Measure 100 deterministic render/search calls after warmup. Initial target p95 ≤25 ms and no retained result/private-content cache. Compare with the twenty-entry baseline on the same host. |
| Cold registry/help | Three sequential fresh-process samples per baseline/candidate, record elapsed time, RSS and heap separately. Initial target ≤8 MiB incremental RSS from twenty to seventy metadata entries; investigate violations before changing a budget. Report test-loader overhead. |
| New deterministic operation | Zero generations/searches; zero context reads unless explicitly required. Record actual logical store/source calls and serialized bytes; never use global Redis scans. |
| New optional draft | Default ≤1 explicit generation, zero searches, ≤1 selected-kind context read. Bound input/output lengths in the feature; shared 80,000 input/24,000 instructions/28,000 output guards are emergency ceilings, not target prompt sizes. |
| Repeated invocation / admission saturation | One finite batch (for example 50 fake operations), then settle/GC if supported. Inspect retained heap and active handles; no per-invocation growth trend, no timer/queue leak, cap rejection before receipts/provider work. No live provider load test. |
| Near-quota lifecycle | Assert saved+reserved serialized bytes stay within feature quota through all promised transitions; no giant unbounded histories or repeated copies of full context. |

Run small benchmarks sequentially to avoid competing with parallel implementation tests; record versions/hardware/command and raw measurements. Do not enforce noisy wall-time measurements as universal CI truths or average away cold-start regressions. Any budget increase requires a reason, bounded alternative, and parent review; “seventy agents need more resources” is insufficient.

Request receipts are a separate 24-hour retained cost, including unique read-only invocations under the current runtime; no response text is cached. Include receipt counts/bytes in the performance report instead of reporting only feature-state size. Existing process-local cancellation means horizontal scaling is not a free fix.

## Verification and handoff

Run existing shared fake-backed suites once after foundation integration, then the newly added meaningful feature suites. Relevant baseline starting points are `agent-runtime`, `agent-startup`, `agent-slash-boundary`, `agent-context`, `agent-integration`, `agent-inbox`, `agent-workflows`, `agent-research`, and `slack-home-view`; add integration tests for actual new catalog/actions rather than assuming the old Home test exercises them. Use the performance agent's new foundation tests when available.

For each five-feature batch: targeted tests, typecheck as appropriate to interface changes, and `git diff --check`. For final parent integration: full tests with required shared coverage, typecheck, production build, and dependency audit. Respect existing test dependencies; any skipped/unavailable check is stated, not silently counted as passing. Do not install dependencies or repeatedly build all batches merely for a docs-only review.

Representative fake-backed tests establish application contracts, not live Slack delivery, native Stop-event subscription, client layout, upstream billing cancellation, Railway performance, or deployment success. Optional manual Slack verification belongs to separately authorized parent rollout: use private test data, check narrow/mobile layout, copyable commands, modal expiry, and actual event configuration. Never send Slack messages as an automatic documentation acceptance step.

The design sub-agent commits only `docs/personal-agent-50-ux.md` and this file, reports exact SHA and checks actually run, and leaves feature implementation, registry/Home integration, push/PR/deploy, and production verification to their assigned owners.

### Design-audit verification (baseline only)

On 2026-10-22, the design audit ran `agent-runtime`, `agent-startup`, and `agent-slash-boundary` with Node **24.22.1**, serially: **29 passed, zero failed/skipped**. Command: `node --import tsx --test --test-concurrency=1 tests/agent-runtime.test.ts tests/agent-startup.test.ts tests/agent-slash-boundary.test.ts`. The worktree had no dependency installation; an initial direct run could not resolve `redis`. The successful run used an unmodified temporary source copy with a symlink to the allowed root dependency directory, then removed that copy. No dependency files were changed. This validates baseline assertions only, not the proposed seventy-agent release gates above.

Both new docs were checked for local link targets, balanced code fences, and whitespace. No feature code, live provider/Slack call, production mutation, or deployment was part of this audit.
