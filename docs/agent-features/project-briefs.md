# Project context and status briefs

`project-briefs` keeps a private context pack for a project: its purpose, constraints, open questions, user-recorded decisions, and explicitly selected personal sources. A brief refreshes those references, quotes useful excerpts and source-reported status, and optionally adds a cited synthesis. It does not infer a numeric progress score, change source records, or post to a channel.

Parent integration supplies the entry point `/nobo-help agent project-briefs <command>`. Commands below use that prefix. Replace the example project ID with the full `prj-…` ID returned by `create`; use actual source IDs returned by `sources`.

## A working flow

```text
/nobo-help agent project-briefs create Website launch | Ship the accessible customer portal
/nobo-help agent project-briefs update <project-id> constraints | Keep the current billing provider; accessibility is required.
/nobo-help agent project-briefs update <project-id> questions | Has the pilot customer approved onboarding? Which billing tests remain?
/nobo-help agent project-briefs update <project-id> decisions | Reuse the existing account system.
/nobo-help agent project-briefs sources note launch
/nobo-help agent project-briefs sources follow-up customer
/nobo-help agent project-briefs link <project-id> note <source-id>
/nobo-help agent project-briefs link <project-id> follow-up <source-id>
/nobo-help agent project-briefs brief <project-id>
/nobo-help agent project-briefs brief <project-id> --synthesize
```

The deterministic brief combines your project fields with refreshed evidence and its status, timestamps, missing-reference warnings, and coverage. It works without a model. `--synthesize` additionally makes one text-only generation call for a summary, potential tensions, and suggested next steps. Generated interpretation is labeled and must cite the project fields or an available linked source. Review suggestions before relying on them: citation validation cannot prove a generated claim is accurate.

## Commands

| Command | Behavior |
| --- | --- |
| `help` | Syntax and an example; no storage, context, or model access. |
| `create <title> \| <purpose>` | Creates a pack and returns a stable UUID-based project ID. |
| `list [all\|archived]` | Lists active projects by default; `all` includes archives. Also shows actual UTF-8 storage bytes and capacity including refresh reserves across all packs. |
| `show <project-id>` | Shows current project fields, saved reference state, and whether the saved brief is outdated. Does not refresh context. |
| `show <project-id> brief` | Reads the last saved brief without service calls. Clearly labels it as a saved snapshot and warns about subsequent project edits. |
| `sources <kind> [search text]` | Lists up to 20 matching owned source IDs of one kind. Searches IDs, titles and bounded excerpts case-insensitively. Never links automatically. |
| `link <project-id> <kind> <source-id>` | Resolves the exact kind/ID in owned context before linking it. Duplicate links are a no-op. |
| `unlink <project-id> <kind> <source-id>` | Removes this project's reference, leaving the original source unchanged. |
| `update <project-id> <field> \| <text>` | Replaces `title`, `purpose`, `constraints`, `questions`, or `decisions`. Use `-` to clear the last three fields. |
| `brief <project-id> [--synthesize]` | Refreshes only explicit references, builds and saves one reusable brief; optionally adds generated suggestions. |
| `archive <project-id> [undo]` | Archives or restores a pack. Archives remain readable and occupy a retention slot; restore before editing or refreshing. |
| `delete <project-id> confirm` | Removes the entire pack, source snapshots, and saved brief. Does not delete the original sources. |

Updates replace the whole selected field; use multiline text or semicolons for several constraints, questions, or decisions. A pipe separates the title/purpose or field/text; additional pipes are treated as part of the body. No natural-language command execution, background refresh, or automatic selection is performed.

Supported source kinds are `note`, `goal`, `habit`, `journal`, `bookmark`, `follow-up`, `reminder`, `monitor`, `digest`, `artifact`, `memory`, and `event`. Actual availability depends on the parent runtime's owned-context adapters. Source IDs are qualified by kind, so `note:abc` and `memory:abc` are distinct references. Pass the kind and raw source ID as separate command arguments.

## Freshness, separation, and failures

- Each project has its own explicit references. The same source can be deliberately linked to multiple projects; another project's fields and links never enter synthesis.
- `brief` reads the kinds needed by that project, then selects only exact linked kind/ID pairs. Unlinked content is not saved or sent to generation. `sources` reads only the requested kind.
- A source updated more than 30 days before the supplied current time is marked **STALE**. Missing or invalid update dates mean freshness is unknown. Dates more than five minutes in the future are flagged for verification. Older source text can still be useful; stale sources remain included with warnings.
- Changed snapshots are marked on refresh. Missing, malformed, or ambiguous duplicate references are reported and excluded from synthesis. The last successfully seen title and time remain available for diagnosis; previous missing-source text is not reused as current evidence. Missing means absent from the returned owned-context snapshot, not proof that the original record was deleted.
- All newly rendered dates use the caller's supplied IANA timezone. A saved brief retains the timezone it was originally rendered in and says when it was built. Invalid runtime timezones are rejected without falling back to the server timezone.
- A context or generation failure leaves the project and its previous brief unchanged. Retry `brief <project-id>` without `--synthesize` if generation is unavailable. Even if source refresh succeeded, it is not saved when the requested synthesis fails.
- Revision checks reject a generated or refreshed result if this project was edited, unlinked, archived, deleted, or refreshed concurrently. Retry the command against the latest project state. Independent project edits remain intact. Creation, field updates, archive, unlink, and deletion use atomic scoped-store transforms.
- Source documents and generated text are untrusted data, never commands or tools. Slack angle-bracket control syntax is neutralized in replies. No search, direct API calls, channel history, external writes, messages, account changes, or live inference tests are used by the implementation.

## Limits and retention

- At most 20 packs per workspace/user/feature, including archives; 8 references per pack. A **470,000-byte aggregate quota including refresh reserves** may bind before these count limits. Nothing is silently evicted. `list` shows usage; use `delete <project-id> confirm` to free capacity. Unlinking sources or shortening fields can also free capacity. Archiving retains data and does not free a slot or its byte reserve.
- Storage is measured with `Buffer.byteLength(JSON.stringify(value), "utf8")`, including Unicode and JSON escaping, rather than JavaScript string length. Every accepted write stays at or below 470,000 actual bytes, below the parent's 480,000-byte safety target and 512,000-byte store limit. Creation, links and field edits also reserve room for each pack's future refreshed snapshots and saved brief. Revision/date/status growth and archive/restore changes are prepaid, so accepted packs can still be processed when admission is full. Quota rejection preserves the entire previous state and provides deletion guidance.
- Title: 120 characters. Purpose: 1,000. Constraints, questions and decisions: 1,500 each. Commands: 6,000 total. Source IDs: 160, with no whitespace, pipes or angle brackets.
- At most 2,000 context items per service response. Oversized or malformed responses fail without saving. Discovery displays at most 20 matches; narrow with a kind and search text.
- Each snapshot stores at most 1,000 source-text characters, 160 title characters, and 100 status characters. Brief evidence displays at most 600 characters per source with truncation labels. Generation sees the stored, bounded source excerpts, not full documents, metadata, URLs, or other project packs.
- Only the latest brief is retained, up to 24,000 characters. Replies stay below Slack's approximately 28,000-character limit. Large combinations of fields, citations and generated text may require shorter fields or fewer links. Generated output is bounded to a 14,000-character raw response and three items of 350 characters per section, with validated citation lists. The rendered synthesis section additionally has a 12,000-byte serialized UTF-8 allowance; oversized suggestions are rejected without saving. Retry a shorter synthesis or use deterministic `brief`.
- Each invocation uses at most one generation call, zero searches, and one context read. These fit the shared runtime's limits of eight generations, six bounded searches, and a 120-second deadline. The runtime stops waiting promptly on cancellation/deadline and guards late writes; this module also checks cancellation after source reads and generation before saving.
- Packs and snapshots persist until deletion; archiving is organizational, not erasure. `show` and `show … brief` let you copy the current pack or latest reusable brief. There is no separate bulk export or version history.
- Structurally invalid persisted state fails closed with recovery guidance; it is never silently reset. Unknown extra properties are omitted when writing the validated, bounded schema.

## Exact parent integration requirements

1. Import `feature` (or the default export) from `lib/agent-features/project-briefs.ts` and register the exact ID `project-briefs` in the private agent command registry. Route the remaining raw command string to `feature.execute(command, context)`. Add help/Home discovery using its title, description and help string. No shared code is changed in this child implementation.
2. Use the implemented identity-checked, **workspace + user + feature scoped** `AgentFeatureStore.read/update`. This module uses only the local key `packs`, version `1`; `update` provides atomic optimistic retry semantics and does not commit when its transform throws. The module has pure synchronous retryable transforms and creates IDs/timestamps outside them. Its local 470,000-byte quota and future-capacity reservations stay below the shared store's 512,000-byte value ceiling. The shared runtime handles request deduplication, including repeated creates.
3. Supply `readContext(kinds)` with caller-owned context only, stable kind/ID pairs, bounded titles/text, and useful `updatedAt`/`status` when available. It must not return channel-wide or other-user data. Return no more than 2,000 items and avoid truncation that silently drops linked IDs; the present contract has no targeted-ID or pagination/completeness flag. Sources omitted by the adapter are reported as missing from its returned snapshot.
4. Supply text-only `generate({instructions,input})` with no tools for the optional `--synthesize` path through the implemented runtime. At most one call is made per request; no `search` implementation is required by this feature. Use the runtime's existing 120-second deadline, prompt cancellation and late-write guards; no additional deadline service or shared contract changes are needed. Deterministic briefs and all management commands work without generation.
5. Supply valid `now`, the user's IANA `timezone`, and optional cancellation `signal`; privately deliver the returned text and handle any asynchronous generation. Do not expose the scoped packs record as shared project context without a separate explicit integration design.

No new packages, environment variables, migrations, production credentials, outgoing jobs, or external accounts are required.

## Verification

Run only this feature's tests during parallel child implementation:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-project-briefs.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Tests use isolated JSON-cloning stores and fake context/generation services. Coverage includes the complete command flow, source selection and freshness, project/owner isolation, limits, malformed input/state, unknown citations, service failures, cancellation, retry purity, and refresh/edit/archive/delete races. Quota tests fill admission capacity, reject growth atomically, expand every accepted source to worst-case JSON-escaped Unicode, generate briefs, archive/restore across revision growth, and delete/recreate while checking that every write remains below 480,000 UTF-8 bytes.
