import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "redaction-desk",
  "title": "Redaction desk",
  "description": "Preview and apply reversible redactions to a pasted text before you copy it elsewhere.",
  "group": "Write & communicate",
  "keywords": [
    "redact",
    "privacy",
    "PII",
    "mask"
  ],
  "example": "/nobo-help agent redaction-desk create Shareable note | Contact Maya at maya@example.com about the launch.",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Redaction desk: deterministic reviewed masking; cannot detect all secrets.\nStart: /nobo-help agent redaction-desk create Shareable note | Contact Maya at maya@example.com about the launch.\nscan DOC | email,phone,literal (choose categories; none disables all)\npreview DOC TOKEN [page N] [rev N]\nselect DOC TOKEN | 1,3 (or none): replaces selection and returns a NEW token\napply DOC TOKEN: replaces selected spans with [EMAIL], [PHONE], [LITERAL] or [MIXED]; stores one undo version and consumes preview\nundo DOC: restores the retained prior version and consumes undo/preview\nliteral DOC add sensitive text; literal DOC edit LITERAL | sensitive text\nremove DOC literal LITERAL confirm\nsettings DOC | email,phone,literal (or none; clears preview)\nrevise DOC | current text; original DOC | original text; title DOC | title\nclear DOC original|current|undo|preview|literals|settings confirm (choose one)\nAny edit/removal invalidates previews. Selection edits rotate tokens; stale/replayed tokens cannot apply. Manual text edits keep the one existing undo; inspect it before undoing. Applying replaces that one prior version.\nlist [page]; show DOC [page N] [rev N]; copy DOC [page N] [rev N]; export DOC; delete DOC confirm\nshow/export include COMPLETE original/current/undo, literals, enabled categories and preview/selection. Original and undo may still contain secrets until explicitly cleared/deleted. copy shows current text only, with no guarantee it is safe to share.\nOffsets are zero-based UTF-16, end exclusive. Overlaps merge; touching spans stay separate. Email and 7–15-digit phone heuristics have false positives/negatives. Literal matching is case-sensitive. More than 30 merged spans rejects the whole scan: narrow categories/literals or revise text.\nPipe fields trim outer whitespace; escape literal pipes as \\| and backslashes as \\\\. 6 documents, 6000 units per text version, 20 literals (300 units each), 30 spans, one preview/undo. 65536 total/49152 content/24576 exported-record UTF-8 bytes; copies and reserves can fill bytes first. Apply output over text limits rejects preview before saving. Export/delete to free space. Private, on demand; zero models, searches, context reads or external actions."
} satisfies AgentFeatureMetadata;
