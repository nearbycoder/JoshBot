import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "decision-journal",
  "title": "Decision outcome journal",
  "description": "Record a decision’s expectations before the result, then review what actually happened.",
  "group": "Decide & analyze",
  "keywords": [
    "decision",
    "outcome",
    "hindsight",
    "review"
  ],
  "example": "/nobo-help agent decision-journal record Use a short signup form | Reduce friction | 2026-11-20",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Record expectations first; compare later outcomes without rewriting the original.\nStart: /nobo-help agent decision-journal record Use a short signup form | Reduce friction | 2026-11-20\nexpect DECISION | metric | predicted value | unit\nlock DECISION (freezes choice, rationale, review date and expectations)\noutcome DECISION | exact metric | actual value | identical unit | YYYY-MM-DD\nreview DECISION [page N] [rev N]\nlesson DECISION | later reflection\nBefore lock: edit DECISION choice|rationale|reviewDate text\nexpect-edit DECISION EXPECTATION | metric | value | unit\nlesson-edit DECISION LESSON | text\nremove DECISION expectation|outcome|lesson CHILD confirm (expectations only before lock)\nRe-enter outcome to correct its value/date; original predictions stay frozen. No unlock: use record for a different decision.\nlist [page N]; due [page N]; show DECISION [page N] [rev N]; export DECISION; delete DECISION confirm\nUse full returned IDs. Actual minus predicted uses percentage points for percent or % units. Numbers range ±1,000,000 with 3 decimals. Due dates are civil labels evaluated on demand in your timezone, with no scheduling.\nEscape literal pipes as \\| and backslashes as \\\\. Private entered data only; no models, search, external actions or channel decision entries. 20 decisions; 8 expectations/outcomes and 5 lessons each; byte limits can fill first. Export/delete to free space."
} satisfies AgentFeatureMetadata;
