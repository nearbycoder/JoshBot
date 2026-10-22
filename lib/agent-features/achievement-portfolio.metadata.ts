import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "achievement-portfolio",
  "title": "Achievement portfolio",
  "description": "Turn concrete work into evidence-backed accomplishment stories for reviews or applications.",
  "group": "Learn & improve",
  "keywords": [
    "brag document",
    "achievement",
    "portfolio",
    "impact"
  ],
  "example": "/nobo-help agent achievement-portfolio create Simplified onboarding | New users struggled with setup",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Achievement portfolio — Turn concrete work into evidence-backed accomplishment stories for reviews or applications.\nStart: /nobo-help agent achievement-portfolio create Simplified onboarding | New users struggled with setup\nThen: action ID | PERSONAL_ACTION; result ID | RESULT | VALUE | UNIT | BASELINE (leave baseline blank if unknown); evidence ID | LABEL | EXCERPT; collaborators ID | TEAM_CONTRIBUTION; privacy ID | NOTE.\nstory ID [PAGE [rev TOKEN]]; bullets ID [PAGE [rev TOKEN]].\nEdit any entered field: edit ID | FIELD | VALUE; clear ID FIELD confirm. Fields: title, challenge, action, result, collaborators, privacy, metric.value, metric.unit, metric.baseline.\nevidence-edit ID EVIDENCE | LABEL | EXCERPT; evidence-remove ID EVIDENCE confirm.\nOptional: polish ID | review OR polish ID | resume. One unsaved structural rewrite; finite model-selected ordering, renderer-owned exact facts, all evidence IDs required. Long complete drafts are refused before generation. No free-form generated claims.\nLimits: title/labels/unit 160 UTF-8 bytes; other text 1000 bytes; excerpts 500 string units/2000 bytes; plain decimals up to 12 integer/6 fractional digits. Unknown metric fields remain unknown. No context reads.\nUse returned full IDs. Pipes separate fields; escape literal pipes as \\| and backslashes as \\\\. Private, on demand; no search or external actions.\nManage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.\nCapacity: 20 achievements; 8 evidence excerpts of 500 characters each. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only."
} satisfies AgentFeatureMetadata;
