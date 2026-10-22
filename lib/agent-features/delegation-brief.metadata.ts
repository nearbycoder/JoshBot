import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "delegation-brief",
  "title": "Delegation brief",
  "description": "Prepare a bounded request with decision rights, checkpoints, and an observable definition of done.",
  "group": "Write & communicate",
  "keywords": [
    "delegate",
    "brief",
    "ownership",
    "acceptance"
  ],
  "example": "/nobo-help agent delegation-brief create Review onboarding | Reviewer | Find the three largest sources of confusion",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Prepare a request with explicit outcome, authority, scope and acceptance tests.\nStart: /nobo-help agent delegation-brief create Review onboarding | Reviewer | Find the three largest sources of confusion\nReplace ID/ENTRY with returned IDs. All commands follow /nobo-help agent delegation-brief.\ncreate TITLE | RECIPIENT | OUTCOME\nscope ID | in/out | TEXT; resource ID | TEXT\ncheckpoint ID | YYYY-MM-DD | TEXT\nauthority ID | TEXT; done ID | TEXT\nedit ID | title/recipient/outcome/authority/done | TEXT\nclear ID FIELD confirm (removes one field)\nentry ID edit ENTRY | in/out/resource/checkpoint | YYYY-MM-DD-or-- | TEXT\nentry ID remove ENTRY confirm\naccept ID confirm; unaccept ID confirm (your local acceptance record only; editing clears it)\ndraft ID [page] — deterministic request and completeness audit\npolish ID — one optional model call; unsaved, review every field\nlist [page]; show ID [page]; export ID; delete ID confirm\nPrivate saved draft requests. Recipient is a label. Nothing sends or assigns work. Sources: entered fields only. Polish sends these fields to the configured text model.\nUse \\| for a literal pipe and \\\\ for a backslash. Unknown escapes fail.\nLimits: 12 briefs; 20 entries each; title 160, recipient 200, other text 1000 UTF-8 bytes. Content 32768 / state 49152 bytes, export 24576 including envelope. Limits may be reached by bytes first. Use list/export/delete to free space."
} satisfies AgentFeatureMetadata;
