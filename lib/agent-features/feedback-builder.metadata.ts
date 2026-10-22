import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "feedback-builder",
  "title": "Feedback builder",
  "description": "Build actionable feedback by separating observed behavior, impact, and a specific request.",
  "group": "Write & communicate",
  "keywords": [
    "feedback",
    "behavior",
    "impact",
    "request"
  ],
  "example": "/nobo-help agent feedback-builder create Review handoff | Monday planning meeting",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Prepare feedback that separates observations, personal impact and a specific request.\nStart: /nobo-help agent feedback-builder create Review handoff | Monday planning meeting\nCommands follow /nobo-help agent feedback-builder; use returned IDs.\ncreate TITLE | SITUATION\nbehavior ID | OBSERVATION; impact ID | PERSONAL-IMPACT\nrequest ID | SPECIFIC-CHANGE; positive ID | POSITIVE-EXAMPLE\ninference ID | INTERPRETATION (explicitly unverified)\nreclassify ID confirm — move behavior into an interpretation and clear behavior\ninterpretation ID edit INFERENCE | TEXT; interpretation ID remove INFERENCE confirm\nedit ID | title/situation/behavior/impact/request/positive | TEXT\nclear ID FIELD confirm\ncheck ID [page [rev REV]] — missing fields and exact lexical matches, labeled heuristics\ndraft ID [page [rev REV]] — deterministic unsent observation/impact/request template\npolish ID — one optional model call, unsaved; observations and interpretations must retain exact wording and labels\nCopy complete continuation commands: REV binds the revision and content; stale pages require a fresh page 1.\nlist [page]; show ID [page [rev REV]]; export ID; delete ID confirm\nEntered observations are not verified facts. Inferences never become observations automatically. Nothing sends or records another person's agreement. Sources: entered data only. Polish sends it to the configured text model.\nUse \\| for literal pipes and \\\\ for backslashes; unknown escapes fail.\nPrivate saved cases: 12 roots and 20 interpretations each. Title 160, other text 1000 UTF-8 bytes; content 32768/state 49152 bytes; export 24576. Use list/export/delete to free space."
} satisfies AgentFeatureMetadata;
