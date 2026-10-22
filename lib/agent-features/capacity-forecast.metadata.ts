import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "capacity-forecast",
  "title": "Capacity forecast",
  "description": "Compare multiweek effort ranges with explicit capacity and see best- and worst-case overload.",
  "group": "Plan & prioritize",
  "keywords": [
    "capacity",
    "forecast",
    "range",
    "overload"
  ],
  "example": "/nobo-help agent capacity-forecast create November delivery | 2026-11-02 | 2",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Capacity forecast — Compare multiweek effort ranges with explicit capacity and see best- and worst-case overload.\nStart: /nobo-help agent capacity-forecast create November delivery | 2026-11-02 | 2\nReplace WORK/PLAN/FORECAST/BOARD/SCOPE and child placeholders with the full returned IDs.\ncreate TITLE | MONDAY | WEEKS; edit FORECAST | TITLE | MONDAY | WEEKS\ncapacity FORECAST | WEEK | MINUTES; capacity-clear FORECAST WEEK confirm\npackage FORECAST add LABEL | LOW | HIGH | EARLIEST-WEEK | LATEST-WEEK\npackage FORECAST edit PACKAGE | LABEL | LOW | HIGH | EARLIEST-WEEK | LATEST-WEEK\npackage FORECAST remove PACKAGE confirm\nforecast FORECAST [page]; what-if FORECAST capacity | WEEK | MINUTES [page]\nManage: list [page]; show ID [page]; export ID; delete ID confirm.\n2–8 Monday-start weeks. Unknown capacity remains unknown, never assumed free or zero. Independent low/high scenarios use stable earliest-week then entered order; allocation is provisional when capacity is unknown. Bounds are assumptions, not probabilities. No model calls.\nPrivate saved inputs; reports/what-if are unsaved. Sources: your input and this feature only. No search or external actions.\nFields use |. Escape a literal pipe as \\| and a literal backslash as \\\\; other/trailing escapes are rejected.\nLimits: 8 forecasts; 8 weeks and 24 work packages each; 49152 UTF-8 bytes (32768 new content). Bytes may fill first. Use list, export, then delete ID confirm to free space."
} satisfies AgentFeatureMetadata;
