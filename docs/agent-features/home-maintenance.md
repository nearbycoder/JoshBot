# Home maintenance planner

Local, unregistered and not deployed. **Organize life** feature `home-maintenance` computes only supplied date/usage intervals. No maintenance advice, booking, recurring job, notification, model, search or context read is added.

Start `/nobo-help agent home-maintenance add Air filter | Appliance manual | 90 | none`. With its returned ID, `service ID | 2026-07-01 | none | Replaced filter`, then `due 2026-10-22`, produces **2026-09-29**, **23 civil days overdue**. A second actual service on October 22 establishes a new baseline. `history ID` exposes both exact service rows and their stable IDs.

Grammar after `/nobo-help agent home-maintenance`:

```text
add LABEL | MANUAL | DAYS/none | USAGE_INTERVAL/none
service ID | YYYY-MM-DD | METER/none | NOTE
meter ID | VALUE
correct ID | VALUE | REASON
history ID [PAGE [rev TOKEN]]
history ID edit SERVICE | YYYY-MM-DD | METER/none | NOTE | CORRECTION_REASON
history ID remove SERVICE confirm
history ID clear SERVICE meter/note/correctionReason confirm
edit ID | title/manual/intervalDays/intervalUsage | VALUE
clear ID FIELD confirm
due YYYY-MM-DD [PAGE [rev TOKEN]]
list [PAGE]
show ID [PAGE [rev TOKEN]]
export ID
delete ID [confirm]
help
```

`clear` also accepts `latestMeter` (including its reason) and `latestReason`. Clear interval values or enter `none` to remove that threshold. A service date is removed by removing the row. History edits replace exact date, meter, note and correction reason; no hidden version remains. Removing/clearing a correction reason is allowed only if the remaining history is valid. Edit/correction commands have new-content admission, while normal service and monotonic meter recording use reserved lifecycle space.

The baseline is the retained service with latest civil date; entered order breaks same-date ties. Date and usage thresholds are independent: either reached threshold means due. A missing required baseline/latest meter means unknown unless the other threshold establishes due. A corrected latest reading below the service baseline is explicitly unknown, never a negative elapsed-use estimate. History changes recompute the baseline; the latest meter is a separately entered reading, without an invented observation timestamp. All usage values use the same user-supplied meter units. Normal readings and added service meters cannot decrease. `correct` records a reason for a changed latest reading; a changed historical meter uses `history ... edit ... | REASON`.

Labels ≤160, manual labels ≤1,000, service notes/correction reasons ≤160 UTF-8 bytes. Day intervals 1–3,650; meter values 0–1,000,000,000 with up to three decimal places, positive usage intervals. Fixed integer thousandths avoid decimal drift. Service dates must be actual past/today in the caller timezone; `due` accepts a civil assessment date. Literal pipes/backslashes use `\|`/`\\`; other escapes reject.

Schema 1 has at most 30 assets and 10 service rows each. All ten service slots (including replacing a removed row), worst-case 160-byte note escaping, numeric meter width, and maximum revisions are projected at content admission. This can reach the 49,152-byte state limit before the asset count; it guarantees retained assets can complete the bounded service history. New content ≤32,768 bytes, complete export envelopes ≤24,576. There is no eviction. Optional correction reasons must pass new-content checks; explicit removals remain available at the revision ceiling.

Lossless JSON `show` pages and complete `export` retain all inputs. History/due pages retain every service/asset with emitted content-stamped continuation commands. Same-record changes/deletion invalidate pending mutations on actual CAS retries; unrelated records retry. Corrupt saved shapes preserve raw bytes rather than reset. Private scope and cancellation come from the real runtime/store.

Verification: `node --import tsx --test --test-concurrency=1 tests/agent-home-maintenance.test.ts` on Node 24. Fake-backed tests cover the worked arithmetic, missing/independent thresholds, monotonic readings and explicit correction, exact history edits/removal, full reconstruction, ten-service ceiling, worst-case reserved history completion at admission saturation, real CAS conflicts, corrupted raw state, separate user/workspace isolation, metadata parity and bounded help. Resource budgets: generation/search/context 0/0/0; logical reads/updates 8/4. No live verification or release approval is implied.
