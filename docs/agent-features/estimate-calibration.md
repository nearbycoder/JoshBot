# Estimate calibration

Compare self-reported effort with its frozen initial estimate. Start with:

```text
/nobo-help agent estimate-calibration estimate Draft article | writing | 60
```

Use the returned full sample ID in `actual SAMPLE | 90`. Add two more pairs (30→45 and 20→30 minutes in `writing`), then `report writing` shows median ratio 1.5 and median absolute error 15 minutes. `forecast writing | 80` previews 120 minutes without saving or changing any estimate.

The report uses complete, nonexcluded samples from the exact category label. It reports median actual/estimate, median absolute error, median signed error (actual minus estimate), incomplete and excluded counts. Excluded incomplete samples are explicitly identified. At least three included pairs are needed for a multiplier. A known zero actual participates normally. This small, self-selected sample is not a guarantee about future work; comparable tasks and honest inputs are assumed.

Calculated values display up to six significant digits, using scientific notation for tiny values (`1e-7` means `0.0000001`); positive ratios never round to zero. `≈` identifies display rounding. Forecasts use the unrounded median and retain the exact entered base; if the displayed multiplier or result was rounded, the formula uses `≈` instead of `=`. For example, three 3→1 pairs yield `3 × 0.333333 ≈ 1 minutes`, while three 10000→0.001 pairs yield `10000 × 1e-7 = 0.001 minutes`. Stored values and statistics are unchanged.

`edit SAMPLE label text` and `edit SAMPLE category text` change labels. Initial estimates are frozen: `correct SAMPLE | minutes | reason` saves a separate explicit correction with the request timestamp; reports use it and disclose correction counts. Replacing this correction retains the initial estimate but not a revision history. `exclude SAMPLE | reason` removes a sample from calculations. `remove SAMPLE actual|correction|exclusion confirm` clears the named optional field. Re-enter `actual` to correct an actual. Numbers allow three decimal places, range 0–1,000,000 minutes, with estimates strictly positive.

`list [page N]` lists ten current records per page in creation-time/ID order. `show SAMPLE [page N] [rev N]` exposes every field and revision, with exact continuation commands; changed revisions require reopening. `export SAMPLE` returns the complete JSON envelope. `delete SAMPLE confirm` removes that sample and all its correction metadata. The bare delete command explains confirmation.

Pipe fields use `\|` for a literal pipe and `\\` for a literal backslash; all other escapes fail. Labels are 120 UTF-8 bytes, categories 80, reasons 768. The feature admits 60 samples and 12 category labels, subject to 32,768 new-content bytes / 49,152 total bytes and a 24,576-byte record export. Admission projects an actual, timestamp and maximum revision for every sample. Optional corrections/exclusion reasons consume content; actual completion remains possible after admission. Nothing expires or is silently removed.

This is private entered data in the runtime's workspace/user namespace. No model, search, context source, external action, timer or timelog integration exists. Metadata budgets are 0 generations, 0 searches, 0 context reads, 8 reads and 4 logical updates; normal commands use one read and at most one update. Transforms revalidate and compare revisions after CAS conflicts. Tests use Node 24, the real runtime/store and local fake services; registration and production verification belong to the parent.
