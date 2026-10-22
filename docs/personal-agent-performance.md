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

## Foundation review fixes (pending independent round 2)

Three reproduced issues were addressed without changing admission/deadline/budget ceilings: each physical policy Redis read now holds its invocation permit; source evidence projects documented optional absence before strict JSON validation; and source consumers distinguish capacity from temporary outages. The evidence helper still rejects accessors, cycles, nonfinite/unsupported/lossy values, including unselected malformed metadata; stored-state validation is unchanged. Ordinary persisted notes, goals, bookmarks and all four legacy kinds are exercised through production adapters, runtime and the real scoped store with an in-memory backend.

Complete fixed-source consumers use the bounded sequential helper described in [context.md](agent-features/context.md#capacity-handling-in-the-foundation-follow-up). Handoff refresh/resume use recorded source kinds. `handoffs sources --kind note Atlas` and `automation-audit review --kind monitor` provide explicit narrowing; original syntax/default scope remain supported. Automation snapshots retain an optional `kind` for scoped reviews (absent means the original full scope); comparisons across scopes fail visibly rather than implying missing jobs. No source service method/type contract or catalog/lazy-help path changed.

The exact large-purpose fixture uses one ordinary note and 120 monitors + 120 digests with 12,000 CJK characters per purpose, all persisted job records below 64,000 bytes and indexes below 200. Its combined response is 17,582,078 bytes (minor ID/owner-string differences from the independent fixture). Before the fix, discovery, note refresh and audit review returned retry-later errors. Afterward, discovery and review succeed, and note refresh/resume read only `note`. With 180 records of each automation kind, the combined total exceeds 32 MiB: complete reads fail with usable narrowing commands, no source/saved-state writes, and saved show/resume remain usable. Scoped review recovery is exercised, including scope-preserving reload and authorization revocation.

The bounded production-adapter maximum probe retains all 1,500 supported records at 12,000 ASCII characters per toolbox/job body. Six responses contain 300/400/200/200/200/200 records and 3,662,041 / 2,548,311 / 2,509,291 / 4,926,491 / 4,937,691 / 4,925,291 JSON-equivalent bytes: 23,509,116 bytes total, all responses below 16 MiB and the invocation below 32 MiB. It asserts identical ordering to the complete production reader and zero writes. One instrumented shared-test-process sample took 172.53 ms wall / 228.03 ms CPU with 279.37 MiB current RSS; it includes a second byte traversal for measurement and earlier test allocations, so this is **not** a fresh-process memory peak or a recall event-loop benchmark. Larger newly admitted complete reads still have CPU/memory cost; batching bounds individual responses and does not promise a latency improvement.

No new full performance series was run: recall ranking/excerpt/materialization code is unchanged, and the earlier strict 150 ms benchmark results and all failed samples remain intact. New checks cover bounded groups under lower read budgets, the original deadline during a later group, no reads/writes after cancellation, capacity messages at all ten consumer boundaries, wrapped production index overflow, raw policy siblings and real evidence capture. Independent review and parent integration/deployment remain outstanding; this is not release approval.

Targeted validation: 355 tests passed, zero skips, covering the thirteen affected suites plus context, startup, integration and access controls; Node 24.22.1, test concurrency 2, in-memory backends only. Typecheck and `git diff --check` passed. Failing-before regression logs and subsequent passing runs were retained in `/tmp/joshbot-p1-before.log`, `/tmp/joshbot-p2-before.log`, `/tmp/joshbot-p3-before.log`, and `/tmp/joshbot-final-targeted.log` in the implementation environment. These temporary paths are review evidence, not repository artifacts.
