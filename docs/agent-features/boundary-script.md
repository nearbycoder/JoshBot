# Boundary scripts

Create a private decline, defer or reduce proposal from an actual request and limit. The stance-specific deterministic template and commitment checklist remain available without model services. No sending, account change or relationship promise is performed.

Start: `/nobo-help agent boundary-script create Extra report this week | Existing delivery already fills the week`. The returned ID replaces `ID`; commands below follow `/nobo-help agent boundary-script`.

- `stance ID | decline/defer/reduce` sets the stance. Create starts with decline.
- `offer ID | ALTERNATIVE` records a real alternative; `date ID | YYYY-MM-DD` records a civil revisit date. Defer remains explicitly incomplete without it and never guesses availability.
- `scope ID | REDUCED-SCOPE` sets reduced scope. Reduce requires this or a concrete offer describing the scope. If the offer supplies scope it appears exactly once in the deterministic draft.
- `avoid ID | TEXT` records a prohibited commitment and returns its ID. `prohibition ID edit AVOID | TEXT` replaces it; `prohibition ID remove AVOID confirm` removes it.
- `edit ID | title/constraint/offer/date/scope | TEXT` replaces a field; `clear ID FIELD confirm` removes it, including `stance`. Missing fields remain visibly incomplete.
- `draft ID [page]` renders the script and checklist. The transparent lexical heuristic quotes only matched `will`, `guarantee`, `promise`, `definitely` words in offer/scope; it does not diagnose a conflict or agreement.
- `polish ID | warm/direct` makes one optional text-model call. The complete unsaved suggestion appears beside the deterministic template, or is rejected if both cannot fit. No pagination regenerates an inaccessible result.
- `list [page]`, `show ID [page]`, `export ID`, `delete ID confirm` retrieve/remove complete private records. Delete without confirmation only returns its confirmation command.

Pipe grammar uses `\|` and `\\` for literal pipes/backslashes; unsupported/trailing escapes and extra separators reject. Delimiter-adjacent spaces are trimmed; accepted content is preserved. Mentions/URLs stay plaintext.

Version 1 holds 12 scenarios, each with at most 20 prohibited commitments. Titles: 160 UTF-8 bytes; other text: 1000. New-content cap 32768 bytes, total 49152, export including envelope 24576. Quota admission projects every maximum-width revision explicitly; dates/timestamps are fixed width, and no draft versions are retained (zero is below the catalog maximum two). Render/polish are unsaved, so no growing completion payload is promised. Optional edits are new content. Full valid legacy data remains inspectable/deletable above admission limits, with no eviction.

Normal pages fit 3500 JS units; show retrieves every field with atomic IDs and escaped JSON lines. List uses insertion order and ten rows. Reopen page 1 if revision changes. Export is complete JSON and the explicit size exception.

Catalog budgets are generations/searches/contextReads/storeReads/storeUpdates = 1/0/0/8/4. Deterministic commands use one read or one update; optional polish uses at most two reads and one call, never a write. Its input <=16000 UTF-8 bytes, instructions <=4000; accepted raw output <=4000 units, each section <=1000 bytes, full response <=3500 units. A deterministic prefix above 2200 units rejects before generation. Output requires exact known references/quotes and no unknown fields; dates, scope and prohibited commitments must survive verbatim. Review semantics manually. No provider token ceiling exists in the service interface.

CAS validation is synchronous; IDs/time are allocated before it. Malformed state and failed optional output retain saved bytes. Optional results reread revision and signal so edits/deletion win. Original runtime ownership, receipts and deadline apply; an already dispatched write cannot be undone by cancellation. There are no source reads, background tasks or live verification.

Tests in `tests/agent-boundary-script.test.ts` exercise the catalog first example, exact-once alternative, missing date/scope, all edits/removal, lexical heuristics, Unicode quota and full final-child retrieval, optional schema failures, stale output and owner isolation through the real runtime/scoped store. Parent owns registration, independent integration review and release.

Every mutation binds the intended record snapshot before CAS retries. A same-record change rejects the older command with an inspect/retry message, including status, evidence, attempts and confirmed deletion. Unrelated-record conflicts retry safely; a deleted target is never recreated.

Persisted enum fields require exact strings: arrays, nested arrays and coercible objects are malformed. Reads, rendering, edits and even confirmed deletion preserve corrupt raw bytes for scoped recovery.
