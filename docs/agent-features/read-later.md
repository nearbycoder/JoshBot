# Reading queue and digests

Use `/nobo-help agent read-later help` for commands. This feature is registered with private replies and Home discovery on the development branch; it is **not deployed**. See [release status](../personal-agent-expansion.md).

The private queue helps decide what to read in the time you have, records partial
reading progress, creates cited summaries and digests of pasted excerpts, and
saves your own takeaways. It never fetches an article URL. A link alone is not
enough to summarize an article, and all summaries explicitly disclose that full
article text is unavailable.

Bookmark candidates are connected to your private toolbox bookmarks. Import copies only a selected bookmark's title and URL; you must supply the reading estimate and article excerpt. See [source coverage](context.md).

## A complete reading session

Use `/nobo-help agent read-later <command>`. All commands and
results must stay private to the caller. For example:

```text
/nobo-help agent read-later add https://example.org/attention | Attention and reading | 8 | Turning off notifications makes focused reading easier. A short reading session can build a useful daily habit.
/nobo-help agent read-later add https://example.org/breaks | Taking useful breaks | 5 | Regular breaks can improve focus during a reading session. Compare the claim with your own experience.
```

These are illustrative supplied excerpts, not fetched claims from those example
URLs. Each response returns a stable ID such as
`r_0b361ec0-95b3-4f83-8d72-e07a58cdd4ca`. Substitute the actual returned IDs for
`<attention-id>` and `<breaks-id>` below:

```text
/nobo-help agent read-later priority <attention-id> high
/nobo-help agent read-later progress <attention-id> 50
/nobo-help agent read-later next 10
/nobo-help agent read-later read <attention-id>
/nobo-help agent read-later digest 10
/nobo-help agent read-later takeaway <attention-id> | Silence notifications before my next reading session.
/nobo-help agent read-later mark-read <attention-id>
/nobo-help agent read-later list read
```

The plan includes the remaining four minutes of the first article and five of
the second. The digest compares their available excerpts with quotations and
source links. Neither reading a summary nor creating a digest marks anything
read. Only your explicit progress/mark-read command changes completion.

## Commands

All commands below follow `/nobo-help agent read-later `.

| Command | Behavior |
| --- | --- |
| `help` | Command syntax, limits, and example; no model or storage needed. |
| `add <url> \| <title> \| <minutes\|auto> [\| <excerpt>]` | Add a plain HTTP(S) link and optional pasted excerpt. `auto` requires text and estimates only that excerpt at 200 whitespace-separated words/minute, rounded up. Use explicit minutes for your estimate of the whole article. |
| `list [active\|read\|archived\|all] [page]` | Show queue totals, saved/reserved UTF-8 byte usage, and ten items per page; defaults to `active 1`. Pages range from 1 to 3. |
| `show <id>` | Saved source excerpt, progress, cached summary, source URL, and personal takeaways. |
| `excerpt <id> \| <text>` | Replace the excerpt; remove its cached summary and any digest citing this item. Recalculate an `auto` estimate. Keep your personal takeaways. |
| `time <id> <minutes\|auto>` | Correct the reading-time estimate. |
| `priority <id> high\|normal\|low` | Set explicit reading priority; default is normal. |
| `next <minutes>` | Deterministic plan that fits your available reading budget; no generation. |
| `read <id> [refresh]` | Generate and save a cited excerpt summary, or reuse a saved one. `refresh` requests a new version. With no usable excerpt, explain how to paste one without calling the model. |
| `digest <minutes>` | Synthesize excerpts from up to five active articles fitting the reading budget; save one latest digest. |
| `digest show` | Display the saved digest without another model call. |
| `progress <id> <0–99>` | Record the percentage you have read. Zero queues an item; 1–99 means in progress. Can reopen a completed item. Restore archived items first. |
| `mark-read <id>` | Explicitly mark 100% complete. Restore archived items first. |
| `archive <id>` | Remove from recommendations while retaining its progress, excerpt, summary, and takeaways. |
| `restore <id>` | Restore the saved progress: completed items remain read; unfinished items return to the active queue. |
| `takeaway <id> \| <your insight>` | Save a personal takeaway and return its stable `t_<uuid>` ID. Generated points are never automatically accepted as your takeaways. |
| `takeaway-remove <id> <takeaway-id>` | Delete one personal takeaway; find its ID in `show`. |
| `candidates [page]` | Read owner-scoped bookmark candidates only on demand. Ten candidates per page from the first 100 context entries. Nothing is imported. |
| `import <bookmark-source-id> \| <minutes>` | Explicitly copy that bookmark's URL and title into the reading queue. Supply minutes and then paste an excerpt. Bookmark metadata is not treated as article text. |
| `export <id> [page]` | Export the complete article, including source, summary, and takeaways, as lossless paginated JSON envelopes. See reconstruction below. |
| `delete <id> confirm` | Permanently remove the article, summary, takeaways, and any saved digest citing it. |
| `clear confirm` | Permanently clear this feature's queue, summaries, takeaways, and saved digest. Existing bookmarks are never changed. |

Use plain URLs, without Slack's `<url\|label>` wrapper. Credentials in URLs are
rejected. URL normalization removes fragments and uses standard URL hostname
normalization; query parameters remain. Adding an existing normalized URL
returns its existing ID, including when it is read or archived, and preserves
all existing content. Titles cannot contain `|` or newlines; the excerpt may
contain `|` and multiple lines.

## Reading plans and evidence

Budgets and explicit article estimates are whole minutes from 1 to 240.
Remaining time is `ceil(minutes × (100 − progress) / 100)`. Recommendations sort
by high/normal/low priority, then in-progress before queued, then oldest capture
time, with stable ID as the final tie-breaker. The plan takes each item that fits
the remaining budget and skips oversize items. This is a predictable greedy
plan, not an optimal packing algorithm; it may leave unused time. It does not
split a new article into a partial reading assignment. Record progress yourself
if you read only part of an article.

Digests use the same selection rule, restricted to at most five items with
usable excerpts. The minute budget refers to estimated remaining **source
reading**, not time to read the digest. Even after partial reading, synthesis
uses the complete saved excerpt; it does not infer which paragraphs you read.

Each generated point must cite a selected stable article ID and a quotation
found in that article's excerpt, allowing whitespace differences. The module
rejects invented IDs, missing evidence, nonmatching/too-short quotations,
unbounded output, and digests that omit a selected source. A quotation match
does not prove the model's interpretation; generated points are explicitly
labeled AI drafts to check against their evidence. Source links are rendered
from stored inputs, independently of the model's prose. Nothing in source text
or a model response is executed. Special Slack mention markup is escaped.

If generation fails or returns unsupported evidence, saved summaries, digests,
progress, and takeaways remain unchanged. `read` includes a short source preview
on failure; `show` and `next` still work without generation. In-flight summaries
are discarded if that article changes or is removed. In-flight digests are
discarded if anything in the queue changes. Every item edit removes a saved
digest that cites that item; additions or edits to other items can leave an
existing dated digest available as a previous snapshot.

## Retention and export

The module stores one versioned JSON value at the runtime-scoped key `queue`:
at most 30 articles (including read and archived), 6,000 excerpt characters per
article, 160 title characters, 2,048 URL characters, five generated summary
points per article, eight personal takeaways of at most 500 characters each,
and one latest digest with at most five sources/five points. Each generated
point is limited to 500 characters and quotations of 12–300 characters. Each
summary point has one quotation; a digest point can cite up to three distinct
sources. Commands are limited to 12,000 characters. Article and takeaway
IDs are UUID-based; timestamps are ISO UTC, displayed in the supplied timezone.
The feature does not expire or evict user entries automatically. Archive does
not free capacity; export/delete entries or use `clear confirm` to do so.

`show` can be shortened for exceptionally markup-heavy inputs to respect the
28,000-character reply ceiling. Export pages are lossless and never rely on
that truncation: each JSON envelope has `id`, `revision`, `page`, `pages`, and
`data` fields, plus reconstruction instructions. Fetch every page, verify
their `revision` values agree, concatenate their parsed `data` strings in page
order, and parse the combined string as JSON. For example, when responses are
already parsed into an array named `pages`:

```js
if (pages.length !== pages[0].pages ||
    !pages.every((p, i) => p.id === pages[0].id &&
      p.revision === pages[0].revision && p.page === i + 1)) {
  throw new Error("Export is incomplete or changed; export again.");
}
const article = JSON.parse(pages.map(p => p.data).join(""));
```

Export is per article; `digest show` supplies the latest synthesis. Removing a
source also removes any saved digest containing it, so deleted excerpt quotes
do not linger in the digest. Malformed stored state is rejected without a
partial overwrite; an administrator can recover it, or the user can explicitly
reset it with `clear confirm`.

Every proposed state is measured with
`Buffer.byteLength(JSON.stringify(state), "utf8")` and kept below **480,000
bytes**, below the runtime's 512,000-byte hard limit. The quota also reserves
13,000 bytes for each article's maximal future summary, 25,000 for the latest
digest, and lifecycle headroom. Progress/status/priority fields are budgeted at
their largest encoding, so an accepted article can still be summarized, marked
read, or archived when capture space is exhausted. New captures, replacement
excerpts, and takeaways cannot consume these reservations. `list` shows both
actual saved bytes and the reserved total. Large Unicode excerpts can fill the
quota before reaching the item count; unpaired Unicode surrogates are rejected.
On quota rejection, the command changes nothing and explains how to export and
delete items, remove takeaways, or shorten excerpts. Archiving retains data.

## Runtime and source contract

1. `registry.ts` registers the named/default `feature` from `lib/agent-features/read-later.ts` as `read-later`. `index.ts` dispatches `/nobo-help agent read-later <command>` through the shared runtime; the Slack route returns private text and Home exposes its help. The shared route preserves multiline command text; individual commands still enforce their input rules.
2. The runtime supplies identity-checked, workspace/user/feature-scoped `context.store` with
   atomic `update` and isolated JSON values. Only the literal scoped key
   `queue` is accessed. Updates must support pure synchronous retryable
   transforms; IDs/timestamps are created before those transforms. Runtime
   request deduplication handles duplicate delivery of commands such as
   `takeaway` (the module does not consume `requestId`). The module's measured
   quota and reservations fit the shared store's 512,000-byte per-value cap.
3. The runtime supplies `context.now`, an explicit valid IANA `context.timezone`, and optional
   cancellation signal. Deliver every response privately; no command has a
   public response mode. Route potentially slower `read` and `digest` commands
   through the shared asynchronous private delivery path.
4. The runtime supplies text-only, tool-free `services.generate` for `read`/`digest`. Each
   request makes at most one call with at most five 6,000-character excerpts.
   The model must return the instructed JSON; malformed responses are handled
   without state loss. This fits the runtime's eight-generation/six-search
   invocation limits: the module uses at most one generation and zero searches.
   Use the shared runtime's 120-second deadline, prompt cancellation, and late
   write guards; the module also checks cancellation before work and before
   committing generated results. Rendering a saved summary/digest needs no
   model. All replies fit the shared 28,000-character ceiling.
5. Bookmark import is connected through `readContext(["bookmark"])` to the caller's private toolbox. It returns stable `toolbox:bookmarks:<entry-id>` IDs, `kind: "bookmark"`, titles, and plain HTTP(S) `sourceUrl` values when valid. The feature considers the first 100 entries, matching the source bound, and skips invalid links or ambiguous duplicate IDs. It intentionally does not import source `text` as article content. Empty eligible bookmarks return `[]`; source failures reject. No bookmark mutation is available.
6. The feature uses no `services.search`, arbitrary URL fetching, direct provider
   API calls, new accounts, jobs, or outbound messages. Generation uses the existing
   shared adapter; no feature-specific environment variables or dependencies are added.

## Verification

With Node 24, run the targeted suite and repository typecheck:

```sh
node --import tsx --test tests/agent-read-later.test.ts
npm run typecheck
git diff --check
```

The tests use the committed isolated store/context fixture and fake generation
and bookmark services. They cover the complete reading flow, budget and progress
rules, input and stored-state validation, import isolation, generation failure,
unsupported citations, concurrent writes, retry purity, stale generation,
cancellation, timezone display, retention, deletion, and lossless bounded
exports. A Unicode quota test fills reserved capacity to 479,999 bytes, then
generates maximal summaries and a digest and finishes/archives every article,
checking every serialized write stays below 480,000 bytes. No tests access live
models, Slack, Redis, search, or article URLs.
