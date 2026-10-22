# Personal agent discovery

This checkout registers **70 implemented personal agents**: the existing 20 and all 50 additions. Every listed agent has a real module and its own metadata. The original 20 first shipped in [PR #58](https://github.com/nearbycoder/JoshBot/pull/58); the 50 additions are in [PR #59](https://github.com/nearbycoder/JoshBot/pull/59), which tracks release/deployment status. See the [grouped guide index](README.md#find-a-feature) for all 70 outcomes and first commands, and the [implementation/evidence record](../personal-agent-50-release.md) for scoped validation. The parent owns final release and production verification.

Start privately in your Slack channel or DM composer:

```text
/nobo-help agent
/nobo-help agent help
/nobo-help agent catalog page 2
/nobo-help agent catalog group plan
/nobo-help agent catalog group capture page 2
/nobo-help agent search meeting
/nobo-help agent search private page 2
/nobo-help agent meeting-prep help
```

Each catalog page shows at most ten agent IDs and one-line purposes, its range, total, page count, and copyable navigation. Group order is fixed; agents within each group sort by ID. The aliases are `plan` (Plan & prioritize), `capture` (Capture & recall), `write` (Write & communicate), `decide` (Decide & analyze), `learn` (Learn & improve), `life` (Organize life), and `review` (Review & maintain).

Search matches every case-insensitive query token against IDs, titles, descriptions and keywords. An exact ID ranks first, then ID/title matches, then other matches; ID breaks ties. Spaces collapse and queries may contain up to 100 JavaScript string units. Only a terminal `page <integer>` is pagination: `search page design` searches those words. Page numbers must be positive and within the displayed range. Invalid filters or an empty result give a working catalog reset. No text is silently truncated to make a search or page fit.

On **Home → More → Personal agents**, choose All or a group, use Previous/Next, or enter a query and press **Search**. Search stays within the selected Home group. Each row’s **Help** shows the agent’s actual commands and a concrete example. **Back to results** restores group, query and page. Browsing and help update the same private modal and never execute an agent. Copy a command into your Slack composer to start a workflow. The copyable slash search is global; the modal labels that distinction when a group is selected.

Views retain only bounded navigation filters and agent IDs. Identity comes from the signed Slack interaction; access is checked at entry, every button/filter action, and search submission. Stale or closed views do not send DMs or public messages. Reopen Personal agents from Home, or use `/nobo-help agent` if an interaction expires.

Catalog/search/help and the catalog renderer use literal metadata, without feature-state or preference reads, request receipts, source lookup, or model/web-search work. Feature code loads only for execution. Existing Slack ingress access-policy checks and the separate Home dashboard’s reads still occur; this is not a claim that an entire Slack request performs zero I/O.

Source availability depends on the chosen agent. Legacy context-aware help explains the connected private toolbox, confirmed calendar imports and approved memory cards. Legacy reminders, monitors, digests and follow-ups cover only owned records in the signed channel where the command runs. Saved artifacts and legacy personal memory are not connected. New agents keep their own precise source/help statements; catalog browsing does not broaden those sources. Normal feature execution retains the existing scoped storage, admission, cancellation and invocation deadline.

All controls are for discovery. There are no favorites/recents reads, per-agent usage badges, background jobs, or automatic feature runs attached to this catalog.
