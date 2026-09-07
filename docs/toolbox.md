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

## Planned feature sequence

Each ships in a separately verified PR: bookmarks, checklists, prompts, snippets, journal, habits, time tracking, focus sessions, standups, retrospectives, decision scorecards, meeting agendas, glossary, goals, release readiness, countdowns, timezone planner, text formatter, and workload planner.
