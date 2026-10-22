# Personal cross-tool recall

Implementation module: `lib/agent-features/recall.ts`, exported as named `feature` and default export with ID `recall`. Parent routing and context adapters must be integrated before the commands below are available.

Recall finds your own notes, journal entries, goals, bookmarks, artifacts, memory and follow-ups in one private search. It uses lexical word matching over the context supplied by NoBo; it does not search channel history, crawl links, use embeddings or claim semantic/vector retrieval.

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

`source` reads the current context again and shows the available text, original ID, timestamp and provenance. Editing a note in its original tool changes the next recall result. Deleting it removes it from subsequent recall snapshots. A missing source may also be outside the context adapter's current limits; recall explains that distinction.

`ask` is deliberately extractive: it returns relevant, cited source excerpts rather than inventing a free-form answer. After deterministic retrieval, one optional model call can select and order the most useful references. Only an exact, validated JSON list of retrieved references is accepted; all displayed evidence wording comes from the source snapshot. Other retrieved excerpts remain visible, including potentially conflicting accounts. Model failure or malformed output falls back to the deterministic excerpts. With no matches, recall explicitly says it cannot answer from the available evidence and makes no model call.

## Filters and ranking

Both `search` and `ask` support these options anywhere outside a double-quoted phrase:

- `--kind note,journal,goal,bookmark,artifact,memory,follow-up`: one or more exact singular kind names, comma-separated without spaces. Omit to search all seven kinds.
- `--from YYYY-MM-DD` and `--to YYYY-MM-DD`: inclusive **last-updated** day bounds. Either bound can be omitted. These do not filter by due date, journal entry date or dates mentioned in the text.
- `--limit N`: default 5; search accepts 1–10 and ask accepts 1–5.

Timestamp offsets are converted to the runtime-supplied timezone before date comparison. For example, `2026-10-22T04:30:00Z` belongs to October 21 in America/Chicago. Explicit date-only timestamps retain their recorded calendar day. Missing timestamps, invalid dates and datetimes without a timezone offset display as unknown and are excluded when a date filter is present. A missing or invalid runtime timezone produces an actionable error, never a server-timezone fallback.

Words are Unicode-normalized and case-insensitive. Common English question/function words are ignored unless inside a quoted phrase. Unquoted words use any-word matching; the number of distinct matched query words ranks first. Remaining ranking uses bounded word frequency, higher title weight, rarer words and whole-query phrase matches, followed by updated time and a stable reference tie-break. A double-quoted phrase is required as a consecutive word sequence in the title or body; punctuation and letter case are ignored. Phrases cannot span the title/body boundary. There is no stemming, typo correction, synonym expansion or translation, so try alternate wording when needed. Punctuation splits terms (for example, `C++` and `C#` both include the word `c`).

Only titles and text are searched. Metadata, URLs, status labels, source IDs and timestamps do not secretly become searchable evidence. Status is displayed when supplied. Titles are used as excerpts when a source has no body text.

## Limits, retention and failure behavior

- Each invocation reads context once. Help and invalid commands do not read context. Search and source never call a model. There are no public-web calls, direct Redis reads, Slack calls or external mutations.
- Commands are at most 2,000 characters, queries at most 500 characters and 32 distinct meaningful words. Source IDs must be nonempty strings of at most 200 UTF-16 code units without ASCII control characters or malformed surrogate sequences.
- Recall examines at most the first 1,000 context records, retains at most 1,000,000 normalized title/body characters, and uses at most 200 title characters and the first 12,000 body characters per source. Coverage notes report malformed records, duplicate references, shortened sources and local context caps. Narrowing `--kind` helps when the context adapter honors requested kinds before applying its own cap.
- Duplicate IDs within a kind are omitted rather than attributing ambiguous evidence. Different kinds may reuse the same original ID safely. Context kinds outside the seven supported kinds are ignored even if the adapter returns them.
- Search excerpts are approximately 360 characters and ask excerpts approximately 650 characters. Whitespace/control characters are normalized; clipping is marked with ellipses or a coverage note. `source` displays at most 16,000 escaped body characters. Replies are capped below 28,000 characters with an explicit truncation notice, which can shorten the displayed results or provenance for unusually large inputs.
- Source links must be HTTP(S), have no embedded username/password or whitespace/markup, and fit within 2,048 characters both before and after URL normalization. Invalid links are omitted; source references still identify the evidence. Slack mention syntax and angle-bracket content are escaped.
- The model receives only the question plus at most five retrieved references, titles, timestamps and excerpts. Model selection responses are capped at 8,000 characters. It cannot execute source instructions or submit free-form generated claims to the reply. Source excerpts themselves remain untrusted records, not verified facts.
- Recall saves **no state**: no duplicate index, queries, answers, history or source copies. It does not use `store.read` or `store.update`. There is therefore no recall export/delete command or stale generated write to reconcile. Original sources remain subject to their owning tool's export/deletion policy. Normal runtime/message/provider retention is outside this module.
- Context failures are reported separately from an empty result and raw provider errors are not exposed. Aborted requests stop before reading, after context returns, or after generation returns. The runtime owns service deadlines and cancellation of underlying provider work.

## Exact parent integration requirements

1. Register `feature` from `lib/agent-features/recall.ts` under `recall` in the shared feature registry and expose help/Home discovery. Route `/nobo-help agent recall <command>` to `feature.execute(command, context)` and deliver **all** replies privately. Routing, access checks and delivery remain parent-owned.
2. Supply a valid user timezone and a `services.readContext(kinds)` adapter scoped to the authenticated workspace/user. Respect requested kinds when gathering data; never substitute channel history, shared/channel memory or another user's private records. Recall relies on the adapter for ownership because `AgentContextItem` contains no owner field.
3. Map existing personal-tool records to `note`, `journal`, `goal`, `bookmark`, `artifact`, `memory` and `follow-up` with stable IDs, string titles/text, genuine last-modified timestamps and authorized provenance URLs when available. IDs must be unique within each kind. If a tool is unavailable, omit its records rather than inventing placeholder evidence. Populate useful bookmark/artifact text explicitly; recall does not fetch URLs or open artifact files. Do not derive memory IDs from mutable array positions or mutable content if a stable record ID exists.
4. Prefer bounded, deterministic adapter ordering (for example recent sources first), and make any adapter-side completeness limits visible in the integrated product. This interface returns only an array, so recall cannot detect records omitted before delivery or distinguish an empty tool from an unavailable tool. Date filters operate after reading the supplied snapshot, not across an unbounded archive.
5. Inject the existing text-only `services.generate` adapter for optional excerpt selection. If no model is configured, an ordinary rejected promise is supported and yields a deterministic answer. Keep ownership/privacy enforcement and timeouts in the runtime. No package, shared contract, storage key, migration, embedding service or other shared source change is required.

## Verification

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-recall.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Tests use the shared context fixture and fake services only. They cover the complete flow, all seven kinds, lexical ranking and Unicode/phrases, timezone and DST boundaries, invalid input, missing evidence, generation failures and fabricated citations, conflicting evidence, inert source content, context validation, stable source IDs, live source edits/deletion, coverage/reply limits and cancellation. The fake store rejects every read/write, verifying that recall remains read-only.
