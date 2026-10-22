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

   IDs in these examples are placeholders. Use an actual ID from `list`. `show` displays the latest synthesis and the evidence-change summary from the most recent refresh.

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

- Each `research` or `refresh` spends at most **one search call requesting five results and one text-generation call**, with no automatic retries. Only the first five returned records are considered, even if a provider ignores the requested limit. `help`, `list`, `show`, both forms of `compare`, and `delete` use neither service. No personal-context read is needed.
- Search questions are sent to the configured public-web search provider. The feature uses search-provided excerpts; it never fetches a page itself, follows links, executes retrieved content, or calls Slack/model/Redis clients directly. Private command delivery does not make a question private from that search provider.
- Sources use normalized HTTP(S) URLs, exclude credentials and obvious local addresses, and ignore URL fragments when deduplicating. The runtime adapter remains responsible for public-web search policy. Stable source IDs are derived from canonical URLs and stay consistent across dossiers and refreshes. Provider titles, snippets, and dates are untrusted. Missing/invalid publication dates appear as unknown; observation dates are always supplied by the runtime.
- Generation receives JSON data and explicit instructions to ignore instructions in source content. A valid response must contain 1–5 findings, each citing supplied source IDs, and 1–4 uncertainties. Unknown source IDs, uncited findings, inline citation markers/URLs, malformed JSON, and output over 12,000 characters are rejected. The feature renders its own source list independently of generated prose. Citation validation checks provenance, **not whether a claim is true or logically supported**; findings are labeled as generated interpretations of limited excerpts.
- Each workspace/user-scoped store holds at most **12 dossiers**, with exactly the latest snapshot and at most one previous snapshot per dossier. Refresh replaces the older historical snapshot. Each snapshot retains at most five sources; each source has at most 1,000 snippet characters, 160 title characters, and a URL whose escaped display is at most 1,000 characters. Findings are capped at 450 characters each and uncertainties at 300. Replies abbreviate long excerpts, titles, and comparison prose to fit Slack; the stored bounded excerpt is used for change detection. No dossier is automatically evicted. Delete one explicitly to make room.
- Provider failure, no usable excerpts, invalid synthesis, or cancellation before persistence leaves existing research untouched; new research does not leave a partial dossier. There is no evidence-only fallback that would overwrite a previously good synthesis. Corrupt persisted data is reported without resetting or overwriting it.
- All writes use a pure synchronous atomic transform, preserving unrelated concurrent updates. Concurrent duplicate creates cannot add duplicate questions or exceed capacity. A refresh only commits against the exact dossier version it read; newer refreshes and deletion win over stale generated results. A stale-result reply asks the user to inspect the saved version and retry if appropriate. Runtime cancellation is checked at service boundaries; the service contract does not allow this module to cancel an already-running provider call.
- Observation timestamps are stored in UTC ISO format and displayed in the runtime-supplied timezone. Provider publication dates are displayed as provided date-only values or normalized UTC timestamps, rather than being silently interpreted in the server timezone. Invalid runtime time/timezone settings stop the operation. Refresh is manual; there are no schedules, notifications, account changes, or outbound messages.

## Parent integration requirements

1. Import the named `feature` or default export from `lib/agent-features/research.ts`, register exact ID `research`, and add its help/Home discovery entry. Pass the command tail unchanged to `feature.execute(command, context)` through the planned private `/nobo-help agent research` route.
2. Supply `AgentFeatureContext` with caller identity, a valid `now`, an IANA `timezone`, optional abort signal, and a store scoped to workspace/user/feature. The module uses one local JSON key, `dossiers`, with schema `{ version: 1, dossiers: [...] }`. Its two-snapshot-per-dossier state is bounded by the limits above. Provide atomic compare-and-swap semantics for `store.update`; callbacks are synchronous, pure, and safe to retry. No arbitrary Redis access is needed.
3. Supply the existing read-only public search adapter as `services.search(question, 5)`, returning `{ title, url, text, publishedAt? }`. It must enforce public-web policy, provider timeouts, and upstream response limits. No new browsing adapter is needed.
4. Supply text-only `services.generate({ instructions, input })` with **no tools**, provider timeouts and an appropriate output/token budget. Return the JSON string requested in the module's instructions. This contract has no per-call token-limit or abort parameter, so adapter-level enforcement is required. No live model test is needed for integration.
5. Keep replies private and disable automatic unfurling of source URLs if the Slack delivery adapter offers it. Parent owns request deduplication, asynchronous private delivery, service access checks, and normal persistence errors. The feature performs no outbound send itself.

No shared contract, dependency, package, lockfile, routing, or registry changes are requested from this child beyond the parent-owned registration/adapters described above.

## Verification

Targeted tests use only the supplied in-memory store fixture and fake search/generation services:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-research.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Coverage includes the complete workflow, comparison modes, citation integrity, input/empty/error states, hostile retrieved text, malformed persisted state, budgets and capacity, two-snapshot retention, repeatable atomic transforms, concurrent create/refresh/delete races, cancellation, supplied-timezone day boundaries, and maximum-size Slack replies.
