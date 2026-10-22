import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "skill-matrix",
  "title": "Skill evidence matrix",
  "description": "Compare self-assessed skills with a target role and keep demonstrated evidence distinct from confidence.",
  "group": "Learn & improve",
  "keywords": [
    "skills",
    "competency",
    "role",
    "development gaps"
  ],
  "example": "/nobo-help agent skill-matrix create Backend role",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Skill evidence matrix — Compare self-assessed skills with a target role and keep demonstrated evidence distinct from confidence.\nStart: /nobo-help agent skill-matrix create Backend role\nThen: skill MATRIX add NAME | TARGET_0_TO_4 | TARGET_DEFINITION; self-rate MATRIX SKILL | LEVEL; evidence MATRIX SKILL | YYYY-MM-DD | EXAMPLE; gaps MATRIX [PAGE [rev TOKEN]]; review MATRIX SKILL | REFLECTION.\nEdit: edit MATRIX | title | VALUE; clear MATRIX title confirm.\nskill MATRIX edit SKILL | FIELD | VALUE (name or target); skill MATRIX clear SKILL name confirm; skill MATRIX remove SKILL confirm.\nrubric MATRIX SKILL | LEVEL_0_TO_4 | DEFINITION; rubric-remove MATRIX SKILL LEVEL confirm.\nassessment-remove MATRIX SKILL FIELD confirm (self or reflection).\nevidence-edit MATRIX SKILL EVIDENCE | YYYY-MM-DD | EXAMPLE; evidence-remove MATRIX SKILL EVIDENCE confirm.\nEach skill starts with explicit five-level definitions; custom target definition replaces that level. Skill/rubric/evidence edits clear dependent self-rating/reflection; no retained assessment history. Required target is removed with its skill.\nLimits: title/name 160 bytes, each rubric/reflection 320 bytes, example 1000 bytes. Review overwrites the current reflection. No model or context reads.\nUse returned full IDs. Pipes separate fields; escape literal pipes as \\| and backslashes as \\\\. Private, on demand; no search or external actions.\nManage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.\nCapacity: 10 matrices; 24 skills and 3 evidence records per skill. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only."
} satisfies AgentFeatureMetadata;
