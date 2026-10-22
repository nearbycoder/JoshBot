# Session handoff packets

`handoffs` saves your explicitly supplied task progress and selected personal source excerpts so you can carry them into a new conversation. It does not restore a running model or tool session, execute next steps, send messages, or verify that reported work actually happened. Everything is private and deterministic; no generation or web search is used.

The parent integration must register this module before the following entry point is available:

```text
/nobo-help agent handoffs <command>
```

## A complete flow

The examples below omit `/nobo-help agent handoffs`. Replace `<handoff-id>` with the full `hf_…` ID returned by capture or list. Source IDs come from your runtime's owner-context adapter, so use the actual IDs returned by `sources`.

```text
sources login
capture Fix the login loop | done: Reproduced in a local fixture; added a regression test | next: Review cookie handling | questions: Should existing sessions expire? | constraints: No production changes
list
update <handoff-id> | sources: note:login,goal:onboarding
resume <handoff-id>
update <handoff-id> r2 | done: Cookie fix and regression test pass | next: Request review | questions: -
revisions <handoff-id>
show <handoff-id> r1
close <handoff-id>
list closed
delete <handoff-id> confirm
```

`resume` returns a compact, copyable packet containing the objective, completed work, open questions, next steps, constraints, source references, and freshness checks. It never modifies the handoff. Closed packets can still be resumed as **reference only**; continuing editable work requires a new capture.

## Commands

| Command | Behavior |
| --- | --- |
| `help` | Syntax and a usable example; no storage or service access. |
| `capture <objective> \| done: … \| next: …` | Save revision 1. Explicit `done` and `next` fields are required; `-` means none. Optional fields: `questions`, `constraints`, `sources`. |
| `sources [query]` | Discover owner source IDs by case-insensitive substring matching over their ID, kind, title, and saved-length excerpt. Shows up to 30 matches; no automatic linking. |
| `list [open\|closed\|all]` | List packets in reverse capture order and show serialized UTF-8 storage usage plus reserved closing space. Defaults to open. |
| `show <id> [rN]` | Show the current or a retained historical snapshot. Does not read live sources. |
| `resume <id>` | Show the current packet and check only its selected references against the current owner-context response. |
| `update <id> [rN] \| <field>: …` | Replace only specified fields. Supplying `rN` requires that revision to still be current. Without it, updates still reject changes that race the update operation. |
| `revisions <id>` | List retained revision numbers, timestamps, status, and changed fields. |
| `close <id>` | Add a closed revision. Repeating close has no effect. History remains readable and occupies storage. |
| `delete <id> confirm` | Permanently remove the packet and all its retained revisions from this feature's state. |

Editable fields are `objective`, `done`, `questions`, `next`, `constraints`, and `sources`. Use `-` to clear any field except the objective. Source IDs are comma-separated, exact, and case-sensitive. `sources: …` replaces the complete reference list and refreshes every listed snapshot; `sources: -` removes references. A source refresh that finds identical snapshots does not create an extra revision.

Separate fields with `|`. A literal `|` cannot appear in a value; use semicolons or newlines to separate items within a field. Duplicate or unknown fields, oversized values, and control characters are rejected. Fields are plain text, not executable commands. Full handoff IDs are required to avoid ambiguous prefix matching.

## Source freshness and limitations

- Only sources explicitly selected by ID are persisted. Unselected context is never added to a packet. No URLs are fetched, and metadata beyond source identity, text, dates, status, and reference URL is not used.
- Snapshots retain a title, bounded excerpt, source ID/kind, optional URL/update time, and a SHA-256 fingerprint. The fingerprint covers the full accepted title/text, kind, update time, due time, status, and URL; changes beyond the excerpt are detected too.
- `STALE` means the provider's source content or relevant metadata changed since the saved snapshot. Resume keeps the old excerpt visible instead of silently merging newer material. Review the current source, then use `update … | sources: …` to refresh it explicitly.
- `MISSING/UNAVAILABLE` means a reference was not returned by the current owner-context read. This can mean removed, inaccessible, or omitted by the adapter's bounds; it is not proof of deletion. Resume still shows the saved excerpt.
- An unchanged source whose update timestamp is at least 30 elapsed days old gets `STALE AGE`. This is a review heuristic, not a correctness judgment. Missing update dates produce `AGE UNKNOWN`; future dates produce `AGE UNVERIFIED`. Even recent unchanged sources are not guaranteed correct.
- Context-provider failures produce an `UNVERIFIED` resume packet with saved progress intact. Invalid or ambiguous individual sources are marked `UNVERIFIABLE`. Capture/update with selected sources fail without writes if any requested source is missing, ambiguous, malformed, oversized, or unavailable.
- Quotes and source excerpts are untrusted reference data. Slack mention markup is escaped, and no content is passed to a model or executed. Copying into a separate model conversation does not turn those excerpts into trusted instructions.
- All timestamps are stored as UTC ISO instants and displayed using the supplied caller timezone. Source `updatedAt` must include `Z` or a numeric offset. Source `dueAt` also accepts a real calendar date in exact `YYYY-MM-DD` form, including the date-only deadlines returned by the personal toolbox goals adapter. Calendar deadlines are validated for month/day and leap years, retained as calendar-date strings for fingerprinting, and never assigned a timezone or converted to midnight. A changed deadline, or a change from a date-only deadline to an explicit instant, makes a reference stale even when its text/update time is unchanged. Impossible dates and local timestamps without an offset are rejected. No server-local timezone is assumed.

## Bounds and retention

The feature keeps at most **20 packets**, including closed packets, and the **last 8 full revisions** of each packet. Older revisions are dropped when a real update or close adds a ninth revision. Whole packets are never silently evicted; delete one explicitly when storage is full. There is no automatic expiration or background job. No-op updates do not consume a revision. Revision numbers remain monotonic after trimming.

The entire stored JSON value **plus space reserved to close every open packet must remain strictly below 480,000 UTF-8 bytes**, leaving headroom below the shared store's 512,000-byte maximum. Byte usage is measured on `JSON.stringify` output with `Buffer.byteLength(…, "utf8")`, so multibyte Unicode, JSON escaping, source snapshots, and every retained revision count. The byte quota can be reached before the packet/revision count limits. Each atomic capture/update checks the latest state, including simultaneous writes, and rejects the whole change with deletion guidance if it would exceed the quota; saved progress is left untouched.

Closing adds a full final revision, so capacity is reserved for its exact serialized growth (including history trimming) when capture/update is accepted. The reserve covers **all** open packets; they can be closed in any order at quota. Show/resume remain read-only. New progress or source refreshes may still require space for another revision. Closing keeps history and may not reduce byte usage. Use `list all` to inspect usage, copy needed packets with `show` or `resume`, and run `delete <id> confirm` to free their entire history. The quota never silently discards additional history or whole packets.

Each packet accepts up to 6 sources. Objective length is 240 characters; completed work and next steps each 1,000; open questions and constraints each 800. Commands are limited to 8,000 characters. Source excerpts are limited to 500 characters and titles to 140, with visible truncation notices. Accepted provider input is limited to 10,000 items, 100,000 text characters, 2,000 title characters, 200 status characters, and 512 URL characters per source. URLs must be HTTP(S) without embedded credentials. Oversized/invalid individual items cannot be selected. Source IDs must match `[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]{0,127}` and be unique across kinds.

Output escaping can require additional truncation per displayed field; total replies fit below 28,000 characters. Saved data remains intact. Open revisions stop at 999,999, reserving revision 1,000,000 for close; further work needs a new packet. Corrupt or unknown-version persisted state is rejected without automatic reset or partial repair; the runtime owner must recover it. There is no bulk export command; `show`/`resume` provide copyable text and explicit deletion handles retention.

## Parent integration requirements

1. Import the named `feature` or default export from `lib/agent-features/handoffs.ts`, register the exact `handoffs` ID, route `/nobo-help agent handoffs …`, and expose its help/Home entry. All responses must remain private; the module returns text only.
2. Supply the shared `AgentFeatureContext` with workspace/user/feature-scoped storage, caller identity, a valid `now`, and an explicit caller timezone. The only local store key is `packets-v1` (schema version 1). `store.update` must provide atomic compare/retry semantics; callbacks are synchronous, side-effect-free, and leave their input unmodified. The feature's measured quota and closing reserve keep accepted state below the shared 512,000-byte value limit without a contract/schema change.
3. Implement `services.readContext()` using authorized caller-owned data. Source IDs must be stable and unique across kinds, satisfy the syntax above, and be exposed to the caller by `sources`. Prefer explicit `updatedAt` instants; date-only goal `dueAt` values can pass through unchanged. Missing/truncated adapter coverage must not be interpreted by the parent as definitive source deletion. No `generate` or `search` adapter is needed for this feature's operations.
4. Keep private delivery, identity/access checks, request deduplication, and durable persistence in the shared runtime. Repeated captures intentionally create different IDs; Slack request retries need parent deduplication. No feature-level request ledger, external writes, session restoration, account changes, or shared contract changes are required.
5. Use the shared runtime's 120-second deadline, promptly abortable service wrappers, and signal-guarded store. Handoffs makes zero generation/search calls and at most one owner-context read per invocation. Its pre-write/post-context cancellation checks also discard late source responses; the shared runtime remains responsible for stopping the wait promptly and guarding storage writes after cancellation.

Targeted verification uses `node --import tsx --test tests/agent-handoffs.test.ts`, plus `npm run typecheck` and `git diff --check`. Tests use only fake storage/context services, including delayed/cancelled provider responses, concurrent edits/close/delete, retryable transactions, malformed storage, DST/timezone boundaries, source failures, and retention bounds. Quota tests cover CJK, emoji, JSON-escaped lone surrogates, revision growth, concurrent captures at capacity, deletion recovery, and closing every accepted packet without an oversized write.

The cross-feature regression creates and updates real toolbox goals and reads them through the actual parent-owned `readAgentToolboxContext` adapter with an in-memory backend. It covers discovery, capture, deadline-change staleness, explicit refresh, and retained history. Separate checks isolate `dueAt` changes from text/`updatedAt`, preserve the difference between calendar dates and instants across caller timezones, and reject malformed/impossible deadlines. In an isolated feature checkout without the shared adapter, point this test at the parent's existing file; do not copy shared files into the branch:

```sh
HANDOFF_TEST_CONTEXT_ADAPTER=/absolute/path/to/parent/lib/agent-features/context.ts node --import tsx --test tests/agent-handoffs.test.ts
```

After parent integration, the test imports the local adapter automatically and needs no override. The adapter test uses only fake backend reads; it never connects to Redis or calls production services.
