# Resumable personal workflows

`workflows` runs private, text-only tasks in an inspectable sequence. A workflow contains an explicit input, one to six instructions, and one durable run with saved step outputs. Each step sees the original input and the immediately preceding saved output. It can extract, draft, summarize, or transform text; it cannot execute code, fetch a URL, send a message, or change an account.

The parent must register this feature before these entry points are available:

```text
/nobo-help agent workflows help
/nobo-help agent workflows create Launch update | Beta is ready; testing takes two days; review is Friday. | Extract facts and open questions | Draft a short status update | Make the update more concise
```

Creation returns a stable `wf_<UUID>` ID. Replace `<id>` below with that full ID.

```text
/nobo-help agent workflows run <id>
/nobo-help agent workflows inspect <id>
/nobo-help agent workflows output <id> 2
/nobo-help agent workflows resume <id>
/nobo-help agent workflows output <id> 3
```

`run` saves at most two step outputs, then pauses if there is more work. `resume` advances at most two more steps. The three-step example therefore pauses after drafting the update and completes after the separate resume invocation. Generated outputs are drafts, not verified facts or evidence that external actions happened.

## Commands

| Command after `workflows` | Behavior |
| --- | --- |
| `help` | Syntax, example, and limits; no storage or model access. |
| `create <title> \| <input> \| <step 1> [\| <step 2> ...]` | Save a ready workflow. No generation occurs yet. Literal `\|` characters separate fields; there is no escape syntax for including one in a field. |
| `list` | Show IDs, titles, run states, checkpoint counts, and saved/reserved storage bytes. |
| `inspect <id>` | Show state, revision, original input preview, all step instructions/previews, and the next action. Update time uses the runtime-supplied timezone. |
| `input <id>` | Read the complete original input. |
| `output <id> <step number>` | Read a complete saved step output; step numbers start at 1. |
| `run <id>` | Start a ready workflow and advance at most two steps. |
| `pause <id>` | Pause ready/running work. Invalidate an active attempt immediately; its late output cannot be saved. |
| `resume <id>` | Continue paused work from the first step without a saved output. An interrupted in-flight step is generated again. |
| `retry <id>` | Retry the first unsaved step of a failed/interrupted workflow, then advance at most one further step. Earlier checkpoints stay intact. |
| `edit <id> <step number> \| <new instruction>` | Change an existing unfinished step. Keep ready work ready; otherwise pause it and invalidate any active attempt, even if a different unfinished step was edited. Saved checkpoints cannot be edited. |
| `cancel <id>` | Permanently cancel unfinished work and invalidate the active attempt. Keep saved input/instructions/checkpoints readable. |
| `delete <id> confirm` | Remove the complete workflow, including its input, instructions, and saved outputs. Active work cannot recreate it. |

For example, after the initial `run` of the launch-update workflow:

```text
/nobo-help agent workflows edit <id> 3 | Keep it under 80 words and make the open question explicit
/nobo-help agent workflows resume <id>
/nobo-help agent workflows output <id> 3
/nobo-help agent workflows delete <id> confirm
```

A workflow is a single run, not a reusable template. Create another workflow to rerun completed or cancelled work. Input, title, step order, and step count remain fixed after creation. Editing a saved checkpoint is intentionally unsupported because later checkpoints depend on it.

## Failure and concurrency behavior

Every start obtains a random ownership token and increments the run revision in an atomic store update. Saving each output requires the same token and revision. Pause, cancel, deletion, and edits revoke ownership, so an old model response or provider error cannot replace a newer state. Concurrent resume/retry calls cannot both advance an active step. Unrelated workflow updates share the same atomic state transaction and preserve each other's changes.

Provider rejection, empty/non-text output, or output over 2,000 characters marks the unsaved step `failed`. Earlier outputs and original input are preserved. Raw provider errors are not displayed or stored. Use `retry`, or edit an unfinished instruction and then resume.

The command stops waiting for each generation after **45 seconds** and marks the run `interrupted`. Model work also has a **100-second invocation budget**, measured from the start of command processing: storage latency reduces the time available for the next step. A step is not started with an exhausted budget, and a late result cannot be saved. This leaves headroom for checkpoint writes and delivery before the shared runtime's **120-second deadline**. Unbounded storage delays still rely on the runtime deadline.

An aborted request stops waiting promptly. The shared runtime guards storage writes after abort, so the feature may be unable to save an `interrupted` status in that same request. The last saved checkpoint remains intact; a running claim is recovered through expiry in a fresh request. The supplied generation service has no cancellation parameter: a timed-out, paused, edited, or cancelled call may continue upstream, but its late result is ignored. A new explicit retry/resume may therefore overlap with old discarded inference, while checkpoint advancement remains exclusive.

If the process dies or a checkpoint cannot be confirmed in storage, the claim expires after five minutes. A later `inspect`, `list`, or run-control command detects expiry, records `interrupted`, and offers explicit `retry`. There is no background lease recovery or automatic retry. Recovery cannot know whether the old model finished; it never reports an unsaved step as completed. Retrying may incur another generation call.

All state is validated before use or mutation. Unsupported/corrupt records produce a recovery message and remain unchanged; they are not silently reset. Model output is never parsed as a command, step list, URL-fetch request, or executable code. The prompt distinguishes step instructions from untrusted source text; text-only services enforce the lack of external capabilities, not a claim that prompt injection is impossible.

## Limits and retention

- At most **10 workflows**, subject to a stricter byte quota, per supplied workspace/user/feature namespace; create fails at capacity rather than evicting prior work.
- New/admitted state stays **below 480,000 UTF-8 bytes**, leaving margin under the shared store's 512,000-byte ceiling. Measurement uses `Buffer.byteLength(JSON.stringify(state), "utf8")`, including Unicode and JSON escaping.
- Admission reserves space for **all remaining outputs**, including worst-case JSON expansion (six bytes per UTF-16 code unit), output separators, maximum revision width, and lifecycle/status/lease fields. Accepted work can still be processed, interrupted, retried, or cancelled at quota. Instructions edited later must fit the same reservation budget; rejected creates/edits preserve existing data.
- `list` reports bytes saved and bytes including reservations. On a quota error, use `delete <id> confirm`, reduce input/instruction size, or create fewer steps. Six-step workflows consume more reserved space than one-step workflows; Unicode and JSON escapes can reduce the number that fit even at equal character counts. Existing runtime-readable records from before this quota remain inspectable/deletable while over quota, but cannot grow or start new work without sufficient reservations.
- **1–6 steps** per workflow; **2 generation calls**, **0 searches** maximum per run/resume/retry invocation, within the runtime limits of eight generation calls and six searches. Generation waits at most **45 seconds per step** within the **100-second work budget**.
- Title: **120 characters**. Original input: **4,000**. Each step instruction: **500**. Each output: **2,000**. Whole command: **8,000**. Limits count JavaScript string code units.
- Outputs are validated before saving; oversized generated text fails rather than being silently truncated. Inspection uses bounded previews; `input` and `output` expose the full saved text.
- Replies escape Slack control sequences and stay below 28,000 characters, including worst-case escaping. No rich blocks or outbound delivery are emitted by this module.
- Records remain until `delete <id> confirm`. There is no export file, auto-expiry, version history, rerun, recurring trigger, worker, tool execution, owner-context lookup, or web search.
- Timestamps are UTC ISO strings in storage; inspection uses the supplied timezone, and generation receives that timezone and the invocation clock. No server-local timezone is assumed.

## Parent integration requirements

1. Import the named `feature` (or default export) from `lib/agent-features/workflows.ts` and register its exact ID, **`workflows`**, with the shared private `/nobo-help agent <id> <command>` router and help/Home discovery.
2. Supply the `AgentFeatureContext` contract with authenticated workspace/user identity, a valid `now` and timezone, optional request abort signal, and a store namespace isolated to workspace/user/**workflows**. This module uses only the relative key **`state`**, with schema `{ version: 1, workflows: [...] }`.
3. Use the parent-owned shared `store.update` implementation with atomic compare-and-swap transactions across processes, synchronous retryable transforms, JSON value semantics, and abort guards. A read/modify/write adapter without CAS cannot provide ownership, cancellation, or checkpoint guarantees. All UUIDs/timestamps and service calls are outside transforms. The feature measures and reserves bytes inside pure transforms; no shared-store changes are needed.
4. Supply `services.generate` as bounded text-only inference with no tools or external writes. Neither `search` nor `readContext` is used. Honor the instruction/output budget in the adapter where possible; the module rejects oversized responses. No additional service or shared-contract change is required.
5. Acknowledge Slack commands promptly and deliver responses privately/asynchronously through the shared runtime's 120-second deadline and cancellation/write guards. The feature uses at most two 45-second generation waits and a 100-second work budget, leaving saving/delivery headroom. Retain runtime request deduplication; this feature does not retain request IDs or deduplicate separate `create` requests.
6. Persist only the scoped state. No Redis key scanning, Slack API access, provider SDK, scheduler, package change, or environment secret is needed here.

## Verification

Targeted fake-service tests cover the complete flow, invalid commands and persisted data, provider failure/retry, two-step limits, concurrent ownership, cancellation, active/future-step edits, pause/resume, deletion, abort, generation timeout, expired claims, storage failure recovery, pure retryable transforms, capacity, timezone rendering, scoped isolation, and worst-case response escaping. Quota/deadline cases cover CJK UTF-8 text, JSON control characters, lone surrogates, full output/lifecycle headroom, atomic edit rejection, legacy over-quota deletion, a reduced second-step timeout, exhausted work budgets, and recovery when runtime abort guards prevent interruption writes.

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-workflows.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

No live inference, outbound messages, production services, deployments, or recurring work are exercised.
