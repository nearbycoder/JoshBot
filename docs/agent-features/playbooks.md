# User-taught reusable playbooks

Use `/nobo-help agent playbooks help` for commands. This is one of the original twenty personal agents deployed in PR #58, with private replies and Home discovery. See [verified release status](../personal-agent-expansion.md).

`playbooks` saves private text procedures with typed inputs, explicit placeholders,
ordered steps, revision history, previews and saved run results. Each step receives
the earlier steps' drafts. Unlike a saved prompt string, a playbook validates its
inputs and preserves the exact procedure version used for each successful run.

Use `/nobo-help agent playbooks` as the command prefix. Examples below use that prefix
for creation; subsequent examples show the text after the prefix. Replace `BOOK_ID`
and `RUN_ID` with the full IDs returned by the feature, including `pb_` or `run_`.

## Teach, inspect and run

Teach a two-step launch-brief procedure:

```text
/nobo-help agent playbooks create {"title":"Launch brief","goal":"Explain {{topic}} to {{audience}}","inputs":{"topic":"text","audience":"text","bullets":"number","formal":"boolean","day":"date"},"steps":["Extract confirmed facts about {{topic}} for {{day}} from supplied context. Flag missing information.","Using the previous step, draft {{bullets}} bullets for {{audience}}; formal={{formal}}. Label suggestions and do not invent commitments."]}
```

```text
list
storage
show BOOK_ID
preview BOOK_ID {"inputs":{"topic":"Search beta","audience":"customers","bullets":3,"formal":false,"day":"2026-10-23"},"context":"Opt-in beta opens October 23. There is no confirmed public launch date."}
run BOOK_ID {"inputs":{"topic":"Search beta","audience":"customers","bullets":3,"formal":false,"day":"2026-10-23"},"context":"Opt-in beta opens October 23. There is no confirmed public launch date."}
runs BOOK_ID
run-show RUN_ID
```

`preview` displays the substituted goal, each step, input values, supplied context,
timezone, version and call count. It makes no model calls and saves nothing.
`run` substitutes the same values and makes one text-only generation call per step,
in order. A later step receives earlier outputs as a numbered array of draft text;
there is no special `{{step}}` placeholder. Results are explicitly labeled drafts,
not verified facts or completed external actions. `runs` without an ID lists all
retained runs. `run-show` includes the original procedure snapshot, inputs, context,
timezone, start timestamp and step outputs.

The optional `context` field is pasted source text, not a retrieval query or URL
to fetch. Omission means no source context. The feature does not implicitly read
notes, memory, channels or any other personal data. Source text, input values and
earlier model outputs are untrusted data. No shell, network, tool, scheduling,
account-change or outbound-message operation can be executed by a playbook.

## Typed inputs and literal substitution

Definitions declare 1–8 named inputs in an object. Names start with a lowercase
letter and contain only lowercase letters, digits and underscores, up to 32
characters. `constructor` and `prototype` are reserved. Every declared input is
required; unknown inputs are rejected. There are no defaults or implicit coercions.

| Type | JSON example | Validation |
| --- | --- | --- |
| `text` | `"customers"` | Nonblank string, at most 1,000 characters |
| `number` | `3` | Finite JSON number, absolute value at most 1 trillion; decimals and zero allowed |
| `boolean` | `false` | JSON `true` or `false`, not quoted strings |
| `date` | `"2026-10-23"` | Real `YYYY-MM-DD` date, year 0001–9999, interpreted in the supplied user timezone |

Use exact `{{input_name}}` syntax in the goal and steps. Unknown or malformed
placeholders are rejected when teaching or revising. Substitution happens once:
braces, dollar signs, code or URLs inside input values remain literal data. Values
are not templates, expressions or commands. Titles are labels and are not expanded.
All declared inputs are also included as typed JSON data for each generation step.

## Revise and restore

```text
history BOOK_ID
show BOOK_ID 1
revise BOOK_ID 1 {"steps":["Identify supported facts about {{topic}} from the context.","Draft {{bullets}} concise bullets for {{audience}} using those facts; formal={{formal}}."]}
show BOOK_ID
rollback BOOK_ID 1
```

`revise` takes the current version number and a JSON patch containing any of
`title`, `goal`, `inputs` and `steps`. Supplied fields replace those fields in full;
unsupplied fields remain. Update inputs and their referencing templates together
when renaming or removing placeholders. The complete resulting definition must
validate. A stale version number rejects the edit with the new current version,
so concurrent edits cannot silently overwrite one another.

`rollback` copies a retained version into a **new** version and records its origin;
version numbers never rewind. Existing runs keep their original version snapshots,
even after that version falls out of the editable history. A run in flight is
discarded if the playbook is revised, restored or deleted before the run commits.
The feature checks again between steps and atomically when saving. Changes to
other playbooks or concurrent successful runs are retained.

## Bounds, failure behavior and deletion

- At most 10 playbooks, with the latest 8 versions per playbook. A full collection
  requires explicit deletion before adding another playbook.
- Up to 10 successful runs across the feature, also bounded by a separate
  170,000-byte run-history budget. Successful saves evict the oldest committed
  runs until both limits fit, and report the eviction. Each retained run keeps
  its own version snapshot. Failed or cancelled runs never evict history.
- Definitions and their version history are capped at 300,000 serialized UTF-8
  JSON bytes, including the root object with an empty run array. Runs cannot
  consume this budget, and definitions cannot consume the 170,000-byte run
  reserve. Even a maximum-size successful run fits that reserve; accepted
  playbooks can still run when definition storage is full. Full state stays below
  470,000 bytes, under both the requested 480,000-byte feature ceiling and the
  runtime's 512,000-byte value limit. Byte accounting includes JSON escapes and
  multibyte text, not just JavaScript string length.
- `storage` reports both quotas and current counts. An oversized create, revision
  or rollback is rejected without changing data and gives deletion guidance.
  Use `delete BOOK_ID confirm` to free definition/version space or
  `forget-run RUN_ID confirm` to remove one saved result. Deleting runs does not
  increase the separate definitions quota. Inspection and deletion require no
  extra retained space; ordinary revisions/rollback retain at most 8 versions.
- Titles: 100 characters. Goals: 600. Steps: 1–4, each at most 1,200 characters.
  Each command can make at most 4 generation calls; there are no automatic retries.
- Combined input values: 3,500 characters when JSON encoded. Context: 3,000
  characters. Expanded goal: 1,500. Each expanded step: 3,500. Oversized expansions
  are rejected before generation. JSON command payloads are capped at 18,000
  characters; entire commands at 20,000.
- Each generated step output is capped at both 3,000 characters and 6,000 UTF-8
  bytes as a JSON string, with an explicit truncation marker counted in those
  bounds. Truncation preserves Unicode code points. Later steps receive that
  bounded output; even heavily escaped inputs and earlier outputs stay within
  the runtime's 80,000-character generation-input limit. Slack-safe replies are
  capped at 27,000 characters after escaping `&`, `<` and `>`; unusually large
  displays are marked as truncated. Truncation does not enlarge saved content.
- A failed or empty/non-text generation response saves no run or partial steps
  and leaves existing records intact. Retry manually when the provider recovers.
  No generated content ever updates a playbook definition.
- Cancellation is checked before generation, after each result and before the
  atomic save. The shared runtime stops waiting promptly on cancellation or its
  120-second invocation deadline, and its scoped store guards late writes. An
  underlying provider request may still finish, but its late result is not saved.
  The feature relies on those runtime cancellation/deadline guards rather than
  starting independent timers; store transforms remain pure and synchronous.
- An invalid persisted shape is rejected instead of silently replacing data.
  Help remains available; a maintainer must inspect or recover the scoped state.
- Store inputs/context only when a run succeeds. Do not include secrets: retained
  runs include their original values and pasted context. Deletion affects this
  feature's state, not any model-provider retention or previously delivered replies.

```text
forget-run RUN_ID confirm
delete BOOK_ID confirm
```

`forget-run` removes one saved run and its associated data. `delete` removes the
playbook, all retained versions and every run belonging to it. No scheduled work,
external accounts, messages or artifacts are created. `help`, inspection, preview,
revision, restoration and deletion do not require a model provider.

## Runtime and source contract

1. `registry.ts` registers the named/default `feature` from `lib/agent-features/playbooks.ts` as `playbooks`. `index.ts` dispatches `/nobo-help agent playbooks <command>` through the shared runtime; the Slack route returns private text and Home exposes its help. The shared route preserves multiline command text; individual commands still enforce their input rules.
2. The runtime supplies `AgentFeatureContext` with the caller's workspace/user/feature-scoped
   store. This module uses only the key `playbooks-state`, schema 1; its store
   transforms are pure, synchronous and safe to retry. Provide atomic updates
   capable of preserving concurrent commands. No shared contract changes are
   required. Definitions are capped at 300,000 serialized UTF-8 JSON bytes and run
   history at 170,000 bytes, keeping full state below 470,000 bytes and compatible
   with the shared 512,000-byte storage limit.
3. Pass the command text after the feature ID intact, including JSON quotes and
   whitespace. Supply a valid `now` and IANA `timezone`; dates never use the server's
   local timezone. Version/run timestamps are ISO UTC instants, and each run stores
   the timezone separately.
4. The runtime provides `services.generate` as text-only inference with no tools. This feature
   never calls `search` or `readContext`, and uses no credentials or other services.
   Generation requires at most four sequential calls and zero searches, within
   the runtime's eight-call/six-search budgets. Use the shared 120-second deadline,
   abortable services and guarded store, asynchronous private delivery and request
   deduplication. Repeating an accepted `run` command with a new request ID creates
   a separate run. Results stay below the runtime's 28,000-character output cap.
5. Deliver all returned strings privately and apply normal owner/access checks.
   Responses escape Slack control characters and label generated output as drafts.
   Do not send these results to a channel or interpret generated text as actions.

No dependencies, package changes, migrations of existing saved prompts, production
access or feature-specific context adapters are required.

## Verification

```sh
node --import tsx --test tests/agent-playbooks.test.ts
npm run typecheck
git diff --check
```

Tests use the shared scoped-store fixture and fake services only. They cover the
complete command flow, malformed definitions and typed values, placeholder safety,
provider errors, concurrent mutations/runs, stale-run rejection, retried pure
transforms, reserved run capacity at the Unicode definition quota, byte-based
history eviction, snapshot integrity, invalid stored state, timezones,
cancellation, runtime request/output limits and deletion.
