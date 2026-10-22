# Cited research dossiers

`research` saves a private, reusable answer to a public research question, together with the dated search excerpts that supported it. Refresh keeps the prior snapshot and identifies new sources, changed excerpts/metadata, and sources no longer returned. Comparisons use saved evidence, so they work without another search or generation call.

This module requires parent registration and private command delivery before these entry points are available. All examples below use the planned `/nobo-help agent research <command>` route. The repeated `research research` in the first command is intentional: the first is the feature ID, the second starts research.

## Commands and example workflow

1. Create a dossier:

   ```text
   /nobo-help agent research research What are the tradeoffs of sodium-ion batteries for home storage?
   ```

   The reply includes a stable `r-<UUID>` dossier ID, generated findings with source IDs, uncertainties, source URLs and excerpts, observation dates, and publication dates when supplied. Copy the returned ID into later commands. Questions must contain 3–600 characters; whitespace is normalized. An existing question, ignoring case, points you to its dossier instead of creating a duplicate.

2. List or reopen saved research:

   ```text
   /nobo-help agent research list
   /nobo-help agent research show r-11111111-1111-4111-8111-111111111111
   ```

   IDs in these examples are placeholders. Use an actual ID from `list`, which also reports serialized UTF-8 bytes used, space reserved for future refreshes, and the storage quota. `show` displays the latest synthesis and the evidence-change summary from the most recent refresh.

3. Refresh and inspect exactly what changed:

   ```text
   /nobo-help agent research refresh <id>
   /nobo-help agent research compare <id>
   ```

   Refresh searches the original question again. The reply counts new URLs, URLs with changed excerpts/title/publication date, and old URLs not returned. Observation-time changes alone are not evidence changes. Single-dossier `compare` shows before/after excerpts for changed sources plus both dated syntheses and their source lists. A missing search result does **not** mean its claim was disproven or its page removed.

4. Research a related question and compare the saved dossiers:

   ```text
   /nobo-help agent research research What evidence exists for sodium-ion batteries in cold climates?
   /nobo-help agent research compare <first-id> <second-id>
   ```

   This comparison shows shared source URLs, source counts unique to each dossier, differences in captured evidence at shared URLs, and the two sets of findings and uncertainties. Shared URLs are overlapping evidence, not independent corroboration. The comparison does not invent a new judgment or automatically label different findings as contradictions.

5. Remove a dossier and all its retained snapshots:

   ```text
   /nobo-help agent research delete <id> confirm
   ```

   Omit `confirm` to see usage without deleting anything. `help` and an empty command show the full command guide.

## Evidence, limits, and failure behavior

- Each `research` or `refresh` spends at most **one search call requesting five results and one text-generation call**, with no automatic retries. This is below the shared runtime's eight-generation/six-search invocation limits. Only the first five returned records are considered, even if a provider ignores the requested limit. `help`, `list`, `show`, both forms of `compare`, and `delete` use neither service. No personal-context read is needed. The shared runtime enforces a 120-second deadline and 28,000-character reply limit; the feature's replies fit within that output limit without relying on runtime truncation.
- Search questions are sent to the configured public-web search provider. The feature uses search-provided excerpts; it never fetches a page itself, follows links, executes retrieved content, or calls Slack/model/Redis clients directly. Private command delivery does not make a question private from that search provider.
- Sources use normalized HTTP(S) URLs, exclude credentials and obvious local addresses, and ignore URL fragments when deduplicating. The runtime adapter remains responsible for public-web search policy. Stable source IDs are derived from canonical URLs and stay consistent across dossiers and refreshes. Provider titles, snippets, and dates are untrusted. Missing/invalid publication dates appear as unknown; observation dates are always supplied by the runtime.
- Generation receives JSON data and explicit instructions to ignore instructions in source content. A valid response must contain 1–5 findings, each citing supplied source IDs, and 1–4 uncertainties. Unknown source IDs, uncited findings, inline citation markers/URLs, malformed JSON, output over 12,000 characters, and validated synthesis over **8,000 serialized UTF-8 bytes** are rejected. Multibyte findings may need to be shorter than the character limits. The feature renders its own source list independently of generated prose. Citation validation checks provenance, **not whether a claim is true or logically supported**; findings are labeled as generated interpretations of limited excerpts.
- Each workspace/user-scoped store holds at most **12 dossiers**, subject to a **470,000-byte serialized JSON quota**. This is below the feature ceiling of 480,000 bytes and the runtime's 512,000-byte value limit. Every write measures `Buffer.byteLength(JSON.stringify(value), "utf8")`, including Unicode and JSON escapes. New dossiers reserve enough room for **two full 18,000-byte snapshots** plus their metadata and maximum revision-number width, even when the initial snapshot is small. Admission checks run both before service calls and inside the atomic write, so concurrent creates cannot consume each other's reserved room. Accepted dossiers can grow to both bounded snapshots without exhausting storage; there is additional space below the shared ceilings. `list` shows usage and reservation totals. Quota errors leave records unchanged and direct users to `delete <id> confirm`; no dossier is automatically evicted. Earlier valid records with larger snapshots remain readable and deletable, and count toward admission reservations.
- Each dossier keeps exactly the latest snapshot and at most one previous snapshot; refresh replaces older history. A new snapshot retains at most five sources and is capped at **18,000 serialized UTF-8 bytes**. Each source has at most 1,000 snippet characters, 160 title characters, and a URL whose escaped display is at most 1,000 characters, with a tighter **1,800-byte budget for the complete serialized source**. Titles use at most 400 serialized bytes; excerpts are shortened to the remaining source budget before generation. Prefix truncation preserves Unicode code-point boundaries. Findings are capped at 450 characters each and uncertainties at 300, subject to the synthesis byte limit above. Replies abbreviate long excerpts, titles, and comparison prose to fit Slack; the stored bounded excerpt is used for change detection.
- Provider failure, no usable excerpts, invalid synthesis, or cancellation before persistence leaves existing research untouched; new research does not leave a partial dossier. There is no evidence-only fallback that would overwrite a previously good synthesis. Corrupt persisted data is reported without resetting or overwriting it.
- All writes use a pure synchronous atomic transform, preserving unrelated concurrent updates. Concurrent duplicate creates cannot add duplicate questions or exceed capacity. A refresh only commits against the exact dossier version it read; newer refreshes and deletion win over stale generated results. A stale-result reply asks the user to inspect the saved version and retry if appropriate. The feature checks cancellation at service boundaries and before writes. The shared runtime stops waiting promptly on cancellation/deadline and guards late writes; an underlying provider call may continue, but its late result cannot save a dossier. No duplicate timer or service wrapper is needed in this module.
- Observation timestamps are stored in UTC ISO format and displayed in the runtime-supplied timezone. Provider publication dates are displayed as provided date-only values or normalized UTC timestamps, rather than being silently interpreted in the server timezone. Invalid runtime time/timezone settings stop the operation. Refresh is manual; there are no schedules, notifications, account changes, or outbound messages.

## Parent integration requirements

1. Import the named `feature` or default export from `lib/agent-features/research.ts`, register exact ID `research`, and add its help/Home discovery entry. Pass the command tail unchanged to `feature.execute(command, context)` through the planned private `/nobo-help agent research` route.
2. Use the parent-owned runtime/store to supply `AgentFeatureContext` with caller identity, a valid `now`, an IANA `timezone`, abort signal, and a store scoped to workspace/user/feature. The module uses one local JSON key, `dossiers`, with schema `{ version: 1, dossiers: [...] }`. Its 470,000-byte quota and two-snapshot lifecycle reservation fit the implemented 512,000-byte store limit. `store.update` callbacks are synchronous, pure, and safe to retry under the supplied atomic compare-and-swap semantics. No schema migration, additional storage key, arbitrary Redis access, or changes to shared files are needed.
3. Supply the existing read-only public search adapter as `services.search(question, 5)`, returning `{ title, url, text, publishedAt? }`. It must enforce public-web policy, provider timeouts, and upstream response limits. No new browsing adapter is needed.
4. Supply text-only `services.generate({ instructions, input })` with **no tools**, provider timeouts and an appropriate output/token budget. Return the JSON string requested in the module's instructions, including its 8,000-byte UTF-8 synthesis budget. The parent runtime already supplies the 120-second invocation deadline, prompt cancellation, invocation call limits, and late-write guards. The service contract has no per-call token-limit parameter, so provider-level output/token enforcement still belongs in its adapter. No live model test is needed for integration.
5. Keep replies private and disable automatic unfurling of source URLs if the Slack delivery adapter offers it. Parent owns request deduplication, asynchronous private delivery, service access checks, and normal persistence errors. The feature performs no outbound send itself.

No shared contract, dependency, package, lockfile, routing, or registry changes are requested from this child beyond the parent-owned registration/adapters described above.

## Verification

Targeted tests use only the supplied in-memory store fixture and fake search/generation services:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-research.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Coverage includes the complete workflow, comparison modes, citation integrity, input/empty/error states, hostile retrieved text, malformed persisted state, budgets and capacity, two-snapshot retention, repeatable atomic transforms, concurrent create/refresh/delete races, cancellation, supplied-timezone day boundaries, and maximum-size Slack replies. Byte-quota tests cover CJK text, emoji boundaries, JSON escaping, all 12 accepted dossiers growing to two large snapshots, concurrent competition for lifecycle reservations, explicit quota/deletion guidance, and recovery from larger legacy records.
