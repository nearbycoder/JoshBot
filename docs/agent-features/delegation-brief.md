# Delegation brief

Prepare a private request with observable outcomes, recipient labels, decision rights, in/out scope, resources, acceptance tests and civil-date checkpoints. The deterministic completeness audit identifies missing boundaries. Nothing assigns work or contacts the recipient.

Start with `/nobo-help agent delegation-brief create Review onboarding | Reviewer | Find the three largest sources of confusion`. Replace `ID` below with the returned brief ID. Commands follow `/nobo-help agent delegation-brief`:

- `scope ID | in/out | TEXT`, `resource ID | TEXT`, `checkpoint ID | YYYY-MM-DD | TEXT` add entries with stable IDs.
- `authority ID | TEXT`, `done ID | TEXT` set decision rights and handoff acceptance tests.
- `draft ID [page]` renders the complete unsent request and missing-field audit.
- `edit ID | title/recipient/outcome/authority/done | TEXT` replaces a field; `clear ID FIELD confirm` removes it.
- `entry ID edit ENTRY | in/out/resource/checkpoint | YYYY-MM-DD-or-- | TEXT` replaces an entry; use `-` for a non-checkpoint date. `entry ID remove ENTRY confirm` removes it.
- `accept ID confirm` records your report of acceptance locally; `unaccept ID confirm` clears it. Neither verifies agreement. Any content edit invalidates recorded acceptance.
- `polish ID` optionally sends entered fields to the configured text model once. Output is unsaved and must contain every original field verbatim inside its referenced suggestion. Review added wording for meaning; validated references do not prove truth.
- `list [page]`, `show ID [page]`, `export ID`, `delete ID confirm` inspect and remove complete records. Without `confirm`, delete only displays its exact confirmation command.

Use `\|` for literal pipes and `\\` for backslashes. Unknown/trailing escapes and excess separators reject. Delimiter-adjacent whitespace is trimmed; accepted field content is otherwise retained. Recipients and URLs are inert plain text.

Schema version 1: at most 12 briefs and 20 combined scope/resource/checkpoint entries each. Titles are 160 UTF-8 bytes, recipient labels 200, other text 1000. New content fits 32,768 bytes; total state 49,152. Every export envelope fits 24,576. Admission explicitly projects every record with maximum revision and the longest acceptance status, rather than trusting the fixed reserve. No draft history, source copies, automatic expiry or eviction. Deletion is available for fully valid legacy state over the byte cap.

Normal responses are at most 3500 JavaScript units; complete JSON exports are the bounded exception. Show and draft pagination preserves entire fields/IDs and labels the current revision; restart page 1 after edits. List uses insertion order, ten roots per page. Missing IDs are private and nonrevealing.

Source/search calls: zero. Catalog budgets: generation 1, search 0, contextReads 0, storeReads 8, storeUpdates 4. Deterministic commands use one state read or one atomic update. Polish uses one generation, at most two reads, and no update; input <=16000 UTF-8 bytes, instructions <=4000, raw output <=4000 units, individual suggested fields <=1000 UTF-8 bytes. The complete displayed suggestion must fit 3500 units or it is rejected with a deterministic draft command. No repair/retry call or inaccessible generated continuation. The service API has no provider token ceiling.

Malformed state, quota failures and invalid optional output preserve bytes. CAS transforms validate the current schema/quota; IDs and timestamps are allocated outside transforms. Optional results reread the revision and signal, so edits/deletion win. Runtime receipts, original deadline and owner scoping apply. An already dispatched CAS cannot be rolled back by cancellation.

Acceptance evidence: `tests/agent-delegation-brief.test.ts` covers the exact first example/workflow, boundary completeness, user-recorded acceptance, all field/entry edits and removal, Unicode pagination and quota completion, reference/quote/output rejection, stale optional work, CAS contention and private isolation with the real runtime/scoped store and fake services. Run with Node 24: `node --import tsx --test --test-concurrency=1 tests/agent-delegation-brief.test.ts`. Parent owns lazy registration, integration review and deployment; these checks do not approve release.

Every mutation binds the intended record snapshot before CAS retries. A same-record change rejects the older command with an inspect/retry message, including status, evidence, attempts and confirmed deletion. Unrelated-record conflicts retry safely; a deleted target is never recreated.
