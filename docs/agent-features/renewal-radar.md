# Renewal review

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

`renewal-radar` belongs to **Organize life**. It records manually supplied terms and computes notice deadlines and same-currency cost equivalents. No account access, cancellation, reminder, notification, generation, search or context read occurs.

Start with `/nobo-help agent renewal-radar add Design membership | 2026-12-01 | 14 | 120.00 | USD | year | 1`. The returned ID opens the complete record. `upcoming 60` includes notice dates through the caller's civil today plus 60 days, overdue entries, and unknown dates; the example notice date is **2026-11-17**. `costs` shows **USD 10.00/month**, **USD 120.00/year**. Costs use integer minor units and exact rational formulas, displayed to two decimals with half-up rounding. They are equivalents, not invoices. Currency labels are never converted or added together. Past notice is not a conclusion about cancellation rights.

All commands follow `/nobo-help agent renewal-radar`:

```text
add LABEL | YYYY-MM-DD | NOTICE_DAYS | AMOUNT | CURRENCY | month/year | INTERVAL
upcoming DAYS [PAGE [rev TOKEN]]
costs [PAGE [rev TOKEN]]
review ID | keep/change | REASON
reschedule ID | YYYY-MM-DD | MANUAL_CONFIRMATION_NOTE
edit ID | FIELD | VALUE
clear ID FIELD confirm
list [PAGE]
show ID [PAGE [rev TOKEN]]
export ID
delete ID [confirm]
help
```

Fields: `title`, `renewalDate`, `noticeDays`, `amount`, `currency`, `billingUnit`, `interval`, `termsNote`, `reviewNote`, `confirmationNote`. `clear` also accepts `status` and clears its review note. Dates/numbers become explicitly unknown on clearing. Review/reschedule replace their current note; no hidden history is retained. Reschedule requires a nonempty supplied manual confirmation note and changes only the entered date. Every destructive clear/delete needs `confirm`.

Escape literal pipes as `\|` and backslashes as `\\`; other escapes fail. Labels and lifecycle notes are at most 160 UTF-8 bytes; terms notes 1,000. Amounts are 0–1,000,000.00 with at most two decimals. Notice days 0–366; intervals 1–120 months/years; upcoming horizon 0–3,660 civil days. Currency labels are 1–12 uppercase ASCII letters/digits beginning with a letter. Invalid dates and notice subtraction outside supported civil years reject.

Schema 1 retains at most 40 stable renewal IDs. New content fits 32,768 serialized UTF-8 bytes; complete state 49,152 and each complete export envelope 24,576. Admission projects both future 160-byte lifecycle notes with worst permitted JSON escaping, date presence, and maximum revision for every record; it does not rely on a fixed cushion. Optional terms notes remain new content. Once full, decisions and confirmed reschedules still fit the reserved footprint. Explicit deletion releases space, including at the revision ceiling.

`show` provides lossless JSON pages; `export` returns the full compact envelope. Copy emitted continuation commands: they bind revision plus content fingerprint. Aggregate costs/upcoming pages also bind the saved set and caller civil date. Lists are current pages of ten. Edits and removals invalidate old continuations; unrelated record edits can retry CAS safely. Same-record conflicting changes/deletions reject after comparing the intended snapshot on every retry. Malformed stored data is preserved, including on deletion. Runtime cancellation is checked around awaited storage; a dispatched CAS cannot be rolled back.

Acceptance: the real-runtime fake-backed suite covers the worked date/cost example, rational rounding, field lifecycle, 40-record limit, Unicode bytes and full-page reconstruction, reserved lifecycle at saturated content, actual backend CAS conflicts, corrupt enums/raw preservation, workspace/user isolation, cancellation, and exact catalog metadata. Budgets are generation/search/context **0/0/0**, logical reads/updates **8/4**; normal replies/help ≤3,500 units. Run `node --import tsx --test --test-concurrency=1 tests/agent-renewal-radar.test.ts` under Node 24. No live integration or release approval is implied.

At the 999,999,999 revision ceiling, only explicit removals continue; other writes require exporting and recreating the record. This prevents status/preview changes from cycling back to an indistinguishable snapshot when the injected clock has not advanced. Content saturation remains distinct: reserved lifecycle operations continue below the revision ceiling.
