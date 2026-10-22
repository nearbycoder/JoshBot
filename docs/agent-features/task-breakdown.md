# Task breakdown

`/nobo-help agent task-breakdown` turns an outcome and success definition into effort-sized steps with observable proof. It tracks only explicit user-reported completion. It does not execute steps, infer completion, or write to checklists/workflows.

Start with `/nobo-help agent task-breakdown create Publish a short guide | Readers can install the app | 30`. Replace `WORK` with the returned full workspace ID, and `STEP` with a returned step ID:

```text
/nobo-help agent task-breakdown step WORK add Draft installation steps | 20 | A new user can follow all five steps
/nobo-help agent task-breakdown step WORK add Test the guide | 25 | Record a successful clean install
/nobo-help agent task-breakdown check WORK
/nobo-help agent task-breakdown next WORK
/nobo-help agent task-breakdown complete WORK STEP | Tested in a clean local folder
```

The check reports 45 total/remaining minutes, against a 30-minute session. Both individual steps fit. `next` returns the first unfinished executable step and its proof to collect. Repeated reads never advance it. Explicit completion saves your report and the injected invocation timestamp; the next unfinished executable action then becomes available. A completed workspace is not a claim that its overall success definition has been independently verified.

## Commands and deterministic rules

Append these commands to `/nobo-help agent task-breakdown`:

```text
create OUTCOME | SUCCESS | SESSION-MINUTES
edit WORK | OUTCOME | SUCCESS | SESSION-MINUTES
step WORK add ACTION | MINUTES | PROOF
step WORK edit STEP | ACTION | MINUTES | PROOF
step WORK remove STEP confirm
move WORK STEP | POSITION
check WORK [page]
next WORK
complete WORK STEP | REPORT
completion-edit WORK STEP | REPORT
reopen WORK STEP confirm
suggest WORK
list [page]
show WORK [page]
export WORK
delete WORK confirm
help
```

`check` flags a missing proof, a step longer than the session, and an action without a recognized leading English verb. It does not split or shrink a 45-minute step to fit a 30-minute session. Proof can be empty while drafting; it must be present for a step to count as executable. The verb check is deliberately a finite, disclosed heuristic: use a leading verb such as Draft, Test, Review, Write, Create, Check, or Prepare. It is not reliable natural-language analysis for every language or verb. `next` skips flagged pending steps and discloses their count; `check` gives all reasons. Edit or reorder commands can change which action is next.

`move` uses a one-based position in the current step list. Editing a completed step is refused until `reopen ... confirm`, which explicitly removes the old completion report and timestamp. `completion-edit` corrects the report while retaining the original completion time; the workspace update time records the correction. Repeating `complete` is refused and points to correction/reopen syntax. Root editing retains historical user-reported completions for inspection but invalidates in-flight suggestions. Review reports against any changed success definition. Remove/delete commands require confirmation and retain no hidden history.

Pipe fields use `|`; write `\|` for a literal pipe and `\\` for a literal backslash. Other/trailing escapes, extra fields, and malformed numbers are rejected. Input is trimmed. Bounds: outcome 160 UTF-8 bytes, success/proof 1,200 each, action 400, completion report 256. Session is 1–480 whole minutes; step effort 1–1,440. Titles/actions/success/reports are required. Empty proof is explicitly permitted. The raw command ceiling is 16,000 UTF-8 bytes; adjacent field whitespace counts toward parser bounds.

## Optional unsaved suggestions

Only `suggest WORK` calls the configured text model, at most once, sending this workspace's bounded entered data. No automatic generation occurs on create, list, show, check, or next. The model is asked for one to eight steps with action, whole effort minutes no longer than the session, and proof. Unknown fields, invalid steps, empty/malformed/oversized JSON, or a draft that cannot be displayed completely within 3,500 units are refused without repair or retry. Chosen steps must be added explicitly with the `step` command.

The input ceiling is 16,000 UTF-8 bytes, instructions 4,000 bytes, and accepted raw output 4,000 JavaScript units; the final complete draft must fit the normal reply limit. Large workspaces remain usable through deterministic commands but may be refused for optional assistance. Revision and existence are checked after generation, so editing success/steps or deleting a workspace while generation is pending discards the stale draft. Provider failures leave saved data unchanged and return a working `check` command. The generate API has no per-call token ceiling: post-generation bounds are not a guarantee about provider billing or output allocation.

## Privacy, capacity and complete retrieval

Version 1 stores at most 12 workspaces with 20 steps each. IDs are stable; revisions, timestamps, original inputs, statuses, and full reports are retained. Lists have ten records per current page. `show WORK [page]` exposes complete JSON detail on bounded pages with a revision label; restart page 1 if it changes. `check WORK [page]` exposes every flag. Exact compact `export` includes the feature/version envelope and is capped at 24,576 UTF-8 bytes. Slash output is plaintext; no double escaping is applied to entered mention or link syntax.

New content is admitted only at or below 32,768 serialized bytes and after proving its mandatory future lifecycle fits 49,152 bytes and each enveloped export fits 24,576. The projection gives every step the maximum completion report (256 quotes, producing 512 escaped JSON bytes), completed status, a full fixed-width timestamp, and the largest permitted revision. This reserves reports even for currently completed steps, permitting corrections up to the accepted maximum. It does not rely solely on the 16,384-byte margin. Counts may be limited by bytes first. Over-quota additions/edits leave saved state intact; lifecycle reports remain possible for admitted records. Export/remove individual workspaces to recover space. No expiry, silent eviction, or hidden history occurs.

The full schema is validated before mutations; malformed data is preserved rather than reset. Readable over-quota legacy records remain inspectable/removable. Writes use the owner-scoped runtime store with synchronous atomic transforms; IDs/time are generated outside retries. There are no context/source reads, search calls, private sibling access, background work, or external actions; URLs are inert. Per-command metadata budgets: one generation (only explicit suggest), zero search/context reads, eight store reads, four store updates. Typical commands use one read or update; suggest uses two reads. Abort uses the inherited signal. A save already dispatched cannot be promised to roll back; inspect before retrying after interruption.

## Validation

`tests/agent-task-breakdown.test.ts` uses the actual runtime/scoped store with in-memory storage. Six tests cover the documented full workflow, edits/removal, effort/verb/proof refusals, optional failure, count/byte/unknown-field validation with no repair calls, stale edit/delete during generation, maximum pages, and Unicode admission followed by all maximum-sized completion reports. No live provider, Slack, or deployment behavior is claimed.

```sh
node --import tsx --test tests/agent-task-breakdown.test.ts
```
