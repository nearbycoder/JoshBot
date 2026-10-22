# Feedback builder

Prepare a private observation/impact/request draft without turning an inferred motive into a recorded observation. Explicit interpretations stay separately labeled, including in optional assistance. Observations are user supplied and unverified.

Start: `/nobo-help agent feedback-builder create Review handoff | Monday planning meeting`. Use the returned `ID`. Commands follow `/nobo-help agent feedback-builder`:

- `behavior ID | OBSERVATION`, `impact ID | PERSONAL-IMPACT`, `request ID | SPECIFIC-CHANGE`, `positive ID | POSITIVE-EXAMPLE` save the core fields.
- `inference ID | INTERPRETATION` adds an explicitly unverified interpretation. `reclassify ID confirm` moves current behavior text intact into an interpretation and clears behavior; it does not guess or upgrade an interpretation to an observation.
- `interpretation ID edit INFERENCE | TEXT` replaces that text; `interpretation ID remove INFERENCE confirm` removes it.
- `edit ID | title/situation/behavior/impact/request/positive | TEXT` replaces a field; `clear ID FIELD confirm` removes it.
- `check ID [page]` lists missing core fields and quoted lexical matches. `draft ID [page]` renders the deterministic template, separate interpretations and check results.
- `polish ID` requests one unsaved respectful rewrite. Exact source references and quotations must validate; behavior and inference text must equal the original quotation, keeping those distinctions intact. Other suggested text needs human review for added meaning. No diagnoses, motives, events or commitments are requested.
- `list [page]`, `show ID [page]`, `export ID`, `delete ID confirm` retrieve/remove complete saved records. Delete without confirmation displays the exact confirmation command.

The transparent, case-insensitive lexical rules flag absolute words `always`, `never`, `everyone`, `nobody`, `nothing`; possible interpretation/motive phrases `lazy`, `careless`, `deliberately`, `on purpose`, `don't care`/`don’t care`, `doesn't care`/`doesn’t care`, `trying to`; and vague request phrases `be better`, `do better`, `improve`, `communicate better`, `be professional`, `be proactive`, `try harder`. Matches quote the exact entered case/text. These are heuristics, not proof of intent, personality, truth or observability. No match is not verification. Missing behavior specifically calls for an observable example.

The pipe grammar decodes `\|` and `\\`, rejects other/trailing escapes and extra delimiters, and trims delimiter-adjacent whitespace. Accepted interior text is preserved. Mentions/URLs remain plaintext. Nothing sends, assigns work or asserts another person's agreement.

Schema version 1 permits 12 cases, 20 interpretations per case, 160 UTF-8 title bytes and 1000 bytes per other text field. New content fits 32768 bytes; full feature state 49152; each export including envelope 24576. Admission explicitly projects every maximum revision; no persisted draft/report payload grows later. New optional text must pass content admission. No hidden histories, eviction, auto-expiry or background work. Complete valid legacy state is still readable/deletable above byte limits.

Normal pages fit 3500 JavaScript units, with atomic IDs and full fields. Show exposes all metadata and original fields; export is exact JSON and the explicit response-size exception. List uses insertion order/ten roots; current revision labels require restarting pagination after edits.

Catalog budgets generations/searches/contextReads/storeReads/storeUpdates: 1/0/0/8/4. Deterministic operations use one read or update; polish uses one model call, at most two state reads, zero writes. Input <=16000 UTF-8 bytes, instructions <=4000, raw output <=4000 units, each suggestion <=1000 bytes, complete visible reply <=3500 units. Invalid/oversized output is rejected with a deterministic draft command, with no repair call or generated pagination. No provider-token ceiling is expressed by the service interface.

Every loaded state is schema checked; CAS transforms enforce quotas and use IDs/time allocated beforehand. Revision/signal rereads discard optional results after edits/deletion. Bad input, malformed state and optional failures preserve saved bytes. Runtime owner isolation, receipts and original deadline apply; cancellation cannot undo an already dispatched CAS.

`tests/agent-feedback-builder.test.ts` verifies exact catalog workflow and original observation/motive strings, lexical matches, all editing/removal, final interpretation retrieval, Unicode quota recovery, optional output validation and stale work. Tests use the real runtime/scoped store with fake/throwing services. Parent owns registration, independent review and deployment; no production result is claimed.
