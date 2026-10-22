import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "practice-lab",
  "title": "Deliberate practice lab",
  "description": "Run a self-scored practice attempt against a rubric and choose what to improve next.",
  "group": "Learn & improve",
  "keywords": [
    "practice",
    "rubric",
    "drill",
    "skill"
  ],
  "example": "/nobo-help agent practice-lab create Explain a technical tradeoff in two minutes",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Deliberate practice lab — self-score observable performance and choose a focused next attempt.\nStart: /nobo-help agent practice-lab create Explain a technical tradeoff in two minutes\nCommands after /nobo-help agent practice-lab (use full returned IDs):\ncreate TASK\nrubric DRILL add LABEL | MAX-SCORE | OBSERVABLE-DESCRIPTION\nattempt DRILL | RESPONSE\nscore DRILL ATTEMPT | DIMENSION | SCORE | EVIDENCE\nprogress DRILL [page N] [rev R]\nnext DRILL [page N] [rev R]\nfeedback DRILL ATTEMPT\nedit DRILL task | TEXT\nclear DRILL task confirm\nrubric DRILL edit DIMENSION | LABEL | MAX-SCORE | DESCRIPTION\nrubric DRILL clear DIMENSION label|maxScore|description confirm\nrubric DRILL remove DIMENSION confirm\nattempt DRILL edit ATTEMPT | RESPONSE\nattempt DRILL clear ATTEMPT response confirm\nattempt DRILL remove ATTEMPT confirm\nunscore DRILL ATTEMPT DIMENSION confirm\nreopen DRILL ATTEMPT confirm\nhelp; list [N]; show DRILL [page N] [rev R]; export DRILL; delete DRILL [confirm]\nNext: declare rubric, attempt, score each dimension with evidence, inspect progress/next. score replaces score/evidence. An attempt is completed only when every dimension has a current user score. Missing scores are unknown; lowest relative score divides by that dimension's maximum. Comparisons use only completed attempts sharing one rubric version.\nTask/rubric changes create a new version. Up to six attempts retain bounded historical task/rubric snapshots; they never certify changed work. Remove an attempt to erase its historical copies. Response edits/reopen mark scores stale; unscore erases a score and its evidence. All accepted fields can be replaced/cleared or removed with their record.\nfeedback is one explicit model call using the selected attempt's snapshot. Unsaved opinions require actual dimension IDs, exact rubric descriptions and exact response quotes. No invented grades, correctness certification, retries or repairs. Changed/deleted drills discard pending output; Stop cancels invocation.\nBounds: 10 drills, 6 dimensions/6 attempts each. Task 160, label 80, description/evidence 160, response 1200 UTF-8 bytes; maxScore 1–100, user score 0–max. State 49152, content 32768, complete export 24576 bytes. Every accepted attempt reserves maximum response/scores/evidence; a first-attempt slot is reserved. list shows usage; export then delete DRILL confirm frees space. Bytes may bind first.\nModel input <=16000 bytes, instructions <=4000; accepted output <=4000 JS units AND entire reply <=3500. Post-generation bounds are not upstream token caps. Zero searches/context reads. Literal pipes: \\|; backslashes: \\\\. Private, plain slash text; no audio, external actions or automatic grades.\nRubric/attempt/response evidence versions have an intentional finite limit of 9,007,199,254,740,991. At exhaustion, changes/removals needing a new version are refused; valid saved data and history stay unchanged. Use export ID for the complete record, then delete ID confirm only to erase that entire root and its history, or create a separate record from explicitly re-entered data. Root revision ceilings still permit removals when semantic versions have capacity."
} satisfies AgentFeatureMetadata;
