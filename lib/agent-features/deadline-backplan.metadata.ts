import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "deadline-backplan",
  "title": "Deadline backplan",
  "description": "Work backward from a finish date through prerequisites, working days, and explicit buffers.",
  "group": "Plan & prioritize",
  "keywords": [
    "deadline",
    "milestones",
    "critical path",
    "dependencies"
  ],
  "example": "/nobo-help agent deadline-backplan create Conference proposal | 2026-12-04 | mon,tue,wed,thu,fri",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Deadline backplan — Work backward from a finish date through prerequisites, working days, and explicit buffers.\nStart: /nobo-help agent deadline-backplan create Conference proposal | 2026-12-04 | mon,tue,wed,thu,fri\nReplace WORK/PLAN/FORECAST/BOARD/SCOPE and child placeholders with the full returned IDs.\ncreate TITLE | FINISH-DATE | mon,tue,wed,thu,fri\nedit PLAN | TITLE | FINISH-DATE | WEEKDAYS\nmilestone PLAN add LABEL | WORK-DAYS | BUFFER-DAYS\nmilestone PLAN edit MILESTONE | LABEL | WORK-DAYS | BUFFER-DAYS\nmilestone PLAN remove MILESTONE confirm\ndepends PLAN MILESTONE | PREREQUISITE; undepend PLAN MILESTONE | PREREQUISITE confirm\nexclude PLAN | DATE; include PLAN | DATE confirm\nbackplan PLAN [page]\nManage: list [page]; show ID [page]; export ID; delete ID confirm.\nWhole working days: duration includes start/finish; buffer occupies following working days. Prerequisite plus buffer ends before dependent starts. Explicit weekdays/exclusions only; no implicit holidays. Finish edits must be within 366 civil days of today; analysis uses the 366-day window ending at finish. No model calls.\nPrivate saved inputs; reports/what-if are unsaved. Sources: your input and this feature only. No search or external actions.\nFields use |. Escape a literal pipe as \\| and a literal backslash as \\\\; other/trailing escapes are rejected.\nLimits: 8 plans; 20 milestones, 60 edges, 30 excluded dates per plan; horizon at most 366 days; 49152 UTF-8 bytes (32768 new content). Bytes may fill first. Use list, export, then delete ID confirm to free space."
} satisfies AgentFeatureMetadata;
