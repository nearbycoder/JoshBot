import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "data-cleanroom",
  "title": "Small table cleanroom",
  "description": "Validate a small pasted table and preview explicit cleaning operations before exporting it.",
  "group": "Review & maintain",
  "keywords": [
    "CSV",
    "table",
    "duplicates",
    "data quality"
  ],
  "example": "/nobo-help agent data-cleanroom create Effort samples | name,minutes\nDraft,60\nDraft,60\nReview,unknown",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Small table cleanroom — Validate pasted CSV and inspect explicit cleaning before applying it.\nStart: /nobo-help agent data-cleanroom create Effort samples | name,minutes\nDraft,60\nDraft,60\nReview,unknown\nThen: schema TABLE | name:text,minutes:integer; audit TABLE\npreview TABLE | dedupe | name,minutes; preview-show TABLE\nCopy the emitted apply TABLE TOKEN command; export-csv TABLE.\nCommands after /nobo-help agent data-cleanroom:\ncreate TITLE | CSV\nreplace TABLE confirm | CSV (erase original/current/schema/preview/undo; new source IDs)\nedit TABLE | title | TEXT; clear TABLE title confirm\nschema TABLE | COLUMN:TYPE,COLUMN:TYPE (all columns exactly once)\nkeys TABLE | COLUMN,COLUMN; keys-remove TABLE confirm\ncell TABLE ROW | COLUMN | JSON_STRING (nonempty, e.g. \"  exact  \")\ncell-clear TABLE ROW COLUMN_ID confirm (current cell only)\nrow-remove TABLE ROW confirm (current row only; original remains)\npreview TABLE | trim | all OR COLUMN,COLUMN\npreview TABLE | dedupe | selected OR COLUMN,COLUMN\npreview TABLE | convert | COLUMN:TYPE,COLUMN:TYPE\npreview-show TABLE [PAGE]; apply TABLE TOKEN; undo TABLE confirm\ndiscard TABLE preview|undo confirm (choose one)\naudit TABLE [PAGE]; export-csv TABLE [PAGE]; export-spreadsheet TABLE [PAGE]\nlist [PAGE]; show TABLE [PAGE]; export TABLE; delete TABLE confirm\nFull returned IDs only. COLUMN is exact header name or full column ID; use IDs for names containing comma/colon/boundary spaces. Types: text,integer,decimal,civilDate. Schema validates without conversion. Integer/decimal conversion accepts optional sign/leading zeros, <=6 decimal places for decimal, absolute value <=1000000000; no exponent. Blank/invalid numeric/date values reject the whole conversion; use explicit trim first. Dates are valid canonical YYYY-MM-DD. Dedupe compares selected exact strings and keeps the first row. No formula evaluation.\nFirst CSV record is always header: nonblank, unique after trimming, <=160 UTF-8 bytes each. Quoted comma/newline/double quote and CRLF supported; bare CR outside quotes rejected. Blank cells/Unicode preserved. Pipe escapes \\| and \\\\ apply also inside CSV; one optional ASCII space immediately after the source separator is syntax padding, all other CSV whitespace is data. Cell JSON strings preserve whitespace exactly.\nEdits discard preview/undo; original cells persist until confirmed replace/delete. Preview replaces one pending token. Apply consumes it and replaces the single undo grid; undo consumes undo/preview. Original/current/preview/undo fully retrievable. Copy emitted PAGE rev TOKEN continuations unchanged; CSV page bodies concatenate exactly.\nCanonical export preserves formula-like cells; spreadsheets may execute them. Explicit export-spreadsheet prefixes apostrophes to formula-like cells without mutating canonical data; importer behavior varies.\nPrivate, no model/search/context/external calls. 6 tables,40 rows,8 columns,6000 source JS units; command16000 UTF-8 bytes. State/content/export65536/49152/24576 serialized bytes; dynamic reserve may bind first. Normal pages<=3500 units. At revision ceiling inspect/export/delete/recreate. No reset/eviction. Help needs no state."
} satisfies AgentFeatureMetadata;
