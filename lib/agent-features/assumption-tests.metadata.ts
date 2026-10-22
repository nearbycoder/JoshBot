import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "assumption-tests",
  "title": "Assumption tests",
  "description": "Turn an uncertain belief into a falsifiable, bounded test with a predeclared result rule.",
  "group": "Decide & analyze",
  "keywords": [
    "hypothesis",
    "validation",
    "assumption",
    "experiment"
  ],
  "example": "/nobo-help agent assumption-tests create Shorter form increases responses | response count | at-least | 5 | 1 | 60",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Lock a numeric test rule before collecting observations.\nStart: /nobo-help agent assumption-tests create Shorter form increases responses | response count | at-least | 5 | 1 | 60\ncreate belief | metric | at-least|at-most | threshold | sample minimum 1–20 | effort cap\nThe predeclared statistic is the arithmetic MEAN of observation values; sample minimum counts observations, not people inside a count.\nmethod EXPERIMENT | procedure\nlock EXPERIMENT\nobserve EXPERIMENT | YYYY-MM-DD | value | effort minutes | note (use - for no note)\nevaluate EXPERIMENT\nrevise EXPERIMENT | reason (new draft; retains original result)\nedit EXPERIMENT belief|metric|direction|threshold|sampleMinimum|effortCapMinutes|revisionReason value\nLocked design edits, including method, create a separate draft version. Edit then lock it before new observations. Archived versions stay immutable.\nobserve-edit EXPERIMENT | OBSERVATION | date | value | effort | note\nremove EXPERIMENT observation|note OBSERVATION confirm\nremove EXPERIMENT method|revisionReason confirm (current draft only)\nObservation changes invalidate evaluation. Each observation has equal weight. Effort overruns remain explicit; criterion met is not proof of causation.\nlist [page N]; show EXPERIMENT [page N] [rev N]; export EXPERIMENT; delete EXPERIMENT confirm\nUse returned IDs. Numbers ±1,000,000, 3 decimals; effort nonnegative, cap positive. Dates stay civil labels. Escape literal pipes as \\| and backslashes as \\\\.\nPrivate entered data; no models, search, sends or schedules. 12 experiments, 20 observations TOTAL each, 3 retained designs each; bytes may fill first. Optional notes consume content; numeric minimum-sample completion is reserved. Export/delete to free space."
} satisfies AgentFeatureMetadata;
