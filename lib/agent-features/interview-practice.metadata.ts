import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "interview-practice",
  "title": "Interview practice",
  "description": "Practice a timed answer with a role-specific rubric and inspect the evidence you actually supplied.",
  "group": "Learn & improve",
  "keywords": [
    "interview",
    "STAR",
    "answer practice",
    "career"
  ],
  "example": "/nobo-help agent interview-practice create Backend interview | 120 | 130",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Interview practice — Practice a timed answer with a role-specific rubric and inspect the evidence you actually supplied.\nStart: /nobo-help agent interview-practice create Backend interview | 120 | 130\nThen: question SESSION add TEXT | TYPE; answer SESSION QUESTION | ANSWER; annotate SESSION ATTEMPT | SECTION | EXACT_SPAN; review SESSION ATTEMPT [PAGE [rev TOKEN]]; revise SESSION ATTEMPT | NEW_ANSWER (distinct attempt).\nTYPE: behavioral, technical, situational, general. SECTION: situation, task, action, result.\nEdit: edit SESSION | FIELD | VALUE; clear SESSION FIELD confirm. Fields: title, answerSeconds, wordsPerMinute.\nquestion SESSION edit QUESTION | TEXT | TYPE; question SESSION remove QUESTION confirm.\nattempt-edit SESSION ATTEMPT | TEXT (clears annotations/ratings); attempt-remove SESSION ATTEMPT confirm.\nannotate-span SESSION ATTEMPT | SECTION | START | END (UTF-16, end exclusive; exact Unicode boundaries); annotation-remove SESSION ATTEMPT SECTION confirm.\nrate SESSION ATTEMPT | clarity OR relevance OR evidence | LEVEL_0_TO_4; rating-remove SESSION ATTEMPT FIELD confirm.\nOptional: coach SESSION ATTEMPT; one unsaved exact-quote-linked finite critique/follow-up. No employer facts or invented achievements. No context reads.\nLimits: role 160 bytes; question 1000 bytes; answer 2000 units/8000 bytes; target 15–600 seconds; 40–300 words/minute. Existing attempts retain original question snapshots. Timing is approximate; missing STAR depends only on your annotations.\nUse returned full IDs. Pipes separate fields; escape literal pipes as \\| and backslashes as \\\\. Private, on demand; no search or external actions.\nManage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.\nCapacity: 10 sessions; 8 questions and 2 attempts/question; 2000 characters/attempt. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only."
} satisfies AgentFeatureMetadata;
