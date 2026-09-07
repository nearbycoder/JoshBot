# NoBo personal toolbox

Open **NoBo Home → Your NoBo tools → Personal toolbox**, select a tool, and Run `help`. Each result keeps the form open for the next command. You can also use `/nobo-help tools <tool> <command>`; replies are ephemeral. No additional Slack scopes, slash commands, accounts, services, or model calls are required.

Toolbox data is private to your Slack user **and workspace**, stored in the existing Redis instance (not the ephemeral artifact filesystem). This is application-level privacy, not end-to-end encryption: infrastructure administrators can access Redis. Do not store secrets. Entries remain until explicitly deleted or the existing Redis data is removed. The toolbox never automatically posts your content to a channel.

Every tool supports `help`, `list [search]`, `page 1` through `page 5`, `show <id>`, `rename <id> | <title>`, `tag <id> | tag1, tag2` (or `-` to clear), `export <id>` (JSON in the private response), and `delete <id> confirm`. Copy an ID from list; eight characters normally suffice. Delete is permanent; export first. Limits: 100 entries/tool/user/workspace, 16 KB/entry, 500 KB/tool including recent duplicate-request receipts. Concurrent updates use atomic compare-and-set; repeat Slack modal deliveries are deduplicated against the most recent 40 mutations per tool. An explicit new Run is a new request.

## 1. Private notebook (`notes`)

Capture, edit, append, search, tag and export personal notes. Examples:

```
add Launch ideas | Start with a small beta
append <id> | Invite five testers
edit <id> | Updated complete note
list beta
tag <id> | work, launch
```

## 2. Bookmark library (`bookmarks`)

Save HTTPS links with annotations and read/unread state: `add Slack docs | https://docs.slack.dev | API reference`. Use `queue`, `read <id>`, `unread <id>`, `annotate <id> | note`, or `url <id> | https://example.com`. Duplicate URLs are rejected, Slack-formatted links are normalized, credentials/non-HTTPS links are refused, and nothing fetches the saved URLs. Search title, URL, note or tags with `list <query>`.

## 3. Project checklists (`checklists`)

`create Release` makes a manual checklist, independent of thread-extracted follow-ups. Add `item <id> | Run tests`, mark `done <id> | 1` or `undo <id> | 1`, and see `progress <id>`. Item numbers remain stable after `remove <id> | 1 | confirm`. `reset <id> confirm` unchecks every item for reuse. Up to 50 items/list; nothing assigns work or posts to other people.

## 4. Reusable prompts (`prompts`)

`add Explain | Explain {{topic}} to a {{audience}}` saves a reusable prompt. Inspect `variables <id>`, then `render <id> | topic=Redis | audience=beginner`. All variables must be supplied exactly once; unknown/malformed variables are rejected and replacement is literal (never code execution). `edit <id> | template` replaces it. Rendering is a private preview, **not** an automatic model request; copy the result into a conversation when ready.

## 5. Versioned code snippets (`snippets`)

Save `add Query | sql | SELECT 1;`, retrieve with `copy <id>`, and revise via `edit <id> | SELECT 2;`. `history <id>` displays the last five versions. `restore <id> | 1 | confirm` creates a new revision from a retained version; it does not erase history in place. Language labels are validated, revisions are capped at 2,000 characters, and code is **never executed**.

## 6. Daily journal (`journal`)

Record `write 2026-09-07 | 4 | Shipped a feature | Test earlier` (date, mood 1–5, wins, lessons). Writing the same date updates that entry instead of duplicating it. `entry 2026-09-07` retrieves it; `review 2026-09-01 | 2026-09-30` returns an inclusive chronological digest and average mood. Dates are explicit calendar dates, not inferred timezones; reflections never go to a model automatically.

## 7. Habit tracker (`habits`)

`create Read daily | 5` sets a weekly check-in target (1–7). Use `check <id> | 2026-09-07`, correct mistakes with `uncheck`, and inspect `stats <id> | 2026-09-07`. Reports show a current streak (including an unbroken run ending yesterday), best streak, last-seven-day progress and total check-ins. Duplicate dates do not double count; future dates are rejected. Dates are explicitly UTC. Up to 366 check-ins per tracker; export and create a new yearly tracker when full. This does not schedule notifications.

## 8. Time tracking (`timelog`)

`start NoBo | Review PRs`, `active`, and `stop` maintain one running timer. Backfill `log NoBo | 2026-09-07T09:00:00Z | 2026-09-07T10:00:00Z | Review` or correct `adjust <id> | <start ISO> | <end ISO>`. Endpoints must include Z/an offset; overlapping or future completed entries and spans over 24 hours are rejected. A forgotten timer can be corrected with adjust. `report 2026-09-01 | 2026-09-07` sums each project's time, clipping sessions at the inclusive UTC date boundaries and including elapsed running time.

## 9. Focus sessions (`focus`)

`start Write proposal | 25 | 5` starts a work/break session. `status <id>`, `pause <id>` and `resume <id>` use persisted timestamps, so restarts do not reset the countdown. Once a phase finishes, `next <id>` starts the next phase and counts completed work blocks. `finish <id>` ends the session without awarding an incomplete block. Only one session can be active. Work is 1–180 minutes and breaks 1–60. **No automatic notification is sent**; check status or separately use the existing NoBo reminder feature.

## 10. Standup builder (`standups`)

Create a private update with `create 2026-09-07 | NoBo`. Fill `yesterday <id> | ...`, `today <id> | ...`, and `blockers <id> | None`. `draft <id>` produces a clean copyable update. `carry <id> | 2026-09-08` moves today's plan into the next draft's yesterday section and retains blockers, without overwriting an existing draft. Nothing is posted or scheduled automatically.

## 11. Retrospective boards (`retros`)

Prepare a **personal** retro with `create Sprint 12`, then `add <id> | keep | Small PRs` (categories: keep, change, try). Cards have stable numbers. Set `priority <id> | 1 | 5`, `edit <id> | 1 | Updated thought`, `resolve <id> | 1` or `reopen`. `report <id>` groups cards by category and sorts by priority. Up to 50 cards; this is private preparation, not a shared voting board.

## 12. Decision scorecards (`scorecards`)

`create Choose architecture`, add `criterion <id> | Simplicity | 5` (weight 1–10), add `option <id> | Bolt`, then `score <id> | Bolt | Simplicity | 4` (0–5). `rank <id>` requires every pairing, computes weighted percentages and identifies a tied top score. Repeating criterion updates its weight; repeating score corrects that pairing. Remove an option/criterion via `remove-option` or `remove-criterion <id> | name | confirm`. Up to ten of each. Rankings transparently reflect your judgments, not model advice.

## 13. Timeboxed meeting agendas (`agendas`)

`create Planning | 45` sets a minute budget. Add `topic <id> | Scope review | Josh | 15 | Agree on scope` with owner and desired outcome. `timeline <id>` displays time windows and highlights overruns. Reorder with `move <id> | <topic number> | <position>`, resize with `minutes <id> | <topic number> | 10`, or `remove <id> | <topic number> | confirm`. Stable topic numbers, up to 30 topics. Owners are labels only; this does not invite or notify anyone.

## 14. Personal glossary (`glossary`)

`define ADR | Architecture decision record` saves a definition; `alias <id> | Decision record` adds a synonym. `lookup adr` resolves exact terms/aliases case-insensitively; `list <query>` searches definitions and titles. Use `revise <id> | Updated meaning`, `unalias <id> | alias`, or test recall via `quiz <id>` followed by `answer <id>`. Alias collisions are rejected. This glossary is personal, not injected into other users' model context.

## 15. Measurable goals (`goals`)

`create Read books | 12 | books | 2026-12-31` tracks a numeric target that increases from zero. Record an **absolute total**, not an increment, using `progress <id> | 3 | Finished a novel`; lower totals are allowed for corrections. `report <id>` shows percentage, deadline status, remaining amount and required daily pace. Adjust `target <id> | 15` or `due <id> | 2027-01-31`. The latest 20 check-ins are retained, with five shown in reports. Dates are UTC; this is progress tracking, not automated coaching or reminders.

## 16. Release readiness (`releases`)

`create v1.2`, then `gate <id> | Tests | Josh`, records a release checklist with owners. Use `record <id> | 1 | pass | CI run URL/details` or `blocked | Failure details`; each record needs 5–500 characters of evidence. `readiness <id>` is ready only when at least one gate exists and all gates pass. `reset <id> confirm` clears evidence for reuse. **This is a manual record: it does not run CI, validate the evidence, contact owners, merge or deploy.**

## 17. Milestone countdowns (`countdowns`)

`add Launch | 2026-10-01` saves a date. `count <id>` shows calendar days and weekdays remaining (or elapsed for past dates); `upcoming 30` returns active milestones in the next 30 days, including today. `reschedule <id> | 2026-10-15`, `archive <id>`, and `restore <id>` manage changes without losing the record. Dates use UTC. Weekday counts exclude Saturdays/Sundays **but not holidays**; no notifications are scheduled.

## 18. Timezone meeting planner (`timezones`)

Save `create Team | America/Chicago, Europe/London`. `convert <id> | 2026-09-07T15:00:00Z` converts an exact instant using the runtime's IANA/DST rules. `overlap <id> | 2026-09-07T00:00:00Z | 60 | 9 | 17` finds hour-long weekday meetings fitting everyone's local 09:00–17:00 window in the next 48 hours, showing the first ten candidates. Use 30-minute duration increments, up to eight zones, and daytime windows (no overnight shifts). `zone` adds a zone; `remove-zone <id> | Asia/Tokyo | confirm` removes it. Holidays are **not** excluded. No calendar access or invitations.

## 19. Text formatting workbench (`textkit`)

`save Draft | First line` stores text (multiline is supported). Use `preview <id> | bullets` without changing it, or `apply <id> | numbered` to save. Formats: trim, bullets, numbered, dedupe (exact trimmed lines), sort, ASCII slug, and JSON pretty-print. `edit <id> | New text` also supports one-step `undo <id>`. `stats <id>` reports word count, visible Unicode graphemes, lines and UTF-8 bytes. JSON rejects unsafe integers/nonfinite numbers; quote large IDs. No model calls or code execution.

## 20. Weekly workload planner (`workload`)

`create This week | 2026-09-07 | 30` sets a Monday-starting plan and hour capacity. Add `task <id> | Ship toolbox | 4 | 5 | 2026-09-09` (estimate, priority 1–5, due date). `plan <id>` prioritizes overdue work, then priority and deadline; it fits whole tasks into capacity and explicitly lists deferred work. Completed estimates consume capacity. Correct `effort`, `priority`, `due`, or `capacity`; mark `done <id> | 1` and `undo`. Up to 50 tasks, no assignments or calendar bookings. This is a greedy planning aid, not an optimal scheduling solver.

## Input and privacy notes

The Home picker is alphabetical. `show <id>` gives a readable tool-specific view; `export <id>` retains the complete JSON record. The command field resets to `help` after a Run so a previous save is not accidentally repeated. To include a literal pipe in a field, write `\|`; write `\\` for a literal backslash. Multiline text is supported. New Run submissions are intentional new operations; retry receipts only deduplicate the same Slack delivery.

Deleting an entry also clears cached reply content for that tool, while retaining recent request IDs to prevent delayed retries from recreating deleted data. Redis backups follow the existing infrastructure retention policy.

All 20 features shipped separately in PRs #30–49. Every PR runs the full test suite, typecheck, dependency audit and build in CI before merging. No additional production dependencies, Slack scopes, registered commands or services were added. The final integration review covers every tool's lifecycle and the private modal boundary. Existing Redis backup/retention policies still apply; export important entries rather than treating this as the only copy.
