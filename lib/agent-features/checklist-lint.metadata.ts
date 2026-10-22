import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "checklist-lint",
  "title": "Checklist quality check",
  "description": "Inspect a procedure for vague steps, missing verification, and unsafe ordering before anyone runs it.",
  "group": "Review & maintain",
  "keywords": [
    "checklist",
    "procedure",
    "quality",
    "verification"
  ],
  "example": "/nobo-help agent checklist-lint create Publish a guide | Applies to the public documentation site",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Checklist quality check — Inspect the design and order of a supplied procedure.\nStart: /nobo-help agent checklist-lint create Publish a guide | Applies to the public documentation site\nThen: step REVIEW add Check the page | none | Stop if links fail\nstep REVIEW add Open each example link | Every link resolves to the expected page | none\nrequires REVIEW FIRST | SECOND; audit REVIEW; move REVIEW SECOND | 1\nCommands after /nobo-help agent checklist-lint:\ncreate TITLE | APPLICABILITY\nedit REVIEW | title|applicability | TEXT (choose one field)\nclear REVIEW title|applicability confirm (choose one)\nstep REVIEW add ACTION | VERIFICATION | STOP_CONDITION\nstep REVIEW edit STEP | action|verification|stopCondition | TEXT (choose one field)\nstep REVIEW clear STEP action|verification|stopCondition confirm (choose one)\nstep REVIEW remove STEP confirm\nrequires REVIEW STEP | PREREQUISITE\nrequires-remove REVIEW STEP PREREQUISITE confirm\nmove REVIEW STEP | POSITION_1_BASED\naudit REVIEW [PAGE]; list [PAGE]; show REVIEW [PAGE]; export REVIEW; delete REVIEW confirm\nUse full returned IDs. Copy emitted PAGE rev TOKEN continuations unchanged. Pipe fields trim outer whitespace; escape literal pipe as \\| and backslash as \\\\. For verification/stopCondition, none is reserved for absent; clear also removes a field explicitly.\nFinite English vague words: check, review, ensure, handle, manage, validate. Case-insensitive whole ASCII words in action; exact zero-based UTF-16 spans. Duplicate rule uses NFC, lowercase, trim and collapsed whitespace, then exact equality. Missing verification and prerequisite-after-dependent have field guidance. Cycles are retained and flagged using bounded reachability; order alone cannot fix cycles. Unknown prerequisite IDs are rejected. Removing a step removes incident references, explicitly acknowledged.\nAdvisory only, not semantic understanding, safety certification or a release gate. No execution/done status, no toolbox checklist reads. Private entered data only; zero model/search/context calls and no external actions. Reports recompute without saving history.\n12 reviews, 30 ordered steps and 60 references/review. Title <=160 UTF-8 bytes, applicability <=1000, each step text <=500. Command <=16000 bytes; state/content/export limits 49152/32768/24576 serialized bytes, so bytes may bind first. Complete retained detail through show/export. At revision ceiling inspect/export then confirmed deletion/recreation; no reset or eviction. Help requires no state."
} satisfies AgentFeatureMetadata;
