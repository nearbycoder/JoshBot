# Personal cross-tool recall

Use `/nobo-help agent recall help` for commands. This is one of the original twenty personal agents deployed in PR #58, with private replies and Home discovery. See [verified release status](../personal-agent-expansion.md).

Recall searches your private toolbox notes, journal entries, goals and bookmarks, eligible approved memory-review cards, and your follow-ups in the channel where you run the command. The `artifact` filter is recognized but has no connected source; legacy personal memory is also unconnected. See [source coverage](context.md). It uses lexical word matching over the context supplied by NoBo; it does not search channel history, crawl links, use embeddings or claim semantic/vector retrieval.

## Commands and a complete flow

Start with a topic you remember:

```text
/nobo-help agent recall help
/nobo-help agent recall search Atlas rollout
/nobo-help agent recall search "Atlas rollout" --kind note,follow-up --from 2026-10-01 --to 2026-10-22
/nobo-help agent recall ask What did I decide about the Atlas rollout? --kind note,journal,follow-up
/nobo-help agent recall source note/decision-123
```

Search returns ranked snippets with kind-qualified source references, source titles, local updated dates, matched-word coverage and safe source URLs when supplied. Copy an actual reference from a result into `source`; `note/decision-123` above is an example, not a preexisting record. References encode the original ID, so a bookmark with ID `reading/42` appears as `bookmark/reading%2F42`. An original source ID is also accepted when unambiguous; references take precedence if a string could mean both a reference and an original ID.

`source` reads the current context again and shows the available text, original ID, timestamp and provenance. A complete, supported `kind/id` reference requests only that kind before applying recall's record/text caps, so large unrelated tools cannot prevent reopening a kind-filtered search result. Copy the exact encoded reference from search: IDs containing slashes remain encoded, and references are never decoded twice or matched to a different kind.

If a qualified reference is absent, recall makes one additional bounded all-kind read for an original ID literally equal to the full supplied string. This preserves existing raw-ID behavior (for example, a goal's original ID could be `note/raw`) and reports cross-kind ambiguity. Bare IDs, unsupported qualifiers and malformed/noncanonical qualifiers are treated only as literal original IDs across the broad snapshot. An actual matching qualified reference always wins. Same-kind caps and adapter limits still apply; raw-ID lookups can still be capped by unrelated tools, so prefer the complete reference from search.

Editing a note in its original tool changes the next recall result. Deleting it removes it from subsequent recall snapshots. A missing source may also be outside the context adapter's current limits; recall explains that distinction.

`ask` is deliberately extractive: it returns relevant, cited source excerpts rather than inventing a free-form answer. After deterministic retrieval, one optional model call can select and order the most useful references. Only an exact, validated JSON list of retrieved references is accepted; all displayed evidence wording comes from the source snapshot. Other retrieved excerpts remain visible, including potentially conflicting accounts. Model failure or malformed output falls back to the deterministic excerpts. With no matches, recall explicitly says it cannot answer from the available evidence and makes no model call.

## Filters and ranking

Both `search` and `ask` support these options anywhere outside a double-quoted phrase:

- `--kind note,journal,goal,bookmark,artifact,memory,follow-up`: one or more exact singular kind names, comma-separated without spaces. Omit to request all seven kinds; `artifact` currently returns no records, and `memory` includes only eligible approved cards.
- `--from YYYY-MM-DD` and `--to YYYY-MM-DD`: inclusive **last-updated** day bounds. Either bound can be omitted. These do not filter by due date, journal entry date or dates mentioned in the text.
- `--limit N`: default 5; search accepts 1–10 and ask accepts 1–5.

Timestamp offsets are converted to the runtime-supplied timezone before date comparison. For example, `2026-10-22T04:30:00Z` belongs to October 21 in America/Chicago. Explicit date-only timestamps retain their recorded calendar day. Missing timestamps, invalid dates and datetimes without a timezone offset display as unknown and are excluded when a date filter is present. A missing or invalid runtime timezone produces an actionable error, never a server-timezone fallback.

Words are Unicode-normalized and case-insensitive. Common English question/function words are ignored unless inside a quoted phrase. Unquoted words use any-word matching; the number of distinct matched query words ranks first. Remaining ranking uses bounded word frequency, higher title weight, rarer words and whole-query phrase matches, followed by updated time and a stable reference tie-break. A double-quoted phrase is required as a consecutive word sequence in the title or body; punctuation and letter case are ignored. Phrases cannot span the title/body boundary. There is no stemming, typo correction, synonym expansion or translation, so try alternate wording when needed. Punctuation splits terms (for example, `C++` and `C#` both include the word `c`).

Ranking reuses title/body tokenization only within the current invocation. Excerpts are generated after ranking, for the selected results only (up to 10 for search or 5 for ask). This does not change the ranking weights, tie-breaks, cited text or source reopening; it avoids scanning every matching body for an excerpt that will never be displayed. No normalized text or search results are cached across requests.

Only titles and text are searched. Metadata, URLs, status labels, source IDs and timestamps do not secretly become searchable evidence. Status is displayed when supplied. Titles are used as excerpts when a source has no body text.

## Limits, retention and failure behavior

- Search, ask and successful qualified source lookups read context once. A missing qualified reference may make one additional read for literal original-ID compatibility, with coverage notes identifying any scoped/fallback caps. Help and invalid commands do not read context. Search and source never call a model. There are no public-web calls, direct Redis reads, Slack calls or external mutations.
- The shared runtime permits at most 8 generation calls and 6 bounded web searches within a 120-second deadline. Recall uses at most **1 generation call and 0 web searches**; all replies are capped at 27,500 characters, below the runtime's 28,000-character ceiling. Optional model selection does not retry on failure.
- Commands are at most 2,000 characters, queries at most 500 characters and 32 distinct meaningful words. Source IDs must be nonempty strings of at most 200 UTF-16 code units without ASCII control characters or malformed surrogate sequences.
- Recall examines at most the first 1,000 context records, retains at most 1,000,000 normalized title/body characters, and uses at most 200 title characters and the first 12,000 body characters per source. Coverage notes report malformed records, duplicate references, shortened sources and local context caps. Narrowing `--kind` helps when the context adapter honors requested kinds before applying its own cap.
- Duplicate IDs within a kind are omitted rather than attributing ambiguous evidence. Different kinds may reuse the same original ID safely. Context kinds outside the seven supported kinds are ignored even if the adapter returns them.
- Search excerpts are approximately 360 characters and ask excerpts approximately 650 characters. Whitespace/control characters are normalized; clipping is marked with ellipses or a coverage note. `source` displays at most 16,000 escaped body characters. Replies are capped below 28,000 characters with an explicit truncation notice, which can shorten the displayed results or provenance for unusually large inputs.
- Source links must be HTTP(S), have no embedded username/password or whitespace/markup, and fit within 2,048 characters both before and after URL normalization. Invalid links are omitted; source references still identify the evidence. Slack mention syntax and angle-bracket content are escaped.
- The model receives only the question plus at most five retrieved references, titles, timestamps and excerpts. Model selection responses are capped at 8,000 characters. It cannot execute source instructions or submit free-form generated claims to the reply. Source excerpts themselves remain untrusted records, not verified facts.
- Recall saves **no state**: no duplicate index, queries, answers, history or source copies. It does not use `store.read` or `store.update`. There is therefore no recall export/delete command or stale generated write to reconcile. Original sources remain subject to their owning tool's export/deletion policy. Normal runtime/message/provider retention is outside this module.
- Recall consumes **0 bytes of feature storage**, so the 480,000-byte feature-state target and the shared store's 512,000-byte serialized UTF-8 limit need no quota reservation or lifecycle headroom here. The bounded in-memory context can exceed that byte size because it is never persisted. If an original tool reports a storage quota, export or delete older records in that owning tool; recall cannot delete its records. Do not add a persisted recall cache without measuring `Buffer.byteLength(JSON.stringify(value), "utf8")`, retaining lifecycle headroom and adding quota/deletion flows. The shared runtime may separately retain request fingerprints/status for deduplication, without saving recall replies.
- Context failures are reported separately from an empty result and raw provider errors are not exposed. The shared runtime stops waiting promptly when cancellation or its 120-second deadline fires and guards late writes. Recall checks the supplied signal before reading and after service completion/rejection, and discards cancelled output. It performs no writes that a late result could apply. Direct calls without the runtime's wrapped services retain those signal checks but do not independently interrupt a hanging provider.

## Runtime and source contract

1. `registry.ts` registers the named/default `feature` from `lib/agent-features/recall.ts` as `recall`. `index.ts` dispatches `/nobo-help agent recall <command>` through the shared runtime; the Slack route returns private text and Home exposes its help. The shared route preserves multiline command text; individual commands still enforce their input rules.
2. The runtime supplies a valid user timezone and a `services.readContext(kinds)` adapter scoped to the authenticated workspace/user. Respect requested kinds when gathering data; never substitute channel history, shared/channel memory or another user's private records. Recall relies on the adapter for ownership because `AgentContextItem` contains no owner field.
3. The integrated adapter maps toolbox records to `note`, `journal`, `goal`, and `bookmark`, eligible approved cards to `memory`, and owned current-channel records to `follow-up`. `artifact` is a recognized but unconnected kind. Preserve stable IDs, string titles/text, genuine update timestamps, and safe provenance URLs. No legacy personal memory is read. Recall does not fetch URLs or open files; source IDs must not derive from mutable array positions or content.
4. Preserve the adapter's bounded deterministic ordering and [coverage/error contract](context.md). Connected providers that fail or exceed a complete-read limit reject the read; an empty or excluded source contributes no items. The array contract has no per-source availability field. Recall separately reports its own 1,000-record/text caps, and absence from that snapshot never proves deletion. Date filters run after reading the supplied snapshot.
5. The runtime injects the existing text-only `services.generate` adapter for optional excerpt selection. If no model is configured, an ordinary rejected promise is supported and yields a deterministic answer. Keep ownership/privacy enforcement and timeouts in the runtime. No package, shared contract, storage key, migration, embedding service or other shared source change is required.

## Verification

```sh
node --import tsx --test tests/agent-recall.test.ts
npm run typecheck
git diff --check
```

The source-reopening regression uses the production context/services/runtime/store modules with an in-memory backend and no live providers. It populates notes, journal and bookmarks through real toolbox commands (484,137 / 496,512 / 117,017 serialized UTF-8 bytes) plus an older confirmed memory card. All 155 records are valid, while the broad normalized text exceeds recall's unchanged 1,000,000-character cap. Kind-filtered search results must reopen successfully without unrelated source reads; wrong-kind/private-owner references must remain unavailable and the original sources must remain unchanged. Other cases cover exact encoded IDs, literal-ID ambiguity, malformed qualifiers and honest same-kind caps.

In an isolated feature worktree lacking the shared integration modules, set `JOSHBOT_RECALL_CONTEXT_ROOT` to a read-only integrated checkout when running the targeted test command. After integration the tests load local shared modules automatically; no override is needed.

Other tests use the shared context fixture and fake services. They cover the complete flow, all seven kinds, lexical ranking and Unicode/phrases, timezone and DST boundaries, invalid input, missing evidence, generation failures and fabricated citations, conflicting evidence, inert source content, context validation, stable source IDs, live source edits/deletion, coverage/reply limits and cancellation. A Unicode snapshot whose serialized UTF-8 bytes exceed 512,000 verifies that each command performs zero store reads/writes, at most one generation and no web search. The fake store counts and rejects every read/write; deadline-rejection tests verify cancellation without exposing provider errors or starting follow-on work.

The performance regression also captures exact selected outputs from before the optimization for ties, quoted phrases, late evidence and Unicode, including both search and ask excerpt widths. With 600 matching sources, instrumentation verifies that `search --limit 3` performs three excerpt scans, `ask --limit 5` performs five, and source reopening performs none. See the [shared performance report](../personal-agent-performance.md) for all before/after samples, including the earlier failed event-loop checks and the unresolved complete-context recovery review item.

## Source capacity recovery (foundation follow-up)

Capacity errors give narrowing guidance instead of a temporary-outage retry. Use `/nobo-help agent recall search Atlas --kind note`, or reopen the full `kind/id` reference returned by search. Kind selection happens before reading; date, query and result-limit filters happen afterward and cannot fix an oversized source read. If one kind itself exceeds capacity, reduce its records in the original source tool. No ranking, tie-breaking, excerpt, qualified-reference or fallback behavior changed. See [shared source capacity handling](context.md#capacity-handling-in-the-foundation-follow-up).
