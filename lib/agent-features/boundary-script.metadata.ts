import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "boundary-script",
  "title": "Boundary scripts",
  "description": "Draft a clear decline or renegotiation from your limits and an explicit alternative.",
  "group": "Write & communicate",
  "keywords": [
    "say no",
    "decline",
    "renegotiate",
    "boundaries"
  ],
  "example": "/nobo-help agent boundary-script create Extra report this week | Existing delivery already fills the week",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Build an unsent decline, deferral or reduced-scope proposal from your actual limits.\nStart: /nobo-help agent boundary-script create Extra report this week | Existing delivery already fills the week\nAll commands follow /nobo-help agent boundary-script; ID/AVOID are returned IDs.\ncreate REQUEST | CONSTRAINT (starts with decline)\nstance ID | decline/defer/reduce\noffer ID | ALTERNATIVE; date ID | YYYY-MM-DD; scope ID | REDUCED-SCOPE\navoid ID | PROHIBITED-COMMITMENT\nprohibition ID edit AVOID | TEXT; prohibition ID remove AVOID confirm\nedit ID | title/constraint/offer/date/scope | TEXT\nclear ID FIELD confirm (also accepts stance)\ndraft ID [page] — deterministic template and commitment checklist\npolish ID | warm/direct — one optional model call, unsaved wording beside the deterministic template\nlist [page]; show ID [page]; export ID; delete ID confirm\nDefer requires an explicit revisit date; reduce requires scope or a concrete offer describing that scope. No date, capacity, agreement or promise is inferred. Nothing sends or records a relationship commitment. Sources are your entered fields only; polish sends them to the configured text model.\nUse \\| for literal pipes and \\\\ for backslashes; other escapes fail.\nPrivate saved scenarios: 12 roots, 20 prohibitions each; title 160 and text 1000 UTF-8 bytes. Content 32768/state 49152 bytes; full export 24576. Use list/export/delete to free space. Drafts are unsaved; no version history."
} satisfies AgentFeatureMetadata;
