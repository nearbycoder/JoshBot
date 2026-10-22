# Owned personal-agent context

For commands and examples, start with the [personal-agent guide](README.md). This reference describes the source/runtime contracts deployed with the original twenty personal agents in PR #58: main `7a30db374bf3df702af5e28413468a04dc571862`, Railway deployment `a588ccd9-57e2-4518-b8f0-f2af93433b25` (`SUCCESS`). See [verified release status](../personal-agent-expansion.md). This deployment evidence does not cover the additional fifty-agent expansion.

`services.readContext(kinds)` reads the authenticated caller's existing sources. `readAgentOwnedContext` lives in `lib/agent-features/context.ts`; `services.ts` wires production dependencies. The existing `readAgentToolboxContext(backend, owner, kinds?, signal?)` export remains available.

The adapter is read-only. It does not migrate records, delete stale index entries, query Slack, fetch artifact URLs, execute models, read channel history, or read shared channel memory. Empty sources and failed sources are different: missing records return no items; unavailable providers, malformed eligible records and exceeded complete-read limits reject the request. Production-facing source errors identify the source without exposing provider error text; the original error remains the error's `cause`.

## Exact coverage

| Kind | Source and boundary | Stable ID | Bound |
| --- | --- | --- | --- |
| `note` | Caller workspace/user toolbox `notes` | `toolbox:notes:<entry-id>` | 100 entries |
| `goal` | Caller workspace/user toolbox `goals` | `toolbox:goals:<entry-id>` | 100 entries |
| `habit` | Caller workspace/user toolbox `habits` | `toolbox:habits:<entry-id>` | 100 entries |
| `journal` | Caller workspace/user toolbox `journal` | `toolbox:journal:<entry-id>` | 100 entries |
| `bookmark` | Caller workspace/user toolbox `bookmarks` | `toolbox:bookmarks:<entry-id>` | 100 entries |
| `event` | Same caller's `calendar` feature namespace, confirmed import only | `calendar:cal_<24-hex>` | All 100 possible saved events |
| `memory` | Same caller's `memory-review` feature namespace, currently eligible confirmed cards | `memory-review:mr_<UUID>` | 100 cards before helper deduplication/filtering |
| `follow-up` | User index plus creator/assignee ownership AND signed current channel | `follow-up:<record-id>` | Entire index must fit 200 IDs |
| `reminder` | User index plus record owner AND signed current channel | `reminder:<job-id>` | Entire index must fit 200 IDs |
| `monitor` | User index plus record owner AND signed current channel | `monitor:<job-id>` | Entire index must fit 200 IDs |
| `digest` | User index plus subscription owner AND signed current channel | `digest:<subscription-id>` | Entire index must fit 200 IDs |
| `artifact` | Not connected: existing files have no workspace/channel provenance | None | No enumeration or file/URL reads |

The theoretical combined maximum is **1,500 items** (500 toolbox + 100 calendar + 100 memory + 800 legacy records). There is no final item-count truncation. A selected source exceeding its bounds fails instead of returning a partial list. Individual features may select smaller subsets: meeting prep examines 200, morning brief 500, weekly review 1,000, recall 1,000 (with a separate text budget), and automation audit 80. Those feature limits are independent of this adapter.

Requested kinds alone are loaded; `[]` performs no source I/O, omitted kinds requests all supported sources, and duplicate kinds do not duplicate reads. Final order is events first, then other items, with each group ordered by due date/instant ascending, undated records last, then actual update time descending and source ID ascending. Date-only deadlines sort by their literal label, without inventing a midnight timestamp. This keeps the complete imported agenda ahead of a commitment backlog. Automation-only reads put the earliest known next occurrences first. The compatibility toolbox-only export sorts by actual update time descending then ID.

Toolbox namespaces retain the previous 2,000,000-byte read ceiling and 100-entry bound. Legacy records have a 64,000-byte ceiling; feature stores retain their 512,000-byte ceiling. Toolbox and legacy titles/text are capped at 300/12,000 characters; toolbox metadata retains the dated source fields independently of text excerpts and includes `textTruncated` / `titleTruncated`. IDs are never shortened or derived from titles, array positions or content. Calendar intervals are never truncated, shortened, inferred from text, or filtered to a fabricated horizon.

## Legacy ownership and unavailable sources

Existing legacy jobs and follow-ups generally lack `teamId`. A user-only index does not prove workspace ownership. These reads therefore require all of:

1. A validated workspace/user supplied by the signed Slack invocation.
2. `owner.channelId` from that same invocation (never user-provided command text).
3. A successful existing `evaluateNoboAccess` policy check before owner-index reads.
4. The indexed record's actual owner matching the caller (creator OR assignee for follow-ups), and its actual channel equaling the signed current channel.
5. Any explicit `teamId` matching the caller. A contradictory or null team value never receives the legacy fallback.

Even records with a matching `teamId` remain restricted to the current channel in this version. Without a current channel, all four legacy kinds return no eligible records. No channel-member lookup or arbitrary channel authorization is attempted. A channel digest contributes only the owner's subscription metadata/focus; no channel messages or digest body are read. Monitor observations, fingerprints and error payloads are excluded.

The exact owner indexes are `follow-ups:user:<user>`, `schedules:user:<user>`, `monitors:user:<user>`, and `channel-digests:user:<user>`. Production uses a read-only Lua operation that atomically checks `SCARD <= 200` before `SMEMBERS`. Record reads use the corresponding existing `follow-ups:record:`, `schedules:job:`, `monitors:job:`, and `channel-digests:subscription:` prefixes. IDs are validated before key construction. No global `SCAN`, `KEYS` command, due-job index, channel index, or unbounded owner-index read is used. A missing indexed record is skipped as deleted, without changing its index. Every invocation reloads current content and reevaluates ownership.

The 200-ID bound applies **before** channel/ownership filtering: an owner with a larger historical index receives an explicit source failure even if fewer than 200 records would be eligible. There is no pagination/completeness field in the shared contract, so silently selecting a subset would give misleading source deletion or automation inventory results.

Legacy `slack-memory:user:<user>` contains strings without workspace/channel provenance or stable record IDs. It is intentionally **not read**, even if the Slack user ID matches. `memory-review import` therefore has no legacy import candidates in this adapter. Users can explicitly `capture` a sourced fact and confirm it; approved cards are available to the other features. Passing `featureId: "memory-review"` suppresses the approved-card adapter entirely so those cards cannot feed back into legacy import.

Existing artifact APIs filter by user but enumerate the artifact directory, lack workspace/channel ownership, and sometimes treat filesystem failures as an empty result. They do not meet this adapter's tenant/completeness requirements. No artifact path is opened and no raw/preview URL is fetched. Supporting artifacts later needs a bounded workspace/user index and a reader that validates metadata ownership, filesystem containment/symlinks, limits and errors. Supporting broader legacy memory or jobs requires trustworthy provenance from their owning core modules; no tenant is inferred or migrated here.

## Field semantics

- Toolbox notes use the body plus structured data for searchable text. Existing bookmark URLs are exposed as `sourceUrl` only when HTTP(S) and free of URL credentials; they are never fetched.
- Goals preserve numeric `target`/`current`, available dated `{ at, value, note }` history, and date-only `due`. Absent an explicit status, finite validated `current >= target > 0` means `done`; a lower current means `open`. Numeric strings are rejected, not coerced. Neither reaching a target nor `updatedAt` manufactures a `completedAt`. Weekly review therefore cannot claim a dated completion from a numeric total alone.
- Habits preserve and deduplicate their original UTC-labelled `YYYY-MM-DD` days, target and creation time. An absent days array stays unknown; an explicit empty array stays empty. Journal metadata preserves `day`, `mood`, `wins` and `lesson`, and text includes the original body. Invalid dates/numeric values fail visibly rather than becoming fabricated activity.
- Follow-ups include both open and completed records. `done` normalizes to `completed`; `completedAt` is copied only when recorded. `updatedAt` is the latest actual creation, completion or edit timestamp. The task is included without copying arbitrary source-thread excerpts or raw scheduler errors.
- Automation purpose comes from reminder task, monitor query, or digest focus. `metadata.nextRunAt` and `dueAt` are the stored next occurrence; `schedule`, `cadence`, `intervalMs` and `timezone` derive from actual schedule fields. Destination identifies the signed current channel. A retained job with no status is active because legacy runners remove completed/cancelled jobs. Explicit unsupported status becomes unknown. Unknown cadence/timezone/next occurrence stays unknown; the caller timezone is not substituted for a missing schedule timezone.
- Automation creation time remains `metadata.createdAt`, never a last edit/run. `updatedAt` requires an actual source edit field. Monitor `lastCheckedAt` is exposed as `lastRunAt` with `lastRunMeaning: "monitor check; delivery outcome unknown"`. No `lastRunStatus` is invented, and an advanced next run is never evidence of successful delivery.
- `readCalendarEventContext(calendarScopedStore, callerTimezone)` supplies all confirmed events, including past events, transparent events and zero-duration instants. `metadata.startAt/endAt` and `dueAt` are UTC instants; ends are exclusive. `allDay`, `busy`, original all-day `startDate/endDate`, source timezone and imported UID remain intact. All-day conversion uses the resolved caller timezone, including DST. Preview events are excluded by the calendar helper. A malformed calendar fails instead of implying free time.
- `readApprovedMemoryContext({store: memoryReviewScopedStore, now, timezone})` reevaluates confirmation, freshness, conflicts and expiry on every read. It does not call the general context service. Its provenance/status/metadata and stable IDs are preserved.

## Production wiring and cancellation

The integrated Slack route in `lib/slack-commands.ts` starts the combined run/120-second deadline signal **before the initial access-policy read**. It races that read and dispatch against the signal and passes the original deadline into `handleAgentCommand` through `timeoutSignal`; startup does not receive a fresh 120-second allowance. Direct entry through `index.ts` creates a deadline before backend initialization and preference loading when no ingress deadline is supplied.

`index.ts` resolves one request time and races every awaited startup step, including the dynamic services import, against the active signal. Late resolution/rejection is consumed and cannot proceed to feature execution or receipt writes after cancellation. The same resolved caller timezone/time/signal and feature ID are passed to `createAgentFeatureServices`; preferences are not fetched again. Help bypasses feature storage and generation, while the signed Slack route still enforces access policy. All non-help commands require the existing Redis backend, including stateless consumers.

`contextRead` guards each adapter, policy/index/record read, and sibling-store read with active cancellation, before starting and after resolving. Pending I/O stops being awaited immediately on abort; it cannot trigger subsequent source work. Providers that do not support cancellation may finish their already-started read, but the result is discarded. The adapters receive read-only sibling stores whose `update` rejects. Generation remains text-only/tool-free; public search uses the existing Exa provider with 1–8 results and the existing runtime budgets.

Tests can inject `AgentContextAdapters` (owner indexes, channel policy, calendar and approved-memory helpers), `createProductionContextAdapters`' Redis/access getters, and startup dependencies. No test needs Slack, models, Exa, production Redis, a filesystem artifact directory or local Redis.

## Runtime and consumer contracts

`registry.ts` registers all 20 features; `index.ts` dispatches commands through the scoped runtime. `/nobo-help agent` and the Home Personal agents view expose the catalog. Context-consuming help includes the connected/unconnected source boundaries, and memory-review help states that legacy import has no candidates. Missing references always mean absent from the current authorized snapshot, not proven deletion across all sources.

The runtime namespaces feature JSON by workspace, user, and feature, with a 512,000-byte per-value ceiling. Features impose lower UTF-8 quotas and lifecycle reservations; their guides describe retention and cleanup. Atomic `store.update` callbacks are synchronous and side-effect-free because compare-and-swap retries can rerun them. Generation is text-only with no tools, capped at eight calls per invocation; search is capped at six calls with 1–8 results each. Command text is limited to 48,000 characters and replies to 28,000, with stricter per-feature limits. Request receipts retain fingerprints/status for 24 hours without storing private input or reply text.

Preserve truthful source representations when changing consumers. Morning brief accepts the calendar adapter's normalized all-day timestamps with original civil dates; day planner treats equal-endpoint timed events as nonblocking instants; handoffs preserves date-only goal deadlines. Automation audit trims bounded text after clipping and validates a new snapshot before updating saved history. Further review fixes do not justify changing source dates or inventing metadata to fit a consumer.

## Verification process

Use Node 24 from the repository root. These commands describe local checks, not a claim that the current revision has passed final acceptance:

```sh
node --import tsx --test tests/agent-context.test.ts tests/agent-startup.test.ts tests/agent-integration.test.ts
npm run typecheck
git diff --check
```

Tests exercise actual toolbox-goal/meeting, weekly-review, memory lifecycle and full-calendar/planner flows using in-memory storage, plus exact source metadata, ownership mismatches, requested-kind filtering, changed/deleted sources, bounded deterministic reads, malformed data, provider failures, approved-memory import isolation, read-only stores, active read cancellation and explicit/accelerated-deadline startup cancellation with late results producing no feature work or writes.

After remaining fixes and independent reviews, run the full tests, typecheck, build, and dependency audit as described in the [expansion validation process](../personal-agent-expansion.md#verification). Earlier results do not certify later edits. These checks do not establish live Slack delivery, provider output quality, or production deployment.

## Capacity handling in the foundation follow-up

This follow-up is pending parent integration and independent release review; the deployed evidence above remains unchanged. The service method and source fields are unchanged. The default admission is still 3 global / 2 per owner, with one original 120-second deadline, lower-only budgets of 8 generations / 6 searches / 8 context reads / 64 state reads / 32 updates, 2,000 items per response, 16 MiB per response and 32 MiB per invocation.

`readBoundedContext(context, kinds)` in `lib/agent-features/bounded-context.ts` accepts an explicit unique kind list and **runtime-wrapped** services plus the invocation signal. It partitions that list into at most six sequential service calls: note/goal/habit; journal/bookmark/artifact/memory/event; follow-up; reminder; monitor; digest. Each group consumes the normal runtime read and byte budgets. The helper additionally caps the merged result at 2,000 items, restores the production event/due/update/ID order, and returns nothing on a read failure. It does not retry a failed broad read, reset the deadline, cache sources, serialize the combined result, truncate records, or bypass channel authorization. It retains source objects and one merged array of references. Smaller feature read budgets still apply and may reject before the next group starts.

Toolbox namespaces are at most 2 MB before projection; grouping at most three leaves room for duplicated structured metadata/text under the unchanged response limit. Each legacy kind gets its own response because a purpose can appear in both text and metadata. This is a bounded partition, not a promise that arbitrary future adapters or all combined sources fit. The runtime still validates every response and the invocation total; more than 32 MiB fails before a complete result is returned. Existing feature-specific ranking, excerpt and displayed omission limits remain in force after the complete source read.

Handoffs, meeting preparation, weekly review, automation review, morning brief and project briefs use this helper. Handoff refresh/resume request the kinds saved on the selected references; new recognized production IDs also narrow retrieval, while unknown adapter IDs use complete discovery. Project refresh continues to derive kinds from its linked references. Recall keeps its existing read/ranking path and `--kind` / qualified-reference narrowing.

`AgentContextCapacityError` distinguishes runtime size/structure/total limits, oversized source records and oversized production owner indexes from temporary outages. `contextCapacityMessage(error, recovery)` inspects at most eight error/cause levels and exposes only typed capacity messages; unrelated provider details remain private. All ten existing context consumers preserve that distinction. Source/saved-state data are unchanged on these failures; request receipts, when supplied, retain their usual deduplication semantics.

Recovery examples:

- `/nobo-help agent handoffs sources --kind note Atlas`; `sources [query]` still defaults to all kinds. Queries filter after reading and cannot solve an oversized read alone. `show <handoff-id>` reads saved snapshots without sources; `resume` labels snapshots unverified if its selected-kind read fails.
- `/nobo-help agent automation-audit review --kind monitor` (or `reminder` / `digest`); `review` still requests all three. Scoped snapshots retain their scope through `show` and refuse comparisons against a different scope.
- `/nobo-help agent morning-brief settings sources notes`, then `/nobo-help agent morning-brief brief`.
- `/nobo-help agent project-briefs sources note`; `unlink <project-id> <kind> <source-id>` can reduce linked kinds before the next `brief`. `show <project-id> brief` retains the prior snapshot.
- `/nobo-help agent recall search Atlas --kind note`; reopen the exact returned `kind/id` reference. Date/query/result-count filters apply after reading.

If a single selected source is itself too large, reduce that source in its owning tool. For example, `/nobo-help tools notes list`, then `/nobo-help tools notes edit <note-id> | <shorter body>`; `/nobo-help tools bookmarks list`, then `export <bookmark-id>` before `delete <bookmark-id> confirm`; or `/nobo-help agent calendar list`, then `remove <event-id> confirm` for an unneeded event. These changes are explicit user choices, never performed automatically. Deleting unrelated saved handoffs/reviews cannot reduce source-read bytes. A weekly date or meeting query change also cannot shrink their fixed source reads. Their saved `show` paths remain available.

Initial policy access now tracks each of the five physical Redis set reads. A fail-fast sibling rejection does not release a personal-agent permit while other reads remain pending. Cancellation still stops the caller promptly; non-agent access checks keep fail-fast errors. Tests cover partial failure before/after abort, another owner's spare slot, blocked receipts, exact release and late rejections.
