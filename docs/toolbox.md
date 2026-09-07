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

## Planned feature sequence

Each ships in a separately verified PR: bookmarks, checklists, prompts, snippets, journal, habits, time tracking, focus sessions, standups, retrospectives, decision scorecards, meeting agendas, glossary, goals, release readiness, countdowns, timezone planner, text formatter, and workload planner.
