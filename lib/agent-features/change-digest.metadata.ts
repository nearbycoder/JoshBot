import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "change-digest",
  "title": "Text change digest",
  "description": "Compare two pasted versions and distinguish wording edits from changed facts that need review.",
  "group": "Capture & recall",
  "keywords": [
    "diff",
    "change",
    "versions",
    "comparison"
  ],
  "example": "/nobo-help agent change-digest create Launch note | before | Launch on October 30 with 10 users.",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Text change digest: exact supplied versions and user-reviewed meaning.\nStart: /nobo-help agent change-digest create Launch note | before | Launch on October 30 with 10 users.\nafter DIFF | Launch on November 6 with 20 users.\ncompare DIFF [page N] [rev N]\nclassify DIFF HUNK | substantive|cosmetic | rationale (choose one category; replaces category/rationale)\ndigest DIFF [page N] [rev N]: substantive, cosmetic and unreviewed groups remain separate\nbefore DIFF | text; after DIFF | text; title DIFF | title\nlabels DIFF | before label | after label\nunclassify DIFF HUNK confirm\nclear DIFF before|after|classifications confirm (choose one)\nText/title/label changes invalidate all hunk IDs/classifications. Classification edits keep IDs stable. Hunk IDs contain the full comparison UUID and diff revision; copy them from compare. A missing after version differs from a supplied empty after; use after DIFF | for deletion-only comparisons.\nlist [page]; show DIFF [page N] [rev N]; export DIFF; delete DIFF confirm\nDiffs retain exact inserted/deleted spans including internal newlines and repeated lines. Offsets are zero-based UTF-16, end exclusive. Numeric, ISO/English-month date and capitalized name? tokens are lexical hints, not business meaning or date validation. Whitespace hints never auto-classify a hunk.\nPipe fields trim outer whitespace; escape literal pipes as \\| and backslashes as \\\\. Up to 6 comparisons, 6000 units/120 lines per side (trailing empty line counts), 60 hunks. Rationale <=96 UTF-8 bytes. 65536 total/49152 content/24576 exported-record bytes; admission reserves a full classification/rationale for every hunk. Byte quotas can fill before counts. Export/delete to free space; all text/labels/classifications are retrievable. No history/expiry/eviction. Private deterministic commands; no model, search, context reads or external actions."
} satisfies AgentFeatureMetadata;
