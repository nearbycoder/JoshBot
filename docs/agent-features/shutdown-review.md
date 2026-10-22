# Workday closure

Implemented locally; **not registered or deployed**. Parent integration owns registration, independent review and release.

Start `/nobo-help agent shutdown-review start 2026-10-22`. The returned review ID replaces `DAY` below; it is not the civil date. Prefix every command with `/nobo-help agent shutdown-review`.

- `loop DAY add TEXT`; `loop DAY edit LOOP | TEXT`; `loop DAY remove LOOP confirm`.
- `disposition DAY LOOP | done/defer/drop/wait | DATE/none | REASON` sets or replaces all disposition fields. Defer/wait require a valid review date on/after the review day; done/drop require `none`. `clear-disposition DAY LOOP confirm` removes it.
- `question DAY add TEXT`; `question DAY edit QUESTION | TEXT`; `question DAY remove QUESTION confirm` manage explicitly unresolved questions. Closing leaves them visible, without claiming they were answered.
- `first-step DAY | TEXT`; `clear DAY first-step confirm` set/remove tomorrow's restart cue.
- `edit DAY day | YYYY-MM-DD` changes the civil day and clears dispositions. Only one session may occupy a day.
- `check DAY` shows requirements, every loop/disposition/review date, questions and the first step. `close DAY` requires every loop's complete disposition and a nonempty first step. `reopen DAY` clears closure.
- `help`; `list [page N]`; `show DAY [page N rev R stamp HASH]`; `check DAY [page N rev R stamp HASH]`; `export DAY`; `delete DAY confirm`.

All changes to closed work reopen it. Editing a loop clears its old disposition. A closure is certification of the exact local content at that time, not completion of planner tasks or other external work. An old in-flight close cannot certify edited or removed work. Mutations compare the intended record's content on every CAS retry; unrelated sessions may change without blocking a retry. Revision ceiling updates still change content stamps.

Literal pipes/backslashes use `\|` / `\\`. Complete JSON detail/export exposes every accepted field and child ID. Lists have ten rows in civil-day/ID order. Show/check continuations bind revision plus content stamp and reject changed work before rendering. Exports contain the full record and envelope.

Strict version 1 schemas validate IDs, dates, exact disposition enums, counts and closure consistency before any write, including deletion. Malformed state is preserved. Eight logical state reads/four updates are the declared ceiling; every external service budget is zero. No polling, expiry, autoeviction, hidden history, model or source call occurs.

Limits: 20 sessions, 20 loops and 10 questions each; loop and first-step fields 300, questions 240, disposition reason 160 UTF-8 bytes. State has 32768-byte new-content admission and 49152-byte hard cap; complete per-record export is 24576 bytes, commands 16000 bytes, ordinary replies 3500 JS units. Admission additionally projects worst-case escaped disposition reasons, every admitted loop's review date, first step, close timestamp and all revision growth. This may reach byte limits before count limits. Later dispositions, first-step completion, close/reopen and explicit removal remain available at accepted capacity. New optional questions/text are content admissions. Use show/export before deleting unwanted records.

Local tests use actual runtime/scoped-store fixtures with fake backing storage. They cover exact catalog flow, all edit/remove paths, malformed enum/date/closure preservation, tenant isolation, real CAS close/edit races and unrelated retries, revision-ceiling removal, saturated lifecycle completion, complete Unicode/escaping pages and post-growth deletion. Run `node --import tsx --test --test-concurrency=1 tests/agent-shutdown-review.test.ts`. No live Slack, Redis or deployment verification is claimed.
