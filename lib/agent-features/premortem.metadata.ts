import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "premortem",
  "title": "Project premortem",
  "description": "Find plausible failure modes before starting and pair them with triggers and mitigations.",
  "group": "Decide & analyze",
  "keywords": [
    "risk",
    "premortem",
    "mitigation",
    "early warning"
  ],
  "example": "/nobo-help agent premortem create Launch workshop | Attendees complete the exercise",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Plan observable warnings and responses for plausible failures.\nStart: /nobo-help agent premortem create Launch workshop | Attendees complete the exercise\nrisk PLAN add failure | likelihood 1–5 | impact 1–5\ntrigger PLAN RISK | observable warning\nmitigate PLAN RISK | response | owner label\nresidual PLAN RISK | likelihood | impact | reason (256 bytes)\nreview PLAN [page N] [rev N]; status PLAN RISK open|mitigating|monitoring|closed\nedit PLAN title|outcome text\nrisk PLAN edit RISK failure | likelihood | impact (before residual, or remove residual first)\nremove PLAN RISK risk|trigger|mitigation|residual confirm\nsuggest PLAN (one optional model call; up to 5 unsaved conjectures)\nlist [page N]; show PLAN [page N] [rev N]; export PLAN; delete PLAN confirm\nReplace PLAN/RISK with returned IDs. Rating products are ordinal priorities, never probabilities; residual ratings retain originals. Re-enter trigger, mitigate, or residual to edit those fields. Owner is only a label, no assignment.\nEscape literal pipes as \\| and backslashes as \\\\. Private entered data only; no search, sends or schedules. 12 plans, 20 risks each; bytes may fill first. Export/delete to free space."
} satisfies AgentFeatureMetadata;
