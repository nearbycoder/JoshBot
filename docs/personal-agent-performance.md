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

Measurements use Node24.22.1 and seed20261022, synthetic bounded services, production Vite SSR bundling, and an isolated fake Slack API for server startup. No live inference, Slack messages or production records are used. Run `node scripts/bench-agent-features.mjs` with Node24. Full-server and feature-runtime measurements must be interpreted separately. The benchmark report and maximum-context/mixed-load evidence are being completed in a follow-up commit; the selected admission limits were tested against the same three 32-command recall bursts as the baseline.

Initial baseline: all96 commands accepted, accepted p95 1,254–1,287ms, loop maximum1,348–1,411ms, feature RSS peak278–279MiB. With8 permits:24 accepted/72 rejected, p95 249–266ms, loop253–265ms. With4:12 accepted/84 rejected, p95158–206ms, loop147–190ms. With3:9 accepted/87 rejected, p95117–140ms, loop110–127ms, feature RSS peak141–142MiB. Lower accepted latency is **not a throughput improvement**: overload work is explicitly rejected. The150ms event-loop target is a local regression target, not a production latency guarantee. All samples, including noisy JIT/GC samples, are retained in the report.
