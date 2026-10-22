import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "learning-transfer",
  "title": "Learning transfer",
  "description": "Turn a lesson into a real-world application, define evidence of use, and reflect on the result.",
  "group": "Learn & improve",
  "keywords": [
    "apply learning",
    "transfer",
    "application",
    "reflection"
  ],
  "example": "/nobo-help agent learning-transfer create Use smaller PRs | Workshop notes | Keep each change focused on one purpose",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Learning transfer — apply a supplied lesson and compare predicted with reported observations.\nStart: /nobo-help agent learning-transfer create Use smaller PRs | Workshop notes | Keep each change focused on one purpose\nUse the returned full APPLICATION and observation IDs below. Commands after /nobo-help agent learning-transfer:\ncreate LESSON | SOURCE-LABEL | EXCERPT\napply APPLICATION | OPPORTUNITY | ACTION\npredict APPLICATION | PREDICTED-OBSERVATION\nobserve APPLICATION | ACTUAL-OBSERVATION\nreflect APPLICATION | NEXT-ADJUSTMENT\nreview APPLICATION [page N] [rev R]\nedit APPLICATION lesson|sourceLabel|sourceExcerpt|opportunity|action|prediction | TEXT\nclear APPLICATION lesson|sourceLabel|sourceExcerpt|opportunity|action|prediction|reflection confirm\nobservation APPLICATION edit OBSERVATION | YYYY-MM-DD | TEXT\nobservation APPLICATION remove OBSERVATION confirm\nhelp; list [N] [snapshot HASH]; show APPLICATION [page N] [rev R]; export APPLICATION; delete APPLICATION [confirm]\nEdits to lesson/provenance/plan mark old observations and reflections stale; editing an observation explicitly reasserts it against the current plan. reflect replaces the adjustment. Clear a field or remove its containing record to erase it.\nPlanned is not applied. Observe needs a complete plan; reflect needs a current observation. Dates are civil labels; observe uses the request's explicit timezone.\nLiteral pipes use \\|; literal backslashes use \\\\. Plain slash output preserves text.\nLimits: 20 applications, 5 observations each; 49152 UTF-8 state bytes, 32768 content admission, 24576 complete export. Bytes can bind first; remaining lifecycle is reserved. Lesson/label 120 bytes each; excerpt 600 JS units/1800 bytes; opportunity 180, action 300, prediction/observation/adjustment 240 bytes. list reports quota; export then delete APPLICATION confirm frees space.\nPrivate and on demand. Zero model/search/context calls; supplied provenance is unverified. No card/goal/account changes."
} satisfies AgentFeatureMetadata;
