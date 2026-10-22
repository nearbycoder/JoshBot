import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "blocker-lab",
  "title": "Blocker lab",
  "description": "Separate a blocker’s observations from guesses and choose a small diagnostic next step.",
  "group": "Decide & analyze",
  "keywords": [
    "blocked",
    "root cause",
    "diagnosis",
    "experiment"
  ],
  "example": "/nobo-help agent blocker-lab open Draft keeps slipping | Need a repeatable explanation",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Separate reported observations, guesses, and diagnostic next steps.\nStart: /nobo-help agent blocker-lab open Draft keeps slipping | Need a repeatable explanation\nobservation CASE add text; hypothesis CASE add text\nobservation CASE edit CHILD text; hypothesis CASE edit CHILD text\ntest CASE HYPOTHESIS | action | expected observation | integer minutes 0–10080\ntest-edit CASE TEST | HYPOTHESIS | action | expected observation | minutes\nnext CASE; result CASE TEST | supports|refutes|inconclusive | observation (256 bytes)\nlink CASE FROM | TO | evidence|dependency|decision | open question\nlink-edit CASE LINK | FROM | TO | kind | question\nEvidence links go observation→hypothesis; dependency/decision links hypothesis→hypothesis. paths CASE HYPOTHESIS [page N] [rev N] traverses the latter separately, stopping at visited nodes.\nreview CASE [page N] [rev N]; edit CASE title|problem text; status CASE open|paused|closed\nremove CASE observation|hypothesis|test|link|result CHILD confirm\nRemove dependent links/tests before removing statements; remove results before rewriting tested hypotheses/tests. Re-enter result to correct its explicit label/observation. Closure is always user-entered.\nsuggest CASE (one optional model call; up to 5 unsaved conjectures)\nlist [page N]; show CASE [page N] [rev N]; export CASE; delete CASE confirm\nUse full returned IDs. A supporting result never proves causation or closes a case. Escape literal pipes as \\| and backslashes as \\\\.\nPrivate entered data only. No search, external actions or schedules. 12 cases / 20 total children each; byte limits can fill first. Export/delete to free space."
} satisfies AgentFeatureMetadata;
