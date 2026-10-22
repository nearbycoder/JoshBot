# Context batching

`/nobo-help agent context-batch` groups actions that share setup cost and fit your available location, tools, and minute budget. It works without model or search services. Results describe a proposed batch; they do not start timers, schedule work, or infer completion.

Start with `/nobo-help agent context-batch create Admin hour | 60`. Copy the returned full board ID in place of `BOARD` below; copy returned setup/action IDs in place of `SETUP`/`ACTION`.

```text
/nobo-help agent context-batch setup BOARD | expense portal | 8
/nobo-help agent context-batch action BOARD add File hotel receipt | 10 | expense portal | laptop | home
/nobo-help agent context-batch action BOARD add File train receipt | 5 | expense portal | laptop | home
/nobo-help agent context-batch batch BOARD | home | laptop
/nobo-help agent context-batch complete BOARD ACTION
```

The first batch uses 15 minutes of action time and one eight-minute setup: **23 minutes**, leaving 37. Paying setup separately would use 31 minutes. `batch` saves the context you explicitly enter, then computes an unsaved proposal. It leaves actions pending. Completion is explicitly user reported. Each invocation has a private reply and a complete next command.

## Deterministic selection

First exclude completed actions, missing tools, nonmatching locations, and actions with an unknown named setup cost. Every excluded action has its stable ID and all applicable reasons. A named setup must be recorded explicitly, even if its cost is zero. `-` means no setup, no required/available tools, or any location, depending on the field. A supplied location of `-` does not claim access to all locations.

Eligible actions form groups in the order their setup key is first encountered. Within each group, entered action order is stable. Select each action if its minutes, plus the group's setup cost when selecting its first action, fit the remaining budget. Skip oversized actions and continue to smaller later actions. Setup is charged once for each selected group; report action time, setup time, total, savings, remaining budget, and every exclusion. This bounded greedy heuristic makes no optimality claim. It treats each proposed batch as a new session and does not assume a previous session's setup is still available.

## Commands

Append these commands to `/nobo-help agent context-batch`:

```text
create TITLE | MINUTES
edit BOARD | TITLE | MINUTES
setup BOARD | KEY | MINUTES
setup-edit BOARD SETUP | KEY | MINUTES
setup-remove BOARD SETUP confirm
action BOARD add LABEL | MINUTES | SETUP-KEY | TOOL1,TOOL2 | LOCATION
action BOARD edit ACTION | LABEL | MINUTES | SETUP-KEY | TOOL1,TOOL2 | LOCATION
action BOARD remove ACTION confirm
batch BOARD | LOCATION | TOOL1,TOOL2
batch BOARD [page]
context-clear BOARD confirm
complete BOARD ACTION
reopen BOARD ACTION
list [page]
show BOARD [page]
export BOARD
delete BOARD confirm
help
```

`setup` adds or updates the exact named key. Renaming a setup with `setup-edit` updates referencing actions atomically. Removing an in-use setup is refused; first edit its actions to another setup or `-`. Editing an action reopens it, since its previous completion may no longer describe the action. `context-clear` removes stored available context. Removal requires the literal `confirm`; `delete BOARD` shows the exact confirmation command without changing anything. There is no hidden history.

Separate fields with `|`; use `\|` for a literal pipe and `\\` for a literal backslash inside a field. Unknown or trailing escapes and excess unescaped pipes are rejected. Fields are trimmed. Tools are distinct comma-separated labels; labels and setup keys match case-sensitively. Whole integers only: budget 1–10,080 minutes, action duration 1–1,440, setup cost 0–1,440. Title limit 160 UTF-8 bytes; action label 400; setup/location 80; at most eight tools of 40 bytes each. Pipe-field parsing includes adjacent whitespace in its byte bound. Empty fields are refused; use the explicit `-` sentinel where supported.

## Saved state and retrieval

Version 1 stores at most 12 boards, 40 actions and 12 setup keys per board. IDs are stable UUID-based IDs; revisions and ISO creation/update times remain inspectable. Context belongs to the containing board. Lists use ten records per current page. `show` returns complete JSON detail in pages of at most 3,500 JavaScript units; every page identifies the current revision, so restart page 1 if it changes. `batch BOARD [page]` recomputes the report from the current saved board. `export` returns exact compact JSON including the feature/version envelope, bounded to 24,576 UTF-8 bytes. Slash output is plaintext; entered mention/link syntax stays inert and is not double escaped.

New content must fit 32,768 serialized UTF-8 bytes. The feature ceiling is 49,152. Admission additionally constructs the worst-case state with every action `completed` and every revision at its maximum, checking both total bytes and each enveloped export. This proves room for accepted completion/status transitions rather than relying only on the 16,384-byte margin. Optional context edits and additional actions are new content. Counts can be reached after bytes. Quota errors preserve the old state; use `list`, `export`, and confirmed `delete` to recover capacity. Schema-invalid data is preserved and cannot be reset by ordinary commands; help remains available. Readable older data over the byte quota can still be inspected and removed.

All writes use the actual owner-scoped store and pure synchronous atomic transforms. IDs and timestamps are created before retryable transforms; concurrent changes are preserved. No model, source adapter, web search, sibling-feature access, cache, background work, or external actions occur. URLs are inert labels. Resource budgets are 0 generations, 0 searches, 0 context reads, 8 store reads, and 4 store updates per invocation; normal commands use at most one update and two reads (saving context and returning its batch uses both reads). Cancellation uses the inherited runtime signal; a save already dispatched may have completed, so inspect before repeating an interrupted mutation.

## Validation

`tests/agent-context-batch.test.ts` uses the real runtime/scoped store with the in-memory backend and throwing services. It covers the exact first example, 23-minute arithmetic, stable greedy exclusions, every edit/removal, complete maximum-capacity pages, escaped input, corrupt-state preservation, and Unicode quota admission followed by all accepted completions. Run with Node 24:

```sh
node --import tsx --test tests/agent-context-batch.test.ts
```

These checks establish local behavior, not live Slack delivery or deployment.

## Concurrent work and retry

Every mutation of an existing board captures its revision before updating and checks it on every CAS attempt. A winning edit, completion, evidence correction, or reopen on that record rejects the stale command, including edit-and-restore cycles. Inspect the exact `show ID` command in the reply, review the current work/status, then issue a fresh command with appropriate evidence. Changes to another record still retry safely. This conservatively rejects changes to any child of the same record; it does not add child revisions or retained history. Schemas and command syntax are unchanged. Creation needs no initial read; existing-record changes add one bounded state read.
