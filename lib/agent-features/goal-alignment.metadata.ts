import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "goal-alignment",
  "title": "Goal alignment",
  "description": "See where planned effort contributes to your selected goals and where work has no stated purpose.",
  "group": "Plan & prioritize",
  "keywords": [
    "alignment",
    "goals",
    "effort",
    "priorities"
  ],
  "example": "/nobo-help agent goal-alignment create November effort",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 1,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Goal alignment — See where planned effort contributes to your selected goals and where work has no stated purpose.\nStart: /nobo-help agent goal-alignment create November effort\nThen: goals BOARD [PAGE [rev TOKEN source FINGERPRINT]]; select BOARD | EXACT_SOURCE_ID; activity BOARD add LABEL | MINUTES; link BOARD ACTIVITY | GOAL_ID | PERCENT | REASON; review BOARD [PAGE [rev TOKEN]].\nsource BOARD SOURCE_ID [PAGE [rev TOKEN source FINGERPRINT]] retrieves full adapter source. Each source operation reads only goal context once, max 100 items. No silent selection/truncation. Selected sources: 10, summed source text <=8000 UTF-8 bytes.\nrefresh BOARD checks current sources, preserving historical snapshots and labeling changed/absent. replace BOARD | SOURCE_ID | confirm explicitly replaces one with fresh evidence. Show/review are historical, with no refresh.\nlocal BOARD | LABEL; local-edit BOARD LOCAL_ID | LABEL; goal-remove BOARD GOAL_ID confirm (also removes its board shares, never source data).\nEdit: edit BOARD | title | VALUE; clear BOARD title confirm.\nactivity BOARD edit ACTIVITY | label OR minutes | VALUE; activity BOARD clear ACTIVITY label confirm; activity BOARD remove ACTIVITY confirm. Required minutes are removed with activity.\nlink again edits share/reason; unlink BOARD ACTIVITY GOAL_ID confirm. Shares 1–100%, summed <=100%; minutes 0–1000000. No equal allocation inferred. Limits: labels 160 bytes, reasons 320 bytes.\nNumeric progress/status is not proof of completion or causal impact; source deadlines stay civil dates. Owned context is read-only. No model/search or hidden cross-feature reads.\nUse returned full IDs. Pipes separate fields; escape literal pipes as \\| and backslashes as \\\\. Private, on demand; no search or external actions.\nManage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.\nCapacity: 10 boards; 10 selected goals and 30 activities each. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only."
} satisfies AgentFeatureMetadata;
