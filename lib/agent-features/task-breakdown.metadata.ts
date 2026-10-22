import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "task-breakdown",
  "title": "Task breakdown",
  "description": "Turn a vague outcome into small, testable steps and a clear starting action.",
  "group": "Plan & prioritize",
  "keywords": [
    "subtasks",
    "start",
    "outcome",
    "definition of done"
  ],
  "example": "/nobo-help agent task-breakdown create Publish a short guide | Readers can install the app | 30",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Task breakdown — Turn a vague outcome into small, testable steps and a clear starting action.\nStart: /nobo-help agent task-breakdown create Publish a short guide | Readers can install the app | 30\nReplace WORK/PLAN/FORECAST/BOARD/SCOPE and child placeholders with the full returned IDs.\ncreate OUTCOME | SUCCESS | SESSION-MINUTES; edit WORK | OUTCOME | SUCCESS | SESSION-MINUTES\nstep WORK add ACTION | MINUTES | PROOF; step WORK edit STEP | ACTION | MINUTES | PROOF\nstep WORK remove STEP confirm; move WORK STEP | POSITION\ncheck WORK [page]; next WORK\ncomplete WORK STEP | REPORT; completion-edit WORK STEP | REPORT; reopen WORK STEP confirm\nsuggest WORK\nManage: list [page]; show ID [page]; export ID; delete ID confirm.\nProof may be empty for an unfinished draft; check flags it. Explicit reported completion only. Editing completed steps requires reopen first, which removes their completion report. suggest sends this workspace to the text model once; its bounded draft is unsaved and discarded on concurrent edits. Add chosen steps explicitly.\nPrivate saved inputs; reports/what-if are unsaved. Sources: your input and this feature only. No search or external actions.\nFields use |. Escape a literal pipe as \\| and a literal backslash as \\\\; other/trailing escapes are rejected.\nLimits: 12 workspaces; 20 child records per workspace; 49152 UTF-8 bytes (32768 new content). Bytes may fill first. Use list, export, then delete ID confirm to free space."
} satisfies AgentFeatureMetadata;
