# Bounded personal-context backend reads

Legacy owner indexes permit up to 200 records per selected kind. Previously, each record required a serial `backend.get`. Four populated legacy kinds required 800 serial record waits, even when the complete response was already partitioned into six bounded source groups. The optional batch method reduces those waits while preserving complete source retrieval and the existing source and runtime limits.

## Backend contract

```ts
getMany?(
  keys: readonly string[],
  maxValueBytes: number,
): Promise<readonly PromiseSettledResult<string | null>[]>;
```

The method returns already-settled aligned outcomes, not promises or deferred work. A fulfilled null means that the indexed record is absent. Type and size failures occupy their own rejected slot, with an `Error` reason. A transport failure rejects the aggregate because no complete response is available. Callers must not retry the failure through individual reads.

The default backend accepts 1–16 nonempty string keys, each at most 512 JavaScript code units, and an integer byte bound of 1–64,000. Requests outside those bounds fail before dispatch. Legacy retrieval always passes 64,000. A read-only Lua script executes one bounded command: for each key, it uses `STRLEN` before `GET`; absent keys yield aligned nulls, wrong types yield an explicit error slot, and oversized values yield a capacity slot without fetching the oversized value into the reply. The client validates the exact reply cardinality, slot shape, tag, null/string type and fulfilled byte size.

The legacy reader validates the complete index and every source ID before constructing record keys, sorts IDs as before, then awaits one batch at a time. It processes each settled slot in source order, applying the existing JSON, ownership/team/channel, indexed-ID, timestamp and projection checks. An earlier malformed JSON or indexed-ID mismatch therefore still precedes a later type or capacity error. No-getMany backends take the original serial loop, including its stop-on-first-error behavior. There is no batch-failure fallback, cache, hidden next-source prefetch, authorization skip, new source kind or additional logical context read.

Each successful script can return at most 16 × 64,000 = 1,024,000 raw value bytes (about 0.977 MiB), plus a bounded slot envelope. The size check and read are atomic within the script. Oversized malformed stored values cannot multiply raw allocations across 16 GET replies. Decoded JavaScript strings can use up to roughly twice the source UTF-8 bytes, and buffers, arrays, parsed objects, accumulated projections and garbage collection add memory. This is a raw value-response bound, not an RSS cap. Three admitted invocations can have at most three awaited batches in flight, or 3,072,000 raw value bytes, in addition to other existing source responses and overhead.

The existing 200-entry index bound, 64,000-byte record check, 16 MiB projected response bound, 32 MiB invocation bound, read budgets, admission limits and original deadline remain unchanged. Escaped JSON projection can still exceed 16 MiB even when individual raw records fit; that failure remains visible and preserves the previous consumer snapshot.

## Physical settlement

Each default batch is one physical Redis EVAL promise tracked by `contextRead`; the legacy caller supplies its original signal. Cancellation may end the logical wait, but the invocation permit remains held until the underlying Redis promise settles. No later chunk, group, generation or save starts after cancellation. Success, error and cancellation release each permit exactly once.

The installed `@redis/client` 6.3.0 implementation of `_executePipeline` uses `Promise.all` over individual command promises; `execAsPipeline` awaits that early-rejecting aggregate. Tracking only that aggregate would hide unfinished physical siblings after the first rejection. This implementation uses one Lua command rather than that pipeline. Plain MGET is also unsuitable because it returns null for a wrong-type key, hiding corruption as missing data.

Fresh service calls always dispatch fresh reads. An intervening edit, insert or deletion is visible to the next read; later chunks can see intervening writes. No atomic snapshot is promised across chunks or source groups. Authorization still precedes owner-index access, and existing bounded groups recheck it for each selected legacy source. Revocation between groups fails without overwriting an earlier saved snapshot.

## Correctness evidence

The final author run passed 124/124 focused context, performance, default Redis, runtime and startup checks with zero skips/cancellations; full TypeScript checking passed. The default backend tests ran against isolated loopback Redis 7.2.10 with persistence disabled. Existing CAS, receipt and TTL tests passed unchanged. No installs, provider calls, real Slack operations, production Redis queries, pushes or deployments were used.

Coverage includes:

- Sixteen 64,000-byte slots, 64,000/64,001-byte UTF-8 boundaries, aligned missing keys, WRONGTYPE distinct from missing, strict request/reply validation and transport rejection.
- All legacy kinds, owner/team/current-channel provenance, duplicate/invalid/201-entry indexes, deterministic source ordering, stale members, fresh later reads and writes between chunks.
- Twenty serial/batch first-error permutations covering malformed JSON, indexed-ID mismatch, invalid dates, type errors and oversized values; no serial retry after batch failure.
- Original deadline before/during/between chunks, raw permit retention through late success and late failure, independent outstanding invocations, no later source/save, and revocation between groups.
- Complete 1,500-record source parity and actual meeting-prep, morning-brief and weekly-review output and saved evidence parity. Only their generated UUIDs are normalized; full source arrays are compared without normalization. Byte arrays, logical read counts and state writes are unchanged.
- Error in a later chunk, reduced logical context-read budgets, projected 16 MiB rejection and invocation 32 MiB rejection, all preserving the previous actual consumer snapshot.

Transport commit: `f98e766a342ac02f2f362a4b8a9bc4cd805c40b6`. Explicit transport-test return generic: `7bcbe1e498f674090eff3011fc72172f93807b32`. Legacy integration and parity tests: `532f1e10b29ea82fd24fd48e43265a50aafa209d`. Final focused ceiling/failure tests: `929ea96c1aa122774785b6feeb4bedcad90ae134`. The test generic correction was a preparation type error, not a timed sample or a reason to discard measurements.

## Scoped actual-backend measurements

All raw results, complete per-file source manifests, driver source and the fixed plan are in [`scripts/bench-agent-context-batch.results.json`](../../scripts/bench-agent-context-batch.results.json). Earlier read-only fake-latency/pipeline/Lua experiments remain there as separate exploratory records; none replaces an implemented-path measurement. Historical release benchmark scripts and results were not edited.

The plan was fixed before launch: eighteen fresh workers, one before/after pair for each of four workloads at 0 and 2 ms added read latency, plus a six-group pair at 10 ms. There was no warmup, discarded sample or rerun. The 0/2/10 ms conditions are distinct single pairs, **not three replicates at one condition**, and not a release-gate timing series. These controlled local source snapshots exclude the parent's concurrent helper/UX changes.

Node 24.22.1, 1 GiB heap, Linux x64, actual default Redis backend and actual bounded source/consumer code were used. The isolated Redis 7.2.10 server had persistence disabled. Each worker had concurrency one and accepted one complete request. Fixture construction/imports/seeding precede the active wall/Node-CPU interval. Whole-process RSS and Linux VmHWM include those earlier allocations, with nothing subtracted. No Redis-server RSS was measured. Some process peaks exceed the release benchmark's 256 MiB threshold; these TS-loaded, fixture-seeded diagnostics are not that release gate and do not establish a production memory pass.

Per-worker UTC and host load were not captured and remain explicitly null in the evidence. Filesystem timestamps provide sequence-window proxies only: manifest write **2026-10-23T07:43:08.723008Z**, final result append **2026-10-23T07:43:55.989464Z**. They are not exact worker or active-request boundaries. Host load captured **after** this sequence, at **2026-10-23T07:46:28.514145Z**, was 42.9365 / 37.8755 / 25.4487 (1/5/15 minutes), 32 logical CPUs; it cannot establish each worker's contention. The shared host was not proven quiet.

The before library manifest SHA-256 is `ed34c1efff1538c6a4ec299086c5b6e832f2c16b01dd2bf0a8502bebb75a679b` (original `a280238` snapshot); after is `667d647f8cbe649b8cc7b57ad5fb0116f82a9cc3d0d571a1667ae5c79af4e8a9` (product source at `532f1e1`). Individual input hashes and the measurement-driver hash are in the evidence. Hashes for each full projected source array, normalized saved-state array and normalized reply match across every pair.

Each following sequence lists **six-group / meeting prep / morning brief / weekly review**, in that order. Milliseconds are individual observed wall times, never statistical accepted-request p95s.

- **0 ms added latency:** 662.301 / 287.881 / 430.164 / 359.862 before; 425.888 / 379.425 / 453.427 / 257.596 after. Meeting prep and morning brief were slower after batching in this condition.
- **2 ms added latency:** 2,937.299 / 2,033.155 / 1,492.747 / 687.147 before; 544.972 / 333.052 / 389.971 / 259.098 after.
- **10 ms added latency, six-group only:** 9,911.326 before; 1,113.285 after.

The 2/10 ms timers precede each awaited GET, record batch, index and fake authorization decision. They model additional dependency latency, not measured WAN RTT; actual CAS writes are un-delayed. Observed phase medians/p95s are recorded per sample and include real Redis response time. Fake authorization decisions remain four/two/two/one; no real policy-provider/Slack calls occur.

JSON-equivalent response arrays remain:

- Six-group counts `[300,400,200,200,200,200]`; bytes `[3673741,2556111,2512491,4941091,4952291,4939891]`; total **23,575,616**; source SHA-256 `6b56af03925f79f0073b169f34a4f76db51823bcab13548b56c23f7ce572f332`.
- Meeting prep and morning brief counts `[200,0,200,200]`; bytes `[7258161,2,7427691,14653891]`; total **29,339,745**; source SHA-256 `df001af8d6498f4994f72be2ecbd330317d45eae44b8fbe4da9763c352038d0e`.
- Weekly counts `[300,100,200]`; bytes `[10887541,3629781,7427691]`; total **21,945,013**; source SHA-256 `00a8eb9d3254f1c9380ee0218966865461a1cbe1777f5ce333944b6b2d1e6e3c`.

Six-group uses 52 record scripts plus four index scripts and seven ordinary GETs: **63 Redis wire requests versus 811** previously. Redis commandstats still reports 807 total GETs because 800 run inside Lua, plus 800 new STRLEN operations, 56 EVALs and unchanged four SCARD/four SMEMBERS. Logical record retrieval is unchanged; Redis server work increases to enforce the raw response cap. Sequential modeled read phases, including fake authorization, fall **815→67**.

Actual total wire requests, including a successful consumer CAS but excluding setup/INFO/QUIT, are **811→63 / 409→35 / 406→32 / 208→21**. Record-batch counts are **52 / 26 / 26 / 13**; index queries and auth decisions remain **4 / 2 / 2 / 1**. A saved meeting or weekly review adds one EVAL containing its unchanged GET/SET CAS; therefore commandstats GET is 407 for meeting and 207 for weekly, versus logical record/state GET equivalents 406 and 206. Full internal counts are retained per sample, rather than conflated with wire requests. There are no request IDs in these workloads, so no receipt writes occur during the measured interval.

Node CPU at 0 ms was **617.991 / 301.789 / 361.958 / 304.924** before and **440.900 / 310.118 / 367.333 / 293.351** after. Peak process RSS (MiB) was **276.984 / 237.004 / 242.848 / 257.117** before and **279.637 / 207.375 / 232.098 / 206.664** after. Six-group peak rose at both 0 ms and 10 ms (253.137→257.004 MiB at 10 ms). Neither memory nor CPU improvement is universal; the earlier immediate fake backend also measured 104.038→104.404 ms, with no wall improvement.

Redis server CPU is measured separately as INFO user+system CPU deltas across the active request and INFO boundaries. At 0 ms it was **23.817 / 11.822 / 12.222 / 10.308 ms** before versus **30.171 / 36.289 / 37.046 / 21.809 ms** after. These deltas include server background/idle scheduling work and boundary overhead over differently long intervals. They are not per-command CPU costs or a claim of greater server efficiency. All 2/10 ms CPU/RSS samples remain in the raw evidence as well.

This evidence supports reducing sequential round-trip waits for latency-bound retrieval. It also records guarded-script overhead, variable process RSS, and slower zero-added-latency consumers. The integrated release regression gate and independent review remain separate parent-owned checks.
