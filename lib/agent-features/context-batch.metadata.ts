import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "context-batch",
  "title": "Context batching",
  "description": "Bundle small actions by shared setup and available tools to reduce switching.",
  "group": "Plan & prioritize",
  "keywords": [
    "batch",
    "errands",
    "setup",
    "context switching"
  ],
  "example": "/nobo-help agent context-batch create Admin hour | 60",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Context batching — Bundle small actions by shared setup and available tools to reduce switching.\nStart: /nobo-help agent context-batch create Admin hour | 60\nReplace WORK/PLAN/FORECAST/BOARD/SCOPE and child placeholders with the full returned IDs.\ncreate TITLE | MINUTES; edit BOARD | TITLE | MINUTES\nsetup BOARD | KEY | MINUTES; setup-edit BOARD SETUP | KEY | MINUTES; setup-remove BOARD SETUP confirm\nAction syntax: action BOARD add LABEL | MINUTES | SETUP-KEY | TOOL1,TOOL2 | LOCATION\nEdit: action BOARD edit ACTION | LABEL | MINUTES | SETUP-KEY | TOOL1,TOOL2 | LOCATION\nRemove: action BOARD remove ACTION confirm\nbatch BOARD | LOCATION | TOOLS saves context and previews; batch BOARD [page] reopens it.\ncontext-clear BOARD confirm; complete BOARD ACTION; reopen BOARD ACTION\nManage: list [page]; show ID [page]; export ID; delete ID confirm.\nUse - for no setup/tools or any location. Labels are case-sensitive. Greedy group order follows first eligible action; action order follows entry order. Setup paid once per selected group. Every exclusion is shown. No model calls or timers.\nPrivate saved inputs; reports/what-if are unsaved. Sources: your input and this feature only. No search or external actions.\nFields use |. Escape a literal pipe as \\| and a literal backslash as \\\\; other/trailing escapes are rejected.\nLimits: 12 boards; 40 actions and 12 setup keys each; 49152 UTF-8 bytes (32768 new content). Bytes may fill first. Use list, export, then delete ID confirm to free space."
} satisfies AgentFeatureMetadata;
