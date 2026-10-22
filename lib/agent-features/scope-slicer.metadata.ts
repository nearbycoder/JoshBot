import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "scope-slicer",
  "title": "Scope slicer",
  "description": "Fit a coherent minimum deliverable inside an effort budget and expose what must be deferred.",
  "group": "Plan & prioritize",
  "keywords": [
    "MVP",
    "scope",
    "tradeoffs",
    "budget"
  ],
  "example": "/nobo-help agent scope-slicer create Guide v1 | 180",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Scope slicer — Fit a coherent minimum deliverable inside an effort budget and expose what must be deferred.\nStart: /nobo-help agent scope-slicer create Guide v1 | 180\nReplace WORK/PLAN/FORECAST/BOARD/SCOPE and child placeholders with the full returned IDs.\ncreate TITLE | MINUTE-BUDGET; edit SCOPE | TITLE | MINUTE-BUDGET\nitem SCOPE add LABEL | must/should/could | MINUTES | ACCEPTANCE\nitem SCOPE edit ITEM | LABEL | must/should/could | MINUTES | ACCEPTANCE\nitem SCOPE remove ITEM confirm\nrequires SCOPE ITEM | PREREQUISITE; unrequire SCOPE ITEM | PREREQUISITE confirm\nselect SCOPE ITEM; unselect SCOPE ITEM confirm\nslice SCOPE [page]; what-if SCOPE | MINUTE-BUDGET [page]\nManage: list [page]; show ID [page]; export ID; delete ID confirm.\nRequired core = all must items, explicit selections, and their transitive prerequisites counted once. Mandatory overflow is infeasible. Optional fit uses should then could, entered order, including full prerequisite cost; this is a deterministic heuristic, not an optimizer. Selection is not completion. No model calls.\nPrivate saved inputs; reports/what-if are unsaved. Sources: your input and this feature only. No search or external actions.\nFields use |. Escape a literal pipe as \\| and a literal backslash as \\\\; other/trailing escapes are rejected.\nLimits: 8 scopes; 24 deliverables and 60 prerequisite edges each; 49152 UTF-8 bytes (32768 new content). Bytes may fill first. Use list, export, then delete ID confirm to free space."
} satisfies AgentFeatureMetadata;
