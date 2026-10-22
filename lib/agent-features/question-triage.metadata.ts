import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "question-triage",
  "title": "Open question triage",
  "description": "Identify which unanswered questions block a decision and define what evidence would settle them.",
  "group": "Capture & recall",
  "keywords": [
    "questions",
    "unknowns",
    "decision blockers",
    "research plan"
  ],
  "example": "/nobo-help agent question-triage create Choose workshop format",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Open question triage — prioritize decision-blocking uncertainty and explicit evidence requests.\nStart: /nobo-help agent question-triage create Choose workshop format\nReplace BOARD/QUESTION/CHALLENGE with returned IDs. Commands follow /nobo-help agent question-triage:\ncreate DECISION\nedit BOARD | DECISION\nask BOARD add QUESTION_TEXT | blocking|optional | CONSEQUENCE\nask BOARD edit QUESTION | QUESTION_TEXT | blocking|optional | CONSEQUENCE\nevidence-needed BOARD QUESTION | CRITERION\nanswer BOARD QUESTION | ANSWER | SOURCE_LABEL | REVIEW_DATE\nanswer-edit BOARD QUESTION | ANSWER | SOURCE_LABEL | REVIEW_DATE\nchallenge BOARD QUESTION | NOTE\nchallenge-edit BOARD QUESTION | CHALLENGE | NOTE\nremove BOARD question|evidence|answer|challenge CHILD_ID confirm\nqueue BOARD [page N rev R as-of YYYY-MM-DD]\nlist [page N]\nshow BOARD [page N rev R]\nexport BOARD\ndelete BOARD [confirm]\nhelp\nChoose one kind token. REVIEW_DATE is a real YYYY-MM-DD civil label or unknown; never a fabricated timestamp. Evidence/answer removal uses QUESTION; challenge removal uses CHALLENGE. Question deletion removes its answer and challenges. Literal pipe: \\|; backslash: \\\\. Surrounding field whitespace is trimmed.\nBlocking unanswered/challenged/stale questions lead the queue; dated reviews follow. Answers without a criterion remain unresolved. All answers/source labels are user reports, not verified facts. Changing the decision/question/consequence/criterion marks the prior answer stale. answer-edit explicitly re-reports it but retains challenges; remove a challenge explicitly when settled.\nDecision 160 UTF-8 bytes, question 320, consequence/criterion/answer 256, source label/challenge 128. At most 12 boards, 24 questions each, one answer and 3 challenges per question. Actual and reserved lifecycle bytes can limit counts first. 49152 state bytes, 32768 content admission, 24576 complete export. Admission reserves every answer/review date and all challenge slots. Optional wording/criteria edits are content; answers/challenges/removals remain possible after admission.\nUse exact continuation commands: revisions and queue as-of dates are bound; changed records restart page 1. show/export retrieve all fields. Private/on demand; zero model/context/search or external actions. No expiry/eviction; export/delete explicitly to free space."
} satisfies AgentFeatureMetadata;
