# Decision comparison coach

`decision-coach` is a private workspace for deliberating before deciding. Enter your options, criteria, evidence and ratings; compare them using your own weighted priorities and try temporary alternatives. It does not vote, announce a winner, record a final decision, or write to the existing channel decision log.

The module is ready for parent integration. The commands below become available when the parent registers `/nobo-help agent decision-coach` and private delivery.

## A complete example

Start with:

```text
/nobo-help agent decision-coach create Commute choice | Compare reliability and affordability
```

Copy the returned decision ID, including its `d_` prefix. Every created option, criterion and evidence entry also returns a stable ID. In the following commands replace `DECISION`, `TRAIN`, `BUS`, `RELIABILITY` and `AFFORDABILITY` with the corresponding returned IDs; these uppercase words are explanatory placeholders, not accepted aliases.

```text
/nobo-help agent decision-coach options DECISION add Train | Direct route
/nobo-help agent decision-coach options DECISION add Bus | Transfer downtown
/nobo-help agent decision-coach criteria DECISION add Reliability | 3
/nobo-help agent decision-coach criteria DECISION add Affordability | 1
/nobo-help agent decision-coach evidence DECISION add TRAIN | My commute diary | On time on four of five days.
/nobo-help agent decision-coach evidence DECISION add all | Personal preference | Arriving on time matters more to me than saving money.
/nobo-help agent decision-coach score DECISION TRAIN RELIABILITY 8 | Usually on time
/nobo-help agent decision-coach score DECISION TRAIN AFFORDABILITY 2
/nobo-help agent decision-coach score DECISION BUS RELIABILITY 6
/nobo-help agent decision-coach score DECISION BUS AFFORDABILITY 10
/nobo-help agent decision-coach compare DECISION
```

With these subjective inputs, Train scores `(3×8 + 1×2)/4 = 6.50`, and Bus scores `(3×6 + 1×10)/4 = 7.00`. This is a comparison of the user's assumptions, not evidence that one option is objectively better. The coach never chooses a final decision for you.

Try a sensitivity change:

```text
/nobo-help agent decision-coach what-if DECISION weight RELIABILITY 10
/nobo-help agent decision-coach what-if DECISION score BUS RELIABILITY 0
```

Each response shows the baseline and hypothetical comparison. Raising the reliability weight to 10 gives Train `7.45` and Bus `6.36`. Fully rated options also show their change in total. **Nothing is saved by what-if.** Use `criteria DECISION weight RELIABILITY 10` to explicitly save a new weight instead.

To deliberate with an optional model draft:

```text
/nobo-help agent decision-coach draft DECISION questions
/nobo-help agent decision-coach draft DECISION pros-cons
/nobo-help agent decision-coach evidence DECISION
```

Drafts use only this decision's supplied evidence and other entered fields, cite existing evidence IDs, and are labeled as tentative suggestions. They do not assign ratings or change weights. Questions may be general or option-specific; pros and cons must refer to an option. Option-specific items can cite only that option's evidence or shared evidence. Citation existence and scope are validated; whether an interpretation is supported still requires your review. Drafts are not saved. If generation fails, the workspace is unchanged. If the workspace changes, is archived, or is deleted during generation, the stale draft is discarded.

## Command reference

Prefix every command with `/nobo-help agent decision-coach`. Use exact returned IDs. `|` separates fields and cannot appear literally inside a field. Labels and descriptions may contain spaces without quotes. Subcommands are lowercase.

| Command | Behavior |
| --- | --- |
| `help` | Syntax and an example; no storage or model dependency. |
| `create <title> [\| <context>]` | Create a private active workspace. |
| `show` | List all active and archived workspaces. |
| `show <decision-id>` | Show options, weights, rating matrix, evidence IDs and revision. |
| `options <decision-id>` | List option IDs, labels and descriptions. |
| `options <decision-id> add <label> [\| <description>]` | Add an option with a distinct label. |
| `options <decision-id> rename <option-id> \| <label>` | Change its label while retaining scores and evidence links. |
| `options <decision-id> remove <option-id> confirm` | Remove the option, its ratings and its option-specific evidence. Shared evidence remains. |
| `criteria <decision-id>` | List criterion IDs and subjective weights. |
| `criteria <decision-id> add <label> \| <weight>` | Add a criterion with a distinct label and weight from 0 to 100. |
| `criteria <decision-id> weight <criterion-id> <weight>` | Save a changed weight. |
| `criteria <decision-id> rename <criterion-id> \| <label>` | Rename while retaining ratings and its stable ID. |
| `criteria <decision-id> remove <criterion-id> confirm` | Remove the criterion and its ratings. |
| `score <decision-id>` | List entered ratings and their optional reasons. |
| `score <decision-id> <option-id> <criterion-id> <0–10\|unknown> [\| <reason>]` | Save a subjective rating or explicitly return it to unknown. Replaces the previous rating and reason for that pair. |
| `evidence <decision-id>` | Show full supplied excerpts, source labels and IDs, within the reply length limit. |
| `evidence <decision-id> add <option-id\|all> \| <source label> \| <excerpt>` | Add option-specific or shared evidence. `all` is a literal keyword. |
| `evidence <decision-id> remove <evidence-id> confirm` | Remove an excerpt. |
| `compare <decision-id>` | Deterministic weighted comparison and missing-rating guidance. |
| `what-if <decision-id> weight <criterion-id> <weight>` | Simulate one changed weight without saving. |
| `what-if <decision-id> score <option-id> <criterion-id> <0–10\|unknown>` | Simulate one changed rating without saving. |
| `draft <decision-id> questions\|pros-cons` | Generate an unsaved, evidence-citing draft using the injected text-only model service. |
| `archive <decision-id>` | Make the workspace read-only. No final decision is recorded or sent. |
| `delete <decision-id> confirm` | Permanently remove one active or archived workspace, including its scores and evidence. |

In the notation above `0–10|unknown`, `option-id|all`, and `questions|pros-cons` mean choose one value, **not** type a pipe. Literal pipe separators are shown surrounded by spaces.

## Comparison semantics and limits

- Scores range from 0 to 10; **higher always means better**. For example, rate affordability rather than entering a raw monetary cost. Weights range from 0 to 100 and need not total 100. Both accept at most two decimal places.
- Weighted total is `sum(weight × score) / sum(weights)`. At least two options and one positive-weight criterion are needed. Zero-weight criteria do not affect totals or missing-rating coverage. Displayed totals, ranges, coverage and deltas are rounded to two decimals; ranking uses the underlying totals.
- Unentered ratings and `unknown` are missing data. A rating of `0` is a known zero. With missing positive-weight ratings, show a lower–upper possible total assuming unknown scores can lie anywhere from 0 to 10, plus the percentage of total weight that has a rating. **There is no ranking while any option is incomplete.** Bounds are not imputed scores, probabilities or confidence intervals. Fully rated ties are labeled as ties.
- At most 12 workspaces, including archived ones; each holds 6 options, 8 criteria, 48 option/criterion ratings, and 16 evidence excerpts. Limits are checked atomically. Archived workspaces stay readable and comparable, including what-if previews, but cannot be edited or used for new model drafts. There is no unarchive command.
- Title: 120 characters; context: 1,200; option/criterion label: 80; option description: 400; score reason: 200; evidence source label: 120; excerpt: 600. Commands are capped at 5,000 characters. Replies fit below 28,000 characters; an explicit shortening notice appears for unusually large rendered output. No automatic expiry or eviction; use confirmed deletion to free capacity. There is no export command.
- Evidence is user supplied and unverified. A URL in a source label is not fetched. To correct evidence, remove it and add a replacement; context and option descriptions are fixed at creation. Labels, scores and weights are editable. Model drafting requires at least one option and one supplied excerpt, makes one generation call, and accepts at most eight validated draft items. Models may still misinterpret evidence.
- There is no context import, web search, live price lookup, external communication, polling, decision-log entry or tool execution. All deterministic commands work without a model provider. Persisted data is strictly validated; invalid state is reported and left intact rather than silently reset. Store failures do not expose backend error details.
- Dates are stored as UTC ISO timestamps from `context.now`. Display dates use `context.timezone`; invalid time/timezone inputs are rejected before mutations. No server-local date assumptions are used.

## Exact parent integration needs

1. Import named `feature` or the default export from `lib/agent-features/decision-coach.ts`, register exact ID `decision-coach`, and route the command tail after `/nobo-help agent decision-coach` to `feature.execute(command, context)`. Add discoverable help/Home navigation in parent-owned integration files.
2. Supply an authenticated workspace/user/feature-scoped `AgentFeatureStore` with retryable atomic `update`. This module uses only the local key `workspace` and schema version 1. Never share this namespace between users. All IDs and timestamps are generated before transform callbacks; transforms are synchronous, replayable, and do not mutate their input objects. Every edit advances the workspace revision. Generation runs outside transactions and rechecks the revision before returning; no generated data is persisted.
3. Supply `now`, the caller's IANA `timezone`, and optionally an abort signal. Deliver **every** response privately, including help, errors, lists and drafts. Execute responses escape Slack's `&`, `<`, `>` constructs so supplied text cannot become mention/link syntax; preserve that behavior in the private renderer. Handle request deduplication and asynchronous private delivery in the runtime. A post-generation revision check identifies intervening edits; the returned draft labels its source revision rather than claiming a permanently current snapshot.
4. `services.generate` is needed only for `draft`, using the existing text-only, tool-free service. Only this decision's entered data is sent. `services.search` and `services.readContext` are unused. No new packages, shared contract additions, credentials, environment variables, backend adapters or production access are needed.
5. Run this feature's test alongside the integrated suite after registration. Child verification uses only fake services and scoped in-memory stores; it does not verify live Slack delivery, production persistence or model output quality.

Targeted verification:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-decision-coach.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```
