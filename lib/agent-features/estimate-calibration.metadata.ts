import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "estimate-calibration",
  "title": "Estimate calibration",
  "description": "Compare effort estimates with actuals and calculate a transparent adjustment from similar completed work.",
  "group": "Learn & improve",
  "keywords": [
    "estimation",
    "calibration",
    "actuals",
    "planning fallacy"
  ],
  "example": "/nobo-help agent estimate-calibration estimate Draft article | writing | 60",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Compare estimated and actual effort, with a transparent category median.\nStart: /nobo-help agent estimate-calibration estimate Draft article | writing | 60\nUse returned full SAMPLE IDs:\nactual SAMPLE | minutes\nreport category\nforecast category | positive minutes\nedit SAMPLE label new text; edit SAMPLE category new text\ncorrect SAMPLE | positive minutes | reason (explicit correction; original stays frozen)\nexclude SAMPLE | reason\nremove SAMPLE actual|correction|exclusion confirm\nlist [page N]; show SAMPLE [page N] [rev N]; export SAMPLE; delete SAMPLE confirm\nNumbers: up to 1,000,000 minutes, 3 decimals; estimates positive, actual zero allowed. At least 3 complete nonexcluded samples for adjustment. Excluded and incomplete counts are separate. Forecasts are unsaved.\nPipes separate fields; escape literal pipes as \\| and backslashes as \\\\.\nPrivate entered data only; no models, search, timers, or external actions. 60 samples / 12 categories; byte limits can fill first. Export then delete to free space."
} satisfies AgentFeatureMetadata;
