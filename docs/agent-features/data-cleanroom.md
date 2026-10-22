# Small table cleanroom

Locally implemented, unregistered and not deployed. Parent integration owns registration/release. This feature operates only on entered local cells; it makes zero model/search/context/live calls and never evaluates formula-like text.

```
create Effort samples | name,minutes
Draft,60
Draft,60
Review,unknown
schema TABLE | name:text,minutes:integer
audit TABLE
preview TABLE | dedupe | name,minutes
preview-show TABLE
apply TABLE TOKEN
export-csv TABLE
```

Use full IDs from replies. Audit flags the second duplicate and the invalid integer at data row 3, column 2, including row/column IDs. Dedupe keeps the first row with each exact selected string key. Inspect the entire pending output with `preview-show`; its emitted apply command contains the actual token. Apply consumes it once and retains one prior current grid. `undo TABLE confirm` restores that grid and consumes undo/preview. Original cells remain independently inspectable.

The first CSV record is always the header. Headers must be nonblank and unique after trimming; ambiguous/duplicate headers fail explicitly. Cell spelling, blanks, Unicode, quoted commas, embedded CR/LF and doubled quotes are retained. Unquoted leading/trailing cell spaces and tabs survive the signed slash command, dispatcher and runtime unchanged, for both create and replace. A final record delimiter ends its record; a second delimiter retains an empty single-column record (`name\nx\n\n` has two data rows). LF/CRLF record endings work; bare CR outside quotes fails. No delimiter/header inference occurs. Export uses canonical CRLF, proper CSV quoting and doubled quotes, preserving cells rather than original source formatting. An independent regex-token CSV reader checks round trips in tests.

`schema TABLE | COLUMN:TYPE,...` declares every column once without changing cells; types are text, integer, decimal, civilDate. A COLUMN selector is its full immutable ID or exact header name; use IDs for names containing comma/colon or boundary spaces. `keys TABLE | COLUMN,...` edits selected keys; `keys-remove TABLE confirm` clears them. `preview TABLE | trim | all` (or column list), `preview TABLE | dedupe | selected` (or column list), and `preview TABLE | convert | COLUMN:TYPE,...` compute explicit output. Invalid/blank conversions refuse the entire preview with row/column guidance. No dropped invalid rows or empty-to-zero coercion. Numeric conversion supports optional signs/leading zeros, absolute magnitude ≤1,000,000,000, six fractional places for decimal, no exponents; conversion canonicalizes spelling. Dates must be valid Gregorian YYYY-MM-DD. Use trim explicitly before converting surrounding whitespace.

Maintain current values with `cell TABLE ROW | COLUMN | JSON_STRING`; nonempty JSON strings preserve exact whitespace. `cell-clear TABLE ROW COLUMN_ID confirm` clears a cell; `row-remove TABLE ROW confirm` removes a current row. Originals remain. To edit or erase original headers/cells, use `replace TABLE confirm | CSV`; this replaces all grids, resets schema to text and issues new source IDs. `edit TABLE | title | TEXT` / `clear TABLE title confirm` maintain the title. Edits invalidate pending preview and undo; replies disclose this. `discard TABLE preview|undo confirm` explicitly removes either retained slot (choose one). Replacing a preview invalidates the old token; apply explicitly replaces the single undo version. No hidden history exists.

`export-csv TABLE [PAGE]` preserves formula-like text. Spreadsheet applications may execute such cells; code not evaluating them does not make a CSV safe to open. `export-spreadsheet TABLE [PAGE]` explicitly prefixes an apostrophe before cells/headers whose first non-whitespace character is `=`, `+`, `-`, or `@`; importer behavior varies. This changes only the returned variant. Canonical stored cells stay identical. Copy actual continuation commands; concatenating CSV page bodies yields the exact export.

`list [PAGE]`, `show TABLE [PAGE]`, `export TABLE`, and `delete TABLE confirm` retrieve/erase the full retained record. Show includes original/current grids, schema, immutable row/column IDs, selected keys, pending output/binding and undo. Pages bind revision plus full-content hash, preserve atomic IDs/URLs/hashes and fit 3,500 JavaScript units. JSON export including envelope is ≤24,576 serialized UTF-8 bytes. CSV views are also admission-checked for every retained grid a later apply/undo can expose.

Limits: six tables, 40 data rows, eight columns, 6,000 source JavaScript units; header 160 UTF-8 bytes, title 160. Commands ≤16,000 UTF-8 bytes. State/content limits 65,536/49,152 serialized bytes. Dynamic reserve uses the largest current/undo/preview grid with longest schema tags, all keys, maximal revision and token overhead in every mutable slot. Transformations cannot increase cell size; all accepted content leaves room for required preview/apply/undo. Export or byte capacity can bind before source/count limits. Pipe syntax supports `\|` / `\\`, including inside CSV. One optional ASCII space immediately after the source separator is syntax padding; all other source whitespace is data.

Every write binds the exact full intended root outside retryable CAS; same-root edits/deletion reject stale work while unrelated changes can retry. At record revision 999,999,999 all non-erasure writes refuse; retrieval/erasure remain. No collection counter, recycled IDs, reset or eviction. Fully valid individually exportable legacy aggregates over quota recover via strictly reducing confirmed whole-root deletion, leaving every retained record identical. Other operations retain quota/projection gates. Invalid shape/version/JSON remains byte-identical. Backend exceptions are sanitized; an uncertain save directs inspection before retry.

Verification: Node 24, 1 GiB heap, `node --import tsx --test --test-concurrency=1 tests/agent-data-cleanroom.test.ts`; 11 focused tests, zero skips, plus project typecheck/diff checks. Coverage includes the example, independent CSV round trip, every edit/removal, strict stored shape/enum validation, maximum counts, Unicode/escaping lifecycle saturation, full emitted retrieval, stale preview/CAS, legacy recovery, tenant isolation, cancellation and diagnostic privacy. No production, live Redis/Slack or performance claim. Metadata help is the authoritative parser grammar.
