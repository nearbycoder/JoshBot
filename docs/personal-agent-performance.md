# Personal-agent performance foundations

## Registration contract

New feature authors own `lib/agent-features/<id>.ts`, `<id>.metadata.ts`, the corresponding feature test and guide. Integration owns `registry.ts` and catalog/Home navigation. A metadata module imports only the type:

```ts
import type { AgentFeatureMetadata } from "./types.js";
export default {
  id: "example-agent", title: "Example", description: "A short purpose.",
  help: "Commands, limits, and a realistic /nobo-help agent example.",
  group: "Plan & prioritize", keywords: ["example"],
  example: "/nobo-help agent example-agent list",
  resourceBudgets: { generations: 0, searches: 0, contextReads: 0, storeReads: 8, storeUpdates: 4 },
} satisfies AgentFeatureMetadata;
```

The implementation imports and spreads that metadata into its `AgentFeature` export, adding the existing `execute(command, context)` function. Registration imports metadata and `lazyAgentFeature(metadata, () => import("./example-agent.js"))`. It must not import implementation modules. Existing twenty entries have literal snapshots in `catalog-metadata.ts`; the performance test compares id/title/description/help with the loaded modules. Help does not load implementations, Redis, inference or source services. Slack still performs its existing access check, under admission control.

## Enforced budgets

The initial local comparison selects **3 active invocations per process**, **2 per workspace/user**, with **no waiting queue**. One user's two requests leave one slot for another caller. Saturation returns a private busy response before policy Redis work, preference/backend initialization, imports or receipt creation. Retrying rejected work is safe because it has not started. `NOBO_AGENT_MAX_INFLIGHT=1..3` and `NOBO_AGENT_MAX_PER_USER=1..2` may lower limits; invalid/zero/fractional/increased values throw before work. Per-user capacity is clamped to global capacity. Deliberately lowering global capacity below three removes the default headroom for another caller.

One invocation permit and one 120-second deadline cover initial Slack policy evaluation, startup and execution. Direct `runAgentFeature` calls also get the deadline, including when passed an independent stop signal. Nested boundaries share the permit; they do not acquire twice. Cancellation stops waiting promptly. A permit remains occupied until *all tracked physical promises* settle, including nested raw Redis get/eval/policy work and provider calls whose outer context wrapper already rejected. A permanently hung dependency can consume a permit until restart; capacity is not silently reopened to accumulate abandoned work. No private payloads, result caches, user idle entries or waiting task queues are stored in the limiter.

Optional `resourceBudgets` can only lower defaults: `generations:8`, `searches:6`, `contextReads:8`, `storeReads:64`, `storeUpdates:32`. Integers zero through those values are accepted. Store budgets count logical operations, separate from the existing 32 CAS attempts per update and 512,000-byte state cap. Generation/search input/output bounds and 24-hour fingerprint-only receipts remain intact. Exa's request signal reaches its underlying transport; inference already receives the invocation signal.

Context reads are sequential per invocation, with at most 2,000 items, 16 MiB of JSON-equivalent bytes per response, and 32 MiB across the invocation. Metadata traversal is bounded to depth16 and 250,000 values; cycles/unsupported metadata fail. Byte counting avoids serializing a complete extra response. Exceeding a complete-read bound fails visibly; nothing is sliced to fit. Request fewer source kinds or reduce the relevant records and retry. There is no context memoization, so edits and access revocation remain observable on subsequent reads. The 28,000-character reply guard is unchanged; catalog pagination and the normal reply target belong to feature/UX integration.

## Validation and measurements

Measurements use Node24.22.1 and seed20261022, synthetic bounded services, production Vite SSR bundling, and an isolated fake Slack API for server startup. No live inference, Slack messages or production records are used. Run `node scripts/bench-agent-features.mjs` with Node24. Full-server and feature-runtime measurements must be interpreted separately. The benchmark report and maximum-context/mixed-load evidence are recorded below; the selected admission limits were tested against the same three 32-command recall bursts as the baseline.

Initial baseline: all96 commands accepted, accepted p95 1,254–1,287ms, loop maximum1,348–1,411ms, feature RSS peak278–279MiB. With8 permits:24 accepted/72 rejected, p95 249–266ms, loop253–265ms. With4:12 accepted/84 rejected, p95158–206ms, loop147–190ms. With3:9 accepted/87 rejected, p95117–140ms, loop110–127ms, feature RSS peak141–142MiB. Lower accepted latency is **not a throughput improvement**: overload work is explicitly rejected. The150ms event-loop target is a local regression target, not a production latency guarantee. All samples, including noisy JIT/GC samples, are retained in the report.

## Recorded baseline and final foundation comparison

All valid samples are retained in [`scripts/bench-agent-features.results.json`](../scripts/bench-agent-features.results.json), including failures. The baseline is commit `7a30db374bf3df702af5e28413468a04dc571862`; foundation is `19bff050a0862e8f0fc41abcc9b339ba07e30dbe`. The extended baseline was run from a temporary git archive using the same benchmark script. Node24.22.1, Linux x64, AMD RYZEN AI MAX+395; a shared development host, not a dedicated production instance.

The script builds the real runtime and server entries with the production Vite configuration, then forks fresh Node processes with a384MiB heap limit, synthetic services, an environment allowlist and outbound-fetch rejection. Server smoke uses a loopback Slack `auth.test` fixture and disables background runners. This is the production bootstrap code and bundler, but not Railway's exact container/runtime environment or a live Slack workload. Parent build memory is excluded. Linux `VmHWM` measures the exec'd child's RSS high-water mark; an initial probe using `resourceUsage.maxRSS` inherited the build parent's high-water mark and was corrected before the retained reports. Idle memory is sampled after an explicit GC; normal production GC timing differs.

Each runtime sample seeds40 inbox captures, measures100 sequential lists, sends three simultaneous32-request recall bursts (600 notes per accepted request, roughly0.9MB text), then offers60 mixed commands (45 lists and15 recall). The mixed driver waits10ms between arrivals, so event-loop stalls delay the driver too: its measured arrival/completion rate is closed-loop, not a promised open-loop throughput capacity. The baseline accepts96 recall calls before the mixed phase; admission accepts9, so JIT warmup histories also differ. The RSS peak includes the entire runtime sample, including mixed traffic.

| Extended workload | Baseline samples1/2/3 | Foundation samples1/2/3 |
| --- | --- | --- |
| Burst accepted / offered | 96/96 in each | 9/96 in each |
| Burst rejected / offered | 0/96 in each | 87/96 in each |
| Accepted burst p95, ms | 915.12 /905.16 /1104.32 | 196.61 /205.62 /220.80 |
| Burst CPU, ms | 3108.47 /3075.82 /3728.25 | 442.91 /483.84 /451.23 |
| Busy p95, ms | No busy responses | 0.175 /0.195 /0.275 |
| Mixed accepted / offered | 60/60 in each | 60/60 in each |
| Mixed deterministic p95, ms | 1.300 /1.418 /1.348 | 1.544 /2.120 /1.454 |
| Mixed recall p95, ms | 40.18 /52.61 /52.05 | 85.10 /84.43 /82.12 |
| Mixed CPU, ms | 565.15 /748.01 /713.44 | 725.02 /674.01 /698.45 |
| Mixed completions / second | 65.37 /56.15 /58.30 | 51.62 /56.05 /54.70 |
| Runtime peak RSS, MiB | 280.96 /278.96 /281.14 | 207.73 /207.92 /208.32 |
| Event-loop maximum, ms | 1004.54 /942.67 /1168.11 | 187.56 /202.24 /206.18 |

**The strict150ms event-loop check failed in all three extended foundation samples.** Earlier limit-selection samples at3 permits had110–127ms maxima; these later188–206ms results remain in the record. Admission stays3/2; neither the threshold nor admission was weakened to make the check green. The lower aggregate burst CPU reflects87 rejected commands, not cheaper individual recall or increased throughput. Ordinary commands remain responsive in this bounded mixed workload, but mixed recall has no demonstrated speedup in the foundation. No actual cloud savings are inferred.

Feature-help idle heap fell from13.02MiB to11.07MiB in the extended samples. Full-server results remain separate:

| Server metric | Baseline samples1/2/3 | Foundation samples1/2/3 |
| --- | --- | --- |
| Ready, ms | 642.56 /716.76 /730.01 | 853.90 /818.76 /557.08 |
| Idle RSS, MiB | 317.78 /307.43 /316.43 | 309.82 /301.73 /335.09 |
| Idle heap, MiB | 83.90 /83.96 /83.91 | 82.67 /82.72 /82.64 |
| Peak RSS, MiB | 339.30 /327.60 /336.74 | 330.18 /317.23 /339.00 |

These RSS ranges overlap and include a higher foundation sample; **there is no demonstrated full-server RSS reduction**. Production metrics cannot be compared to local RSS as if they were the same workload or process environment.

## Maximum source volumes and validator cost

Real production-adapter tests read all1500 supported records: five toolbox kinds×100, four legacy kinds×200,100 confirmed calendar events and100 approved memories. With1000-character toolbox/job bodies this complete snapshot is2,611,611 JSON-equivalent bytes and passes through the actual runtime. At12000-character bodies the combined snapshot exceeds16MiB and fails visibly without writes. Narrowing to100 notes succeeds at1,220,581bytes;200 reminders succeeds at4,926,491bytes. Thus the new byte bound deliberately excludes some previously individually valid source combinations. A count bound alone does not guarantee a combined byte bound. Existing twenty workflows pass their regression suite, but there is no claim that every combination of previously maximal records fits. User recovery is narrower source kinds where the feature supports them, or fewer/smaller selected source records; the foundation follow-up below partitions fixed-source reads and exposes explicit capacity recovery. These earlier broad-read measurements are retained as historical evidence.

An additional fresh-process workload runs3 concurrent actual runtime invocations with1500 unique records each,16,356,390 text bytes plus metadata (near16MiB). All3/3 finish in each of three samples. Foundation p95 is186.79 /86.27 /81.41ms; peak RSS110.79 /128.68 /128.10MiB; process CPU334.24 /258.84 /211.29ms. The corresponding baseline without runtime byte validation is recorded too (the benchmark does not serialize the payload to measure it). This measures the cost of validating a large complete response, not inference or retrieval. Byte counting is incremental; node/depth/count bounds prevent pathological metadata traversal. No snapshot survives in a process-wide cache.

## CPU profile and next optimization

A separate bounded V8 sampling profile covers the same three32-command recall bursts, with9 accepted and87 busy responses. Of356.72ms sampled, recall consumes260.24ms(73%), context-byte validation21.11ms(5.9%), GC21.12ms(5.9%), idle24.23ms and other runtime/startup/profiler work30.02ms. These are sampled stack times, not exact CPU accounting or proof of a particular JIT stall. Profiling overhead is excluded from the comparative benchmark samples.

Within recall (overlapping inclusive times), retrieval accounts for206.57ms, excerpt generation109.94ms, normalization47.38ms and frequency building47.42ms. `recall.ts` currently tokenizes source bodies repeatedly and builds excerpts for every matching candidate before sorting and selecting the displayed limit. A600-match query that displays10 results therefore scans600 bodies for excerpts. Ranking first and generating excerpts only for the selected results is the concrete next change; per-invocation normalization reuse may reduce repeated scans. Cooperative yielding could break long turns and add abort opportunities but would not by itself reduce CPU. No recall behavior was changed in the foundation/report commits.

## Exact production snapshot

Read-only Railway CLI5.62.1 queries used the absolute window **2026-10-22T16:45:00Z inclusive through17:45:00Z exclusive**, project`042cca35-2b42-4c41-a233-0b25a5ecdbd6`, production environment`96f78f81-0cbd-4ead-805b-1f409ac128ed`. There are120 evenly spaced30-second samples per series; first16:45:00Z, last17:44:30Z. Values below are arithmetic means/minima/maxima/latest of those returned samples, including zeros. The app's zero sample is retained; this report does not diagnose a deployment gap from a resource sample alone.

| Service / measurement | Mean | Minimum | Maximum | Latest |
| --- | ---: | ---: | ---: | ---: |
| App CPU, vCPU | 0.00112190 | 0 | 0.08075153 | 0.00023160 |
| App memory, GB | 0.23887855 | 0 | 0.44038554 | 0.17749606 |
| Redis CPU, vCPU | 0.00263781 | 0 | 0.00394437 | 0.00292310 |
| Redis memory, GB | 0.00848207 | 0.00828621 | 0.00881869 | 0.00854835 |

App service:`eb6c005c-9ef7-4ca2-a964-8cd924ecdcb2`; Redis:`5c1ad89e-2971-46d4-90dc-b59affdf38f5`. The supplied app deployment reference was`a588ccd9-57e2-4518-b8f0-f2af93433b25`; these queries are **service-level time series**, not measurements filtered to that deployment. Earlier MCP one-hour summaries used61 samples at60-second resolution and different relative windows; their means therefore differ. Railway describes CPU in vCPU and service-level metrics spanning deployments; see [resource measurement units](https://docs.railway.com/guides/right-size-cpu-memory) and [metric aggregation](https://docs.railway.com/observability/metrics). These are consumption observations, not paid allocation, a bill, or savings forecasts. No production settings, records or secrets were accessed/changed beyond read-only metrics and local CLI authentication.

## Repeatable checks

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node scripts/bench-agent-features.mjs --output /tmp/agent-benchmark.json
PATH=/tmp/joshbot-node24/bin:$PATH node scripts/bench-agent-features.mjs --check
PATH=/tmp/joshbot-node24/bin:$PATH node scripts/bench-agent-features.mjs --profile /tmp/agent-recall.cpuprofile
```

`--check` is an opt-in local performance regression gate: runtime RSS≤256MiB, deterministic p95≤50ms, accepted recall p95≤250ms, event-loop maximum≤150ms, at most3 physical context reads, and exactly9 accepted/87 busy burst requests plus60/60 mixed completions. The foundation run failed the strict event-loop target; the separate recall follow-up below passed without changing that target. It is not part of the normal correctness suite and must not silently be relaxed for shared-host noise. The script removes its temporary bundles and permits no live inference/search; only the loopback fake Slack API is used by server smoke. Source dependencies are linked without changing their package contents.

Correctness validation:658 personal-agent tests passed with zero skips, Node's test concurrency2, and an isolated loopback Redis7.2.10 instance with persistence disabled and removed after the run. The subsequent production-adapter maxima test passes in the15-test performance suite; typecheck passes. Scope covers the existing20 workflows, tenant isolation, receipts, logical store limits/CAS contention, byte budgets, overlapping context rejection, original deadlines, lazy metadata drift, retained cancelled raw promises and real Exa SDK transport cancellation. No live models, Slack messages, deployments, pushes or PRs were used.

## Narrow recall optimization follow-up

After the report commit, recall was changed separately to tokenize each candidate title/body once for frequency and phrase scoring, rank all candidates, and generate excerpts only for the displayed top K. The excerpt algorithm, scores, order/ties, citation identity and source-opening behavior are unchanged. Per-request normalized tokens/phrases are discarded after the invocation; there is no durable or global source cache. No cooperative yielding was added because the one planned post-change benchmark passed the existing strict target.

The same extended workload, admission limits, synthetic seed, Node version and script were run once for three fresh samples. All raw foundation failures remain alongside these new results in the JSON report. The benchmark ran the pending recall change atop `f549a02`; it is included in this follow-up commit.

| Metric | Foundation samples 1 / 2 / 3 | Recall optimization samples 1 / 2 / 3 |
| --- | --- | --- |
| Burst accepted / offered | 9/96 each | 9/96 each |
| Burst rejected / offered | 87/96 each | 87/96 each |
| Accepted burst p95, ms | 196.61 / 205.62 / 220.80 | 96.04 / 85.60 / 80.72 |
| Burst CPU, ms | 442.91 / 483.84 / 451.23 | 328.08 / 296.75 / 274.49 |
| Event-loop maximum, ms | 187.56 / 202.24 / 206.18 | 94.83 / 107.02 / 100.60 |
| Mixed accepted / offered | 60/60 each | 60/60 each |
| Mixed deterministic p95, ms | 1.544 / 2.120 / 1.454 | 1.523 / 1.499 / 1.547 |
| Mixed recall p95, ms | 85.10 / 84.43 / 82.12 | 40.63 / 38.00 / 35.53 |
| Mixed CPU, ms | 725.02 / 674.01 / 698.45 | 552.05 / 510.24 / 504.86 |
| Mixed completions / second | 51.62 / 56.05 / 54.70 | 68.72 / 71.33 / 72.16 |
| Runtime peak RSS, MiB | 207.73 / 207.92 / 208.32 | 196.26 / 196.05 / 197.79 |

**The strict 150 ms check passed all three post-optimization samples.** This is a local observation, not a production guarantee. The before/after denominator is identical here, unlike the original comparison against unbounded admission. The mixed driver remains closed-loop; shared-host and JIT caveats still apply. Full-server post-change idle RSS is 302.40 / 302.51 / 303.21 MiB (peak 318.27 / 319.57 / 319.53 MiB), retained separately and not evidence of cloud savings. Near-16-MiB validation still accepts 3/3 in each sample, with peak RSS 124.99 / 124.79 / 125.27 MiB; recall optimization does not alter that validation path.

105 targeted recall/foundation tests pass, zero skips, plus typecheck. Captured pre-change output fixtures compare exact selected provenance, ordering and excerpts for ties, quoted phrases, late evidence, Unicode and both search/ask widths. Bounded instrumentation observes 3 full-body excerpt scans for a search limit of 3 over 600 matches, 5 for ask limit 5, and zero for source reopening. It observes the actual unchanged excerpt iterator rather than mirroring the ranking implementation.

## Foundation review fixes (round 2 subsequently approved within foundation scope)

Three reproduced issues were addressed without changing admission/deadline/budget ceilings: each physical policy Redis read now holds its invocation permit; source evidence projects documented optional absence before strict JSON validation; and source consumers distinguish capacity from temporary outages. The evidence helper still rejects accessors, cycles, nonfinite/unsupported/lossy values, including unselected malformed metadata; stored-state validation is unchanged. Ordinary persisted notes, goals, bookmarks and all four legacy kinds are exercised through production adapters, runtime and the real scoped store with an in-memory backend.

Complete fixed-source consumers use the bounded sequential helper described in [context.md](agent-features/context.md#capacity-handling-in-the-foundation-follow-up). Handoff refresh/resume use recorded source kinds. `handoffs sources --kind note Atlas` and `automation-audit review --kind monitor` provide explicit narrowing; original syntax/default scope remain supported. Automation snapshots retain an optional `kind` for scoped reviews (absent means the original full scope); comparisons across scopes fail visibly rather than implying missing jobs. No source service method/type contract or catalog/lazy-help path changed.

The exact large-purpose fixture uses one ordinary note and 120 monitors + 120 digests with 12,000 CJK characters per purpose, all persisted job records below 64,000 bytes and indexes below 200. Its combined response is 17,582,078 bytes (minor ID/owner-string differences from the independent fixture). Before the fix, discovery, note refresh and audit review returned retry-later errors. Afterward, discovery and review succeed, and note refresh/resume read only `note`. With 180 records of each automation kind, the combined total exceeds 32 MiB: complete reads fail with usable narrowing commands, no source/saved-state writes, and saved show/resume remain usable. Scoped review recovery is exercised, including scope-preserving reload and authorization revocation.

The bounded production-adapter maximum probe retains all 1,500 supported records at 12,000 ASCII characters per toolbox/job body. Six responses contain 300/400/200/200/200/200 records and 3,662,041 / 2,548,311 / 2,509,291 / 4,926,491 / 4,937,691 / 4,925,291 JSON-equivalent bytes: 23,509,116 bytes total, all responses below 16 MiB and the invocation below 32 MiB. It asserts identical ordering to the complete production reader and zero writes. One instrumented shared-test-process sample took 172.53 ms wall / 228.03 ms CPU with 279.37 MiB current RSS; it includes a second byte traversal for measurement and earlier test allocations, so this is **not** a fresh-process memory peak or a recall event-loop benchmark. Larger newly admitted complete reads still have CPU/memory cost; batching bounds individual responses and does not promise a latency improvement.

No new full performance series was run at this foundation stage: recall ranking/excerpt/materialization code is unchanged, and the earlier strict 150 ms benchmark results and all failed samples remain intact. New checks cover bounded groups under lower read budgets, the original deadline during a later group, no reads/writes after cancellation, capacity messages at all ten consumer boundaries, wrapped production index overflow, raw policy siblings and real evidence capture. Independent review was outstanding when these measurements were recorded. The subsequent scope approval is reconciled below; this is not release approval.

Targeted validation: 355 tests passed, zero skips, covering the thirteen affected suites plus context, startup, integration and access controls; Node 24.22.1, test concurrency 2, in-memory backends only. Typecheck and `git diff --check` passed. Failing-before regression logs and subsequent passing runs were retained in `/tmp/joshbot-p1-before.log`, `/tmp/joshbot-p2-before.log`, `/tmp/joshbot-p3-before.log`, and `/tmp/joshbot-final-targeted.log` in the implementation environment. These temporary paths are review evidence, not repository artifacts.

## Release harness preparation, 2026-10-22

Independent foundation review at `5fb3086e30e516529676afa93093e36e7f7c5117` approved the three reproduced fixes within foundation scope: 370 repository tests and 12 independent probes, no failures/skips, plus typecheck. The retained `/tmp/joshbot-round2-review.0xSmfX/independent-round2.log` confirms the 12 probes and complete meeting/morning contexts of 29,340,341 bytes, weekly context of 21,945,211 bytes, and over-total rejection with no writes. `/tmp/joshbot-personal50-release-20261022.json` records that scoped approval and the separately integrated audit-guide correction. This closes the stale foundation review status; registration, new-domain review, release performance and deployment are distinct gates.

The new [`bench-agent-release.mjs`](../scripts/bench-agent-release.mjs) starts from verified parent `42013b01e7dcdc44b3e0655d0f36813e8cf93afd`. Supplied registration/domain/Home dependency commits are kept separate from the four harness-owned files. Production Vite builds use a temporary source copy and a removable, read-only-use dependency symlink. Every application worker starts with an explicit environment allowlist, no inherited credentials/loaders/proxies, and guards for fetch, TCP, TLS, DNS, UDP and Unix sockets. Only the full-server fixture permits literal loopback HTTP/TCP; its background runners are disabled. No live provider, production records, Redis or Slack are used.

The original benchmark script and its raw history are unchanged. The final comparable recall workload invokes that exact script's `--worker` with its original three Vite inputs, 384 MiB heap, seed 20261022, 40 captures, 100 lists, three 32-command bursts and 60 closed-loop mixed requests. A small boundary validator checks successful captures, the complete 40-item inbox, and recall's 10-of-600 result before returning each response; its regex/timestamp overhead is included. Original worker outputs are retained under `baselineRaw`. New workers have a 1 GiB heap ceiling and run sequentially. Linux `/proc/self/status` VmHWM supplies each exec worker's peak; build CPU/RSS are separate. Catalog idle heap/RSS use explicit GC, which differs from normal production GC.

New cases cover all 70 lazy metadata entries, all catalog/group pages using the actual `pages` result, exact-ID search, Home help, and a separate 70-implementation/50-addition parity probe. Unknown/incomplete responses cannot count as completed work. `catalog group plan page 2` currently yields a verified out-of-range response because that group fits one page; it is recorded as a validation rejection, not a successful page. Real production source adapters read synthetic persisted records into actual meeting-prep, morning-brief and weekly-review consumers. A separate six-group/1,500-record adapter probe is explicitly not a domain end-to-end test. Fixture byte differences from older probes reflect owner/ID/optional metadata differences; each new sample reports its exact batches. A second incremental byte-count diagnostic happens only after timing, CPU, RSS and loop snapshots, never by serializing a second complete response on the timed path.

The policy fixture repeats six cycles through actual `evaluateNoboAccess`, admission and the Slack boundary: rejection before/after abort and synchronous throws; ten physical reads with eight late siblings; 16 busy attempts per cycle; another owner's headroom; exact final release/refill; and one original deadline across policy/startup. The CSV case uses the registered data-cleanroom at 40 rows × 8 columns, dedupe/preview/apply/undo and complete revision-bound retrieval. It is a continuous sequential lifecycle driver, separate from recall comparability.

The unchanged recall thresholds remain RSS ≤256 MiB, deterministic p95 ≤50 ms, accepted recall p95 ≤250 ms and loop maximum ≤150 ms, with exactly 9 accepted/87 busy burst outcomes and 45 deterministic/15 recall mixed completions. Dedicated actual-feature workers also target ≤256 MiB process peak and ≤150 ms active loop maximum; policy targets ≤150 ms in its active window. Import/setup/whole-process loop evidence stays visible. Full-server and policy import-only RSS are reported separately. No peaks are subtracted and no averages can conceal a failed sample. Timing assertions are opt-in, outside normal correctness tests.

All preparatory samples, including harness failures and pending states, are retained in [`bench-agent-release.results.json`](../scripts/bench-agent-release.results.json). Corrections concern legacy help equality, expected out-of-range navigation, literal-IP lookup during server listen, and distinguishing a CSV report's terminal next-action from a pagination continuation. The preparatory rewritten driver observed a 227.934207 ms loop maximum; it is retained and is not a replacement for the unchanged historical driver. No final release pass or deployment approval is claimed at preparation time.

```sh
/tmp/joshbot-node24/bin/node --max-old-space-size=1024 --test --test-concurrency=1 tests/agent-release-performance.test.ts
/tmp/joshbot-node24/bin/node --max-old-space-size=1024 scripts/bench-agent-release.mjs --prepare --modes catalog,csv
# One planned series, only on the supplied integrated 70-agent source:
/tmp/joshbot-node24/bin/node --max-old-space-size=1024 scripts/bench-agent-release.mjs --final --check
# Separate diagnostic only after a concrete failed series:
/tmp/joshbot-node24/bin/node --max-old-space-size=1024 scripts/bench-agent-release.mjs --profile meeting-prep
```

The default history is append-only at event level: prior JSON event text is preserved, errors/profiles are never replaced, and each run records exact source hashes, build artifacts, Node/Vite versions, host load, command and cleanup. A missing catalog preflight exits 2; sample errors or a failed requested gate exit 1; a successful preparatory execution exits 0 while explicitly withholding release approval. Actual paid cost, production capacity, full-server RSS reduction and upstream cancellation savings remain unmeasured.

## Integrated 70-agent series: release performance targets FAILED

The one planned series ran **2026-10-22T21:23:11.596Z–21:23:35.225Z**, run `11b66bdd-b0fd-4ee5-8fc6-a8fdac1c1ed0`, using the `--final --check` command above. All **30 fresh workers completed**; all raw samples remain in the release history. The command exited **1**, with twelve failed sample/target combinations. There were no favorable timing retries. Feature correctness and catalog/domain review are separate; this result does **not** authorize deployment.

Exact source head: preparation commit `87da74a5416187b35c6f945ef62e030b03202777`. Its application includes the supplied final registration, domain hardening `db792e9d8f9d6181f406a82a46b00ecdf1bfa072`, and Home Reset correction `e7c5b379f4c46ee089054f93bfeaf9d3b40de1f1`; dependency commits were cherry-picked separately. The full input manifest SHA-256 is `fde10ea7696decf3620ab4a1ccb288373eaece7ab3209f272a5dc720f0efc57e`; application/config/package inputs excluding benchmark scripts hash to `3eaf4e3a897809be90c34b8d850ed1d48617532fd6645293860daef85b4a85fc`. Each file and output chunk hash is in the build event. Only the append-only history changed while the series ran. Node **24.22.1**, Vite **8.3.5**, Linux x64, AMD RYZEN AI MAX+395. The unchanged historical raw file hashes to `9b72f674cb38b4db226c87fd0214bfd7ed32c5848a6f5ff3a61d9b26c7a6cb85`.

The parent coordinated a quiet window with the two reviewers; this remained a shared host. Observed 1/5/15-minute load-average ranges were 17.81–19.99 / 17.39–17.92 / 16.95–17.14 across the workers; these are host run-queue averages, not this process's CPU use. CPU below is user+system milliseconds. RSS uses MiB (1,048,576 bytes), with per-exec Linux VmHWM; historical-worker values retain its original two-decimal reporting. Build CPU is never attributed to application requests.

| Comparable runtime metric | Samples 1 / 2 / 3 |
| --- | --- |
| Burst accepted / busy / offered | 9 / 87 / 96 in every sample |
| Physical burst context calls / peak concurrency | 9 / 3 in every sample |
| Mixed deterministic / recall / completed | 45 / 15 / 60 in every sample |
| 100-list deterministic p95, ms | 0.976 / 1.170 / 0.972 |
| Accepted burst recall p95, ms | 123.588 / 108.230 / 100.083 |
| Mixed deterministic p95, ms | 1.806 / 1.686 / 1.641 |
| Mixed recall p95, ms | 54.246 / 47.952 / 41.241 |
| Burst CPU, ms | 437.970 / 378.710 / 359.100 |
| Mixed CPU, ms | 631.750 / 666.430 / 582.070 |
| Whole worker CPU, ms | 1364.430 / 1336.810 / 1200.480 |
| Whole worker peak RSS, MiB | 190.730 / 199.000 / 198.740 |
| **Event-loop maximum, ms — FAILED ≤150** | **236.454 / 232.260 / 198.705** |

All 40 captures and all expected list/recall outputs were positively validated. Rejections are never counted as useful throughput. The original timer includes cold first execution, 40 captures and 100 immediate sequential lists, as it always did; the new lazy dispatcher moves runtime/Redis package imports from initial help into first execution. This changes where real cold-start work occurs, not the historical measurement definition. The 227.934207 ms preparatory rewritten-driver sample and subsequent 199.229 ms preparatory original-worker sample remain recorded.

For new cases, the active window begins after fixture construction/imports and an explicit histogram-arm delay. Whole-process RSS still includes those earlier allocations; **nothing is subtracted**. Each large consumer has one accepted request per worker, so its per-worker p95 equals that one latency and is not a broad production distribution. Three fresh processes expose cold/JIT/GC variation. The six-group probe measures adapters/runtime/helper only; meeting/morning/weekly invoke the actual consumer and validate its result/state. Their exact JSON-equivalent totals are 23,575,616 / 29,339,745 / 29,339,745 / 21,945,013 bytes respectively. These values differ slightly from historical fixtures because of explicit optional metadata, owner/ID strings and summed group delimiters.

| Workload | Active loop maximum, ms (1 / 2 / 3) | Active CPU, ms (1 / 2 / 3) | Whole-process peak RSS, MiB (1 / 2 / 3) |
| --- | --- | --- | --- |
| Six-group adapter, 1,500 records — **FAIL loop** | **169.607 / 192.807 / 168.165** | 185.436 / 208.370 / 187.235 | 163.273 / 163.285 / 163.754 |
| Meeting preparation, 600 records | 125.698 / 124.191 / 133.235 | 133.659 / 133.292 / 141.814 | 129.859 / 125.652 / 130.156 |
| Morning brief, 600 records — **FAIL loop** | **160.956 / 158.073 / 171.311** | 169.280 / 167.694 / 183.356 | 138.324 / 137.492 / 138.469 |
| Weekly review, 600 records | 140.771 / 141.558 / 139.067 | 152.869 / 150.079 / 150.137 | 150.961 / 150.047 / 151.813 |
| Over-total audit rejection, 540 records | 123.077 / 113.312 / 112.460 | 128.515 / 118.483 / 118.195 | 119.641 / 119.336 / 120.055 |
| Repeated policy cancellation/error | 12.050 / 12.206 / 12.583 | 14.216 / 15.480 / 14.876 | 280.148 / 281.180 / 279.668 (separate Slack/import footprint) |
| CSV lifecycle/retrieval — **FAIL loop** | **259.391 / 271.319 / 251.396** | 411.727 / 406.530 / 357.763 | 104.645 / 102.586 / 101.047 |

The six-group request uses 6 logical reads, 807 fake backend gets, 4 exact production index evaluations and 4 read-only authorization calls. Meeting uses 4/406/2/2; morning 4/404/2/2; weekly 3/206/1/1. Every case declares concurrency 1 and observes at most one active physical fake dependency, each response ≤16 MiB/2,000 items and ≤8 logical reads. Meeting/weekly each save one valid bounded snapshot. The 39,574,473-byte over-total audit uses 3/541/3/3, visibly rejects the 32 MiB total, and preserves its previous state with zero writes/generations. All byte totals are measured incrementally after captured timing/RSS/CPU, with exact batch details in the raw history. No model/search call occurs.

Policy repeats six cycles per worker: 60 physical reads all settled, maximum 10 pending, zero pending at completion, 96 busy attempts, another owner's third-slot access, and exact release/refill. No failed policy reaches backend/preferences/feature startup. One original policy deadline reaches later startup and prevents late continuation. Import-only RSS is 274.359 / 276.387 / 275.098 MiB; whole-worker CPU is 1040.959 / 1002.428 / 1011.900 ms. Those imports are not charged to the 12–13 ms active loop measurement or silently represented as a small whole-server process.

CSV completes the maximum 40×8 grid, ten duplicate groups, preview/apply/undo, and 19 complete retrieval pages per worker. Per-command p95 is 10.204 / 13.799 / 10.028 ms, while the **continuous immediate-backend lifecycle driver** stalls the loop for 251–271 ms. A 10 ms command p95 does not erase this failure. Real Slack arrivals/Redis I/O yield differently; this fixture proves bounded deterministic CPU work and retrieval, not live throughput.

Catalog checks all 70 registrations/50 new implementations, full grouped traversal, exact-ID searches and pure Home help with zero forbidden implementation/services/provider imports and zero startup calls. Catalog cold import+help is 10.074 / 10.559 / 7.223 ms, help p95 0.025 / 0.023 / 0.014 ms, idle heap 7.067 MiB each, idle RSS 55.891 / 53.969 / 56.496 MiB; whole catalog CPU 85.396 / 73.165 / 77.484 ms. Full-server health is 200 in all three samples, with readiness 844.851 / 832.715 / **1769.797** ms, idle RSS 292.199 / 290.887 / 295.449 MiB, peak RSS 308.246 / 306.258 / 310.387 MiB and CPU 1373.927 / 1370.231 / 1772.561 ms. The slower third sample is retained. Different source/build/host conditions prevent claiming a full-server RSS improvement over the historical 302–303 MiB observations. Production resource use and cloud costs remain unmeasured.

## Single post-failure diagnostic and proposed next scope

Exactly one separate whole-worker baseline CPU profile was recorded after the failed series: run `ede44828-96fa-4cde-9a42-b7dc0fee2c9b`, raw SHA-256 `02aa9eb21cbcc46e0525607d5a54e383357e83f0795ddce29fb4bfc152c86b83`. The full profile and its result are retained as a `profile` event, never a timing sample. Application hashes match the timed series; only harness diagnostic instrumentation differs. Profile overhead is included. No additional profile or timing retry was run.

The diagnostic's 40 captures span **145.278 ms**, immediately followed by **69.331 ms** for 100 lists: **214.617 ms** of consecutive first-execution/setup/list work, before the recall burst's 10 ms fake context delays. The profiled loop maximum is 224.920 ms. This identifies a cold-import/setup/cheap-command chain as a concrete source of long turns; it supports, but does not retroactively assign an exact phase to, the earlier 227.934207 ms sample, which lacked phase markers. Setup self-samples include CommonJS `wrapSafe` 31.335 ms, inbox `execute` 16.936 ms, `realpathSync` 7.441 ms, GC 7.407 ms and Redis command-module initialization. The subsequent list window includes inbox text-validation regex 21.174 ms, scoped-store `parse` 12.129 ms, inbox `execute` 11.657 ms, `snippet` 8.502 ms and `isoDate` 5.255 ms. These are sampled stack times, not exact CPU accounting. Recall `clean`, `tokens`, `frequencies` and runtime byte counting remain significant whole-profile costs; accepted recall itself still passed its p95 target.

A diagnostic label error placed the first mixed list in the `burst96` phase (97 callbacks, leaving 59 in `mixed60`). The original worker's 96/60 counts remain correct. The valid setup/list windows above are unaffected. Raw profile/windows remain unchanged, an analysis event records the error, and the future label classifier is corrected without another run.

Proposed scope for a separately authorized implementation task, **not changes made by this harness**:

1. In `lib/agent-features/store.ts`, investigate moving the static Redis import into `createAgentStateBackend`. The current injected-backend execution still loads Redis through `runtime → store → redis`; actual default-backend behavior, errors and cancellation must stay unchanged. This may reduce cold execution CPU, but the profile does not prove it alone clears every target.
2. In `lib/agent-features/runtime.ts`, investigate a bounded cooperative yield while holding the admitted invocation, with the same deadline and immediate post-yield abort check. This could prevent a chain of immediate fake-backend commands from monopolizing a turn, including inbox setup/lists and the CSV lifecycle. It must not release physical-work permits early, reorder receipt safety, add an unbounded queue or renew deadlines. Yielding improves responsiveness rather than proving lower CPU or cost.
3. In `lib/agent-features/bounded-context.ts`, investigate yielding between the existing sequential groups while retaining exact ordering/count/byte checks and the original signal. The six-group and morning active failures are measured, but the baseline profile does not locate their CPU hot spots. If needed, a parent-approved bounded profile should cover `context.ts`, `context/legacy.ts`, `budgets.ts:measureAgentContext` and `morning-brief.ts:sourceFrom/renderBrief` before algorithm edits.
4. CSV-specific optimization remains unprofiled: inspect `data-cleanroom.ts:detailPages/pages/stamp/projectLifecycle` and bounded-state byte validation only if runtime fairness/import work leaves a measured failure. Preserve all source cells, dynamic reserve, preview/undo behavior and exact revision-bound retrieval; do not make the harness insert favorable pauses.

No implementation outside the four owned paths was edited. Correctness validation is 7/7 tests, zero skips, Node 24, concurrency 1; typecheck and diff checks pass. Temporary source trees, bundles, worker children and dependency symlinks were cleaned. The remaining work is a concrete performance fix, independent review and a separately planned post-change verification; deployment and production-cost evidence are not supplied by this result.

The parent subsequently reported an independent P1 finding on this measured source: shared command trimming can remove CSV trailing spaces or a final blank row. This benchmark’s 40×8 fixture uses nonblank single-digit cells and does not exercise those cases. Its exact retrieval/lifecycle oracles pass only for that explicit fixture; broad CSV correctness is not approved. A separate child owns the runtime/index/Slack payload-forwarding correction and domain regressions. Any performance change touching `runtime.ts` must be coordinated with that owner, and future timing evidence must identify the supplied corrected dependency. The recorded failed series is unchanged.

## Authorized implementation and post-change release verification, 2026-10-22

The separately authorized follow-up implemented deferred Redis loading in `d2bd16783d7ddfb6c8d8f624d529861866ae5753` and cooperative fairness in `aaaf3842ce9dab2b2bfafdfac5c8e1765f039323`. The default backend still imports the actual Redis module and retains its null/error/CAS behavior; injected execution avoids that dependency graph. Runtime yields once **after admission and before backend/receipt work**, and bounded context yields only between existing sequential groups. Both use the original signal and check it immediately after the yield. Admission, physical-work retention, budgets, schemas, validation, ordering, complete reads and raw CSV payload forwarding remain intact. There is no request queue or feature-algorithm change. No fixed sleep or harness pause was added.

Cold-import regression failed before the import change. Six fairness regressions failed before the relevant yields: real timer progress during 40 immediate-backend captures and the actual 1,500-record adapter fixture, stop/deadline during the admitted yield, deadline between groups, and actual automation authorization revocation between groups. Checks cover cancellation before backend lookup/import or receipts, retry without poisoned receipt, unchanged 3 global / 2 per owner limits, busy rejection, late raw-promise retention and release, complete ordering/byte bounds, and preservation of the prior saved snapshot. The actual default backend passed isolated loopback Redis 7.2.7 CAS/concurrency/receipt/TTL checks with persistence disabled. No provider/search calls occurred.

Deferred-import validation passed 58 / 58; the parent independently passed 103 / 103 fairness/runtime/startup/context/performance/CSV tests (including all 14 P1 payload regressions). An initial local combined check passed 110 / 111: its production build could not find the new unstaged helper because the harness copies `git ls-files`. This was a correctness preparation issue, **not a timed sample**, retained in untracked `/tmp/joshbot-performance-fairness-after.log`. Staging the helper allowed the affected 25 / 25 checks to pass; after all final dependencies, 23 goal-source plus 7 harness checks passed 30 / 30. Zero skips/cancellations, types and diff checks passed. The harness is byte-for-byte unchanged from evidence commit `25e8e310`; thresholds, fixtures, timing windows, original benchmark and original raw history were not edited. Relative to the earlier timed `87da74a` manifest, `25e8e310` added profile-only phase bookkeeping and its label correction; these are inactive in normal timing runs. The appended analysis lists every changed input, including that harness-file hash difference.

Exactly one post-change planned series ran at **`f9a1168c3506929ef1d6352d6025217c4bc542ab`**, run **`73975d7c-d2e1-4899-b5e9-19be0bc4cdb0`**, **2026-10-22T21:37:09.557Z–21:37:30.822Z**. All 30 fresh workers completed; `--check` exited 0 with no failed targets. This is a scoped offline performance pass; independent shared-runtime/domain/catalog review and deployment remain separate. No additional timing series or profile was run. All preceding failed/preparatory samples, the 227.934207 ms observation, and the full diagnostic profile remain immutable in the append-only history.

Command: `/tmp/joshbot-node24/bin/node --max-old-space-size=1024 scripts/bench-agent-release.mjs --final --check`. Node 24.22.1, Vite 8.3.5, Linux x64 on the same shared AMD RYZEN AI MAX+395 host; per-exec Linux VmHWM, CPU user+system in milliseconds, RSS in MiB. Historical runtime retains its 384 MiB heap; new workers have 1 GiB. Full input manifest SHA-256: `e1969fc5afdc2cf47ec45b0c87dc4dfd3048b711121be1fa64998233a7de77e1`; application/config/package inputs excluding benchmark scripts: `d70bf41e7d0cc00d933f5ac37c0a7442384f17313c6e9679f90a70b8dbbce3ff`. Individual source and artifact hashes remain in the build event. Only the result-history append was dirty at capture. Build CPU 2303.909 ms, wall 392.630 ms and peak 908.664 MiB are separate from every application worker.

Final-source dependencies after the failed series were separately cherry-picked, in addition to both performance commits: CSV payload `2e2a6487a58b17efb6fd1125251f20e543ae1ad6`; process invariants `24fb3f65f640501e55ecc792875a87b3b6939f82`; batch09 IDs `7488a1855daa9b151566d03c5cf8939a2aa79b94`; Bolt listener namespace `831ba3926a13f6056b8b311c2f92a293c22d3b9e`; cleared Home draft `f30624f90b2974add165628b132c53b9bd959cc7`; goal-source recovery/help `f16a7173db03e760227880cf7f5bde5050252838`. The subsequent process-guide count correction is documentation only and outside this executable manifest.

A quiet window was requested; root/catalog paused heavy checks. The final10 author later disclosed an already-running old20 compatibility suite, 589 / 589 passed, Node-reported duration 22, 871.855682 ms. Its log creation/last-write proxies are 21:37:03.024289001Z–21:37:25.919683720Z; completion was observed 21:37:33.260331284Z after a process check found no matching test process. **These are not exact process bounds.** The log interval intersects this series from catalog through weekly review/early capacity, but exact overlap by worker cannot be established. Evidence: `/home/nearby/.t3/userdata/tmp/joshbot-final10-implementation-hemx6ozn/old20-final.tap`. No samples were discarded or rerun. Recorded host 1 / 5 / 15-minute load ranges were 15.28–17.30 / 13.85–14.41 / 14.50–14.67; each worker retains its own load/memory snapshot.

The following comparisons retain sample 1 / 2 / 3 in order. “Before” is failed run `11b66bdd-b0fd-4ee5-8fc6-a8fdac1c1ed0`; no means, best-sample selection or RSS subtraction are used. The unchanged runtime gates are 256 MiB peak, 50 ms deterministic p95, 250 ms accepted recall p95, 150 ms loop maximum and physical-context peak ≤ 3.

| Comparable runtime metric | Before, samples 1 / 2 / 3 | After, samples 1 / 2 / 3 |
| --- | --- | --- |
| 100-list deterministic p95, ms | 0.976 / 1.170 / 0.972 | 1.099 / 0.993 / 1.075 |
| Mixed deterministic p95, ms | 1.806 / 1.686 / 1.641 | 25.854 / 31.255 / 22.470 |
| Accepted burst recall p95, ms | 123.588 / 108.230 / 100.083 | 111.925 / 98.635 / 115.539 |
| Mixed recall p95, ms | 54.246 / 47.952 / 41.241 | 45.312 / 44.396 / 41.377 |
| Burst CPU, ms | 437.970 / 378.710 / 359.100 | 328.810 / 320.360 / 307.070 |
| Mixed CPU, ms | 631.750 / 666.430 / 582.070 | 529.700 / 556.160 / 507.770 |
| Whole worker CPU, ms | 1364.430 / 1336.810 / 1200.480 | 1030.750 / 1034.480 / 967.860 |
| Whole worker peak RSS, MiB | 190.730 / 199.000 / 198.740 | 187.320 / 186.130 / 146.480 |
| Event-loop maximum, ms | 236.454 / 232.260 / 198.705 | 68.878 / 92.275 / 77.791 |
| 40-capture setup window, ms | 161.827 / 133.516 / 125.015 | 68.337 / 53.395 / 54.945 |

Both series complete 40 captures and 100 cheap commands per worker, with 96 offered recall requests: **9 accepted, 87 busy, 0 failed**, 9 physical context calls and peak 3. Mixed requests remain **60 / 60 completed, 45 deterministic + 15 recall**, 0 busy/failed. Accepted and rejected denominators are unchanged; busy replies are not useful throughput. Mixed deterministic p95 **increased** to 22.470–31.255 ms while staying below 50 ms: yielding permits competing admitted work before a cheap request resumes. Cold setup/import and request timing were not moved out of the historical measurement.

Dedicated workers below use the existing **active request** loop target ≤ 150 ms and **whole-process** peak RSS≤ 256 MiB. Policy active loop uses 150 ms; its import RSS stays separate. Each cell shows before three samples → after three samples.

| Workload | Active loop maximum, ms | Active CPU, ms | Whole-process peak RSS, MiB |
| --- | --- | --- | --- |
| adapter-six | 169.607 / 192.807 / 168.165 → 40.894 / 36.504 / 42.992 | 185.436 / 208.370 / 187.235 → 193.719 / 185.108 / 189.244 | 163.273 / 163.285 / 163.754 → 154.430 / 151.637 / 151.102 |
| meeting-prep | 125.698 / 124.191 / 133.235 → 46.105 / 53.412 / 58.360 | 133.659 / 133.292 / 141.814 → 153.342 / 154.201 / 171.498 | 129.859 / 125.652 / 130.156 → 122.289 / 122.957 / 122.016 |
| morning-brief | 160.956 / 158.073 / 171.311 → 86.049 / 82.706 / 68.813 | 169.280 / 167.694 / 183.356 → 196.431 / 181.863 / 154.442 | 138.324 / 137.492 / 138.469 → 124.434 / 125.227 / 124.922 |
| weekly-review | 140.771 / 141.558 / 139.067 → 64.061 / 49.021 / 59.867 | 152.869 / 150.079 / 150.137 → 178.995 / 149.192 / 143.158 | 150.961 / 150.047 / 151.813 → 140.355 / 140.059 / 139.324 |
| capacity | 123.077 / 113.312 / 112.460 → 38.994 / 31.785 / 35.488 | 128.515 / 118.483 / 118.195 → 122.360 / 106.522 / 114.448 | 119.641 / 119.336 / 120.055 → 127.793 / 129.316 / 128.500 |
| policy (RSS ungated) | 12.050 / 12.206 / 12.583 → 12.198 / 12.411 / 12.632 | 14.216 / 15.480 / 14.876 → 13.878 / 16.886 / 15.861 | 280.148 / 281.180 / 279.668 → 280.371 / 280.328 / 280.398 |
| csv | 259.391 / 271.319 / 251.396 → 32.113 / 21.430 / 34.537 | 411.727 / 406.530 / 357.763 → 277.589 / 247.268 / 237.128 | 104.645 / 102.586 / 101.047 → 121.004 / 115.523 / 115.867 |

Imports/setup are still reported and included in whole-process peaks. The active window and post-timing incremental byte diagnostic are unchanged. For completeness, whole-worker CPU (including import/setup) is:

| Workload | Whole CPU, ms before → after (all three) |
| --- | --- |
| catalog | 85.396 / 73.165 / 77.484 → 65.552 / 63.743 / 61.251 |
| server | 1373.927 / 1370.231 / 1772.561 → 1358.907 / 1446.422 / 1539.062 |
| adapter-six | 434.888 / 467.402 / 420.906 → 368.323 / 364.158 / 366.332 |
| meeting-prep | 365.149 / 354.299 / 380.692 → 344.701 / 347.417 / 367.614 |
| morning-brief | 384.526 / 396.845 / 434.683 → 378.620 / 358.982 / 309.525 |
| weekly-review | 386.027 / 372.311 / 376.439 → 385.454 / 339.194 / 332.638 |
| capacity | 352.749 / 337.013 / 346.127 → 368.125 / 359.088 / 364.044 |
| policy | 1040.959 / 1002.428 / 1011.900 → 919.383 / 966.072 / 940.857 |
| csv | 422.512 / 419.435 / 405.243 → 294.667 / 258.603 / 261.759 |

Accepted per-worker p95 values below represent one large request each, not a production percentile distribution. CSV p95 is across its 26 commands. Capacity has no accepted latency: it must reject the over-total request.

| Workload | Accepted/request p95, ms before → after (all three) |
| --- | --- |
| adapter-six | 154.767 / 179.223 / 157.436 → 142.981 / 139.346 / 145.606 |
| meeting-prep | 115.620 / 113.546 / 124.085 → 115.119 / 117.335 / 131.858 |
| morning-brief | 151.822 / 149.891 / 163.163 → 155.467 / 142.840 / 120.702 |
| weekly-review | 132.602 / 131.362 / 130.835 → 140.303 / 110.192 / 108.959 |
| csv | 10.204 / 13.799 / 10.028 → 11.153 / 12.025 / 14.162 |

Counts, exact byte totals and outcomes match the failed series in **every** post-change sample:

| Workload | Items / total bytes | Logical reads / backend gets / index evals / policy calls | Writes / outcome |
| --- | --- | --- | --- |
| adapter-six | 1500 / 23575616 | 6 / 807 / 4 / 4 | 0 / 1 accepted complete request |
| meeting-prep | 600 / 29339745 | 4 / 406 / 2 / 2 | 1 / 1 accepted complete request |
| morning-brief | 600 / 29339745 | 4 / 404 / 2 / 2 | 0 / 1 accepted complete request |
| weekly-review | 600 / 21945013 | 3 / 206 / 1 / 1 | 1 / 1 accepted complete request |
| capacity | 540 / 39574473 | 3 / 541 / 3 / 3 | 0 / over 32 MiB rejection; prior state preserved |

All context fixtures use concurrency 1, peak physical dependency 1, each group ≤ 16 MiB and ≤ 2, 000 items, at most 6 logical reads, and zero generation/search calls. Six-group is an adapter/runtime/helper probe only; the other named consumers execute their actual feature and validate bounded resulting state. Policy still has 6 cycles, 60 physical reads / 60 settlements, maximum 10 pending, 0 remaining, 96 busy attempts, no failed-policy startup, original deadline and exact permit release. CSV still offers/completes 26 commands, 40×8 cells, 10 duplicate groups and 19 complete pages, source 663 bytes, state 8,893 bytes, export 8,917 bytes, 29 reads / 4 writes, and 0 model/search/context calls. Its fixture remains nonblank single-digit cells; whitespace/blank-row correctness comes from the separate 14 P1 regressions, not from this benchmark.

Metadata-only catalog still proves 70 registrations / 50 additions, all groups/pages/search/help and pure Home, with zero forbidden implementation/services/provider loads or startup calls. Full server uses real bootstrap, loopback fake Slack, backgroundRunners=false, and health 200 in every sample. These import/bootstrap figures are separate from active request gates:

| Separate measurement | Before → after, all three |
| --- | --- |
| Catalog cold import+help, ms | 10.074 / 10.559 / 7.223 → 9.919 / 8.170 / 7.982 |
| Catalog help p95, ms | 0.025 / 0.023 / 0.014 → 0.014 / 0.010 / 0.012 |
| Catalog idle heap, MiB | 7.067 / 7.067 / 7.067 → 7.069 / 7.070 / 7.071 |
| Catalog idle RSS, MiB | 55.891 / 53.969 / 56.496 → 54.656 / 55.285 / 55.684 |
| Full-server readiness, ms | 844.851 / 832.715 / 1769.797 → 830.231 / 880.595 / 979.884 |
| Full-server idle RSS, MiB | 292.199 / 290.887 / 295.449 → 292.563 / 291.676 / 291.734 |
| Full-server peak RSS, MiB | 308.246 / 306.258 / 310.387 → 308.383 / 308.426 / 307.832 |
| Policy import-only idle RSS, MiB | 274.359 / 276.387 / 275.098 → 274.691 / 275.258 / 274.270 |

Responsiveness improved in these retained samples, but there is **no uniform CPU or memory improvement**. Meeting active CPU increases in all three samples; morning/weekly vary; CSV and capacity peak RSS increase in all three. Runtime whole CPU is lower in these observations, but shared-host overlap, cold JIT/GC and the other supplied source fixes prevent attributing that entire difference to deferred imports. Cooperative yielding does not reduce algorithmic work or prove cloud savings. The full-server footprint remains about 292 MiB idle / 308 MiB peak and is not subjected to an invented 256 MiB server gate. Explicit idle GC, synthetic data, closed-loop arrivals and fake immediate backends differ from production. No production CPU/RSS reduction, provider-billing cancellation, cloud cost reduction or deployment approval is established.

Whole-worker loop maxima also retain import/setup stalls: full server 864.027 / 903.873 / 1011.876 ms and policy 670.564 / 682.099 / 681.574 ms. These are separate bootstrap/import observations, not the active-policy window or a newly imposed server gate. No additional profile is justified by this passing series. Temporary build/source trees, children, loopback Redis/client and owned dependency resolvers were cleaned; retained logs and append-only evidence are intentional. Independent review of the shared fairness/import changes and final domain/catalog correctness remains the parent's release gate.
