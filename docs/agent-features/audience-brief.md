# Audience brief

Keep canonical facts separate from audience-specific variants. Deterministic rendering preserves exact fact text, includes every required fact or reports overflow, and exposes coverage for every retained fact. Each audience has its own stated needs, word budget and explicit requirements. No messages are sent.

Start: `/nobo-help agent audience-brief create Pilot update`. Replace `ID`, `FACT` and `AUDIENCE` with returned IDs. Commands follow `/nobo-help agent audience-brief`:

- `fact ID add TEXT | required/important/optional`, `fact ID edit FACT | TEXT | required/important/optional`, `fact ID remove FACT confirm`. Confirmed removal also removes that fact's requirement links.
- `audience ID add NAME | NEEDS | WORDS`, `audience ID edit AUDIENCE | NAME | NEEDS | WORDS`, `audience ID remove AUDIENCE confirm`.
- `require ID AUDIENCE | FACT`, `unrequire ID AUDIENCE | FACT confirm`. Removing an audience-specific requirement does not override a fact's global required importance.
- `lead ID | TEXT`, `ask ID | TEXT`, `edit ID | title/lead/ask | TEXT`, `clear ID FIELD confirm`.
- `render ID AUDIENCE [page]` returns the unsent variant and coverage matrix. `polish ID AUDIENCE` optionally requests one unsaved compact narrative.
- `list [page]`, `show ID [page]`, `export ID`, `delete ID confirm` retrieve/remove complete private records. Without confirmation, deletion only returns its exact confirmation command.

Words are whitespace-separated tokens in lead, ask and fact text; labels/IDs/coverage do not consume the content budget. This is a disclosed convention, not linguistic segmentation. Audiences accept 20–1000 words. Global and audience-specific required facts plus lead/ask are mandatory. If they cannot fit, no complete variant is produced and no polish call starts. Otherwise optional facts are selected by important before optional, then distinct lowercase Unicode word overlap with audience needs, then stable entered order. Whole facts are included only if they fit. This bounded lexical heuristic is not a semantic relevance or truth guarantee; every omission is visible in coverage.

Canonical text is never changed by render/polish. Variants are unsaved and labeled with the canonical revision, so there are no stored variants to become stale after edits. An explicit fact edit replaces that canonical field, increments revision and discards any pending older narrative; there is no hidden history. Show/export always retrieve current original inputs, not rewritten variants.

Polish sends the selected facts, audience, lead/ask to the configured text model. Structured sections require known references, exact original quotes, and coverage of all selected fields (including required facts). Unknown fields/references, missing coverage, changed quotes, excess content words or excessive output reject. Existence of references does not prove semantic fidelity; users review every suggested sentence. Full canonical quotes remain displayed next to suggestions. Optional output is unsaved and must fit one complete 3500-unit reply, with no regenerated pagination or repair calls.

Schema version 1: 10 briefs, 20 facts and 5 audiences per brief, at most 20 required links per audience. Names/titles <=160 UTF-8 bytes; other text <=1000. New content <=32768 bytes, state <=49152, export including envelope <=24576. Admission projects every record at maximum revision; rendering has no persisted completion payload. Optional text and requirement links are new content. No eviction, expiry, private cache or background work. Valid legacy state above byte caps stays inspectable/deletable.

Pipe parsing uses `\|`/`\\`; unknown/trailing escapes and extra separators reject. Delimiter-adjacent whitespace is trimmed; accepted interiors are retained. Plaintext output avoids double escaping. Lists use stable insertion order/ten roots; detail and variant pages retain complete identifiers and fields, display the revision, and require restarting page 1 after edits. Export is the bounded complete-JSON exception to normal 3500-unit replies.

Catalog budgets generations/searches/contextReads/storeReads/storeUpdates = 1/0/0/8/4. No context sources are read. Deterministic operations use one state read or update; polish uses one generation, up to two reads and zero writes. Model input <=16000 UTF-8 bytes, instructions <=4000, output <=4000 JS units, suggested section <=1000 bytes and full displayed response <=3500 units. No provider token ceiling exists in this API.

Pure synchronous transforms validate current schema, references and quota on every CAS retry. IDs/time are allocated outside them. Bad input, malformed state and failed optional output preserve bytes. Post-generation revision/signal checks discard results after edits/deletion. Runtime ownership, receipts and the original deadline apply; cancellation cannot undo an already dispatched CAS.

`tests/agent-audience-brief.test.ts` covers the exact first example/workflow, exact fact preservation, required overflow, audience selection/coverage, full editing/removal, maximum final fact/audience retrieval, Unicode quota recovery, optional references/quotes/word-budget checks, stale output and a genuine CAS conflict deleting a referenced fact. It uses the real runtime/scoped store and fake providers. Parent owns lazy registration, independent review and rollout.
