# Personal automation review

`automation-audit` is an on-demand, private health and history review of your permitted reminders, monitors and digests. It explains suspicious timing, old records, vague purposes and duplicate candidates. It never runs, edits, disables or deletes jobs, and never sends a message to another person. No model or web access is required.

The parent must register the feature and supply the context adapter described below before these commands are available.

## Commands and example flow

Prefix every command with `/nobo-help agent automation-audit`.

| Command | Behavior |
| --- | --- |
| `help` | Show commands without reading automation context. |
| `review` | Read owner-scoped context once, save a dated snapshot, and show upcoming occurrences and up to 12 open recommendations. |
| `inspect <source-id> [snapshot-id\|latest]` | Show saved source metadata, provenance, validation warnings and related suggestions. Defaults to the latest snapshot. |
| `history` | List the eight most recent retained snapshots. |
| `show [snapshot-id\|latest]` | Show a saved review, including dismissed suggestions. |
| `compare [older-snapshot-id newer-snapshot-id]` | Compare two saved snapshots; without arguments, compare the latest two. Show changed fields, newly observed/missing sources, and changed suggestions. |
| `dismiss <suggestion-id>` | Hide a recommendation from normal review output when its evidence is unchanged. Historical evidence stays available with `show` and `inspect`. |
| `clear confirm` | Erase only this feature's snapshots and dismissals. Existing automations are unaffected. |

For example:

```text
/nobo-help agent automation-audit review
/nobo-help agent automation-audit inspect reminder:abc123
/nobo-help agent automation-audit dismiss s-0123456789abcdef0123
/nobo-help agent automation-audit review
/nobo-help agent automation-audit compare
/nobo-help agent automation-audit history
```

Copy the actual source and suggestion IDs from your review; the IDs above are examples. Snapshot IDs have the form `audit-<UUID>`. After fixing a schedule in its original tool, run `review` again and use `compare` to see the changed evidence. Inspecting a source reads the saved snapshot; it does not silently refresh it.

## What the evidence means

- **Upcoming:** The supplied next occurrence falls within seven elapsed days of the snapshot time. Only the next known occurrence is shown; recurrence rules are not expanded. Times are rendered in the caller's supplied timezone, with an explicit UTC offset, including through DST transitions.
- **Overdue:** The listed next occurrence is more than 15 minutes in the past and the job is active or its enabled state is unknown. This asks you to verify the original job; it does not claim the job failed. Paused, disabled, cancelled and completed jobs do not receive overdue/missing-timing suggestions.
- **Reported failure:** Only an explicit `lastRunStatus: "failed"` produces a failure suggestion. A missing run timestamp or unknown outcome never implies failure. An explicit success/failure without a timestamp is displayed with unknown timing.
- **Stale record:** Its supplied last edit was at least 90 elapsed days ago. Editing age says nothing about execution success or whether the automation is useful; the recommendation is to confirm its purpose.
- **Unclear purpose:** The selected purpose is empty, shorter than eight characters, or matches a small generic-label rule (such as “Daily digest”). This is an explainable heuristic, not a semantic assessment of your goals.
- **Duplicate candidate:** Two active/unknown records have the same kind, normalized purpose and schedule label, plus either the same explicit schedule timezone or the same next occurrence. Known different destinations exclude a pair. Unknown destinations/timezones are disclosed. Candidates require manual comparison; the feature never consolidates jobs.
- **Missing or invalid metadata:** Unknown next-occurrence timing and malformed fields are called out rather than inferred. Timestamps more than 15 minutes in the future for last run/last edit are treated as unknown.

Comparison is observational. A source or suggestion disappearing may mean an adapter returned different coverage or a cap was reached; it is not proof of deletion or resolution. New evidence can produce a new suggestion ID after a previous suggestion was dismissed. Historical views reflect current dismissal preferences.

## Parent integration requirements

1. Import named `feature` or the default export from `lib/agent-features/automation-audit.ts`, register exact ID `automation-audit`, and expose it through the private agent router/help/Home. No child changes to those shared files are required.
2. Supply the existing `AgentFeatureContext` with a workspace/user/feature-scoped atomic store, a valid `now`, and the user's timezone. The only feature-local storage key is `audit`. Updates must preserve the contract's synchronous, retryable, atomic semantics. The parent remains responsible for request deduplication and private delivery.
3. Implement `readContext(["reminder", "monitor", "digest"])` using only authorized caller-owned metadata. Ownership filtering and permitted destination labels happen in the adapter. Do not scan arbitrary Redis keys or broaden to channel-wide subscriptions the caller does not own. Return a deterministic order, prioritizing relevant records if there are more than 80. An empty array means no eligible records were returned; adapter outages must throw rather than masquerade as empty inventory.
4. Use stable, globally unique source IDs across the three kinds, preferably `reminder:<id>`, `monitor:<id>`, and `digest:<id>`. IDs must match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`. Duplicate IDs among the inspected entries are all excluded as ambiguous.
5. Map records to `AgentContextItem` and the following optional, top-level `metadata` fields. Do not supply secrets, arbitrary source documents, raw run errors, or private data outside the caller's scope. No new shared TypeScript contract fields are needed.

```ts
{
  id: "reminder:abc123",
  kind: "reminder", // also "monitor" or "digest"
  title: "Prepare planning notes",
  text: "Prepare the project update for the weekly planning meeting",
  status: "active", // "paused", "disabled", "completed", "cancelled", "unknown"
  updatedAt: "2026-10-20T12:00:00Z", // actual last edit, when available
  dueAt: "2026-10-23T14:00:00Z", // fallback if metadata.nextRunAt is absent
  metadata: {
    purpose: "Prepare the project update for weekly planning", // optional override
    nextRunAt: "2026-10-23T14:00:00Z",
    schedule: "weekly Friday 09:00", // consistent human-readable label
    timezone: "America/Chicago", // source schedule's timezone, when known
    destination: "private DM", // optional permitted stable destination label
    lastRunAt: "2026-10-16T14:00:03Z", // only if truly known
    lastRunStatus: "success" // "failed" or "unknown"; only if truly known
  }
}
```

Missing or unrecognized status means unknown; legacy spellings such as `enabled`, `error`, or `canceled` must be normalized by the adapter. Purpose falls back to `text`, then `title`. `nextRunAt` takes precedence over `dueAt`; an invalid explicit value remains unknown instead of silently falling back. Timestamps must include seconds and `Z` or a numeric `±HH:MM` offset; local dates and impossible dates are rejected. A source's schedule timezone never silently defaults to the caller's timezone.

Existing reminder/monitor/digest records expose `nextRunAt`, schedule fields and timezone. Map reminder task, monitor query and digest focus to meaningful purpose text. Their currently persisted schemas do not all expose last-run success/failure or last-edit timestamps: leave these unknown. `createdAt` must not be relabeled as a last edit, and a monitor's `lastCheckedAt` must not be interpreted as a successful alert delivery. If mapping it to `lastRunAt`, define it as the time of the check and leave its outcome unknown unless separate evidence supplies that outcome. Do not manufacture telemetry from an advanced next occurrence.

## Retention, concurrency and limitations

The feature retains at most eight snapshots, 80 input entries per review, 160 suggestions per snapshot and 100 dismissal IDs. It reports skipped entries and cap truncation. Suggestions are prioritized by rule (overdue, explicit failure, stale, purpose, missing timing, metadata, duplicates); capped-out suggestions may still be suggested by a later review with different coverage. Titles are capped at 160 characters, purposes at 500, schedule labels at 160 and destinations at 120. Stored values contain only allowlisted normalized fields; source URLs, arbitrary metadata and full documents are not retained. Responses stay below 28,000 characters and point to `inspect` when abbreviated.

Dismissals use deterministic IDs based on the rule, source IDs and relevant evidence. They survive an unchanged refresh; material evidence changes may produce a new ID. Only the newest 100 dismissals are retained, so an older recommendation may reappear. Use `clear confirm` to remove all review data and reset dismissals. There is no background expiry, execution telemetry collection, export, job mutation, recurrence parser or model inference in this feature.

Provider failures preserve saved history and dismissals. Corrupt persisted shapes are rejected without being silently overwritten; `clear confirm` explicitly recovers the workspace. Snapshot appends and dismissals use atomic transforms with IDs/timestamps generated outside callbacks. Concurrent dismissals are merged with finishing reviews, a newer captured snapshot prevents an older delayed review from replacing it, and a history clear invalidates in-flight reviews. Reviews with identical capture times can both be retained in completion order. Cancellation detected before the storage update leaves history unchanged.

Targeted verification:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-automation-audit.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```
