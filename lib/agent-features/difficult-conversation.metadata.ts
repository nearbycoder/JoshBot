import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "difficult-conversation",
  "title": "Conversation rehearsal",
  "description": "Rehearse a challenging conversation with your goal, boundaries, likely objections, and chosen responses.",
  "group": "Write & communicate",
  "keywords": [
    "rehearsal",
    "conversation",
    "objection",
    "negotiation"
  ],
  "example": "/nobo-help agent difficult-conversation create Discuss shifting the deadline | Agree on a feasible scope",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Prepare and practice a difficult conversation privately, one explicit objection at a time.\nStart: /nobo-help agent difficult-conversation create Discuss shifting the deadline | Agree on a feasible scope\nCommands follow /nobo-help agent difficult-conversation. Use returned IDs.\ncreate TOPIC | GOAL\nopening ID | TEXT; boundary ID | TEXT; concession ID | TEXT; stop ID | TEXT\nedit ID | title/goal/opening/boundary/concession/stop | TEXT\nclear ID FIELD confirm (edits clear active practice)\nobjection ID add OBJECTION | PREPARED-RESPONSE\nobjection ID edit CARD | OBJECTION | PREPARED-RESPONSE (remove retained attempts first)\nobjection ID remove CARD confirm (includes attempts)\nprepare ID [page [rev REV]]; practice ID CARD (hides prepared response)\nrespond ID | ATTEMPT (320 UTF-8 bytes; finishes the active turn)\nreview ID CARD [page [rev REV]] (reveals prepared response after an attempt)\ncancel ID confirm (clears active card; preserves attempts)\nattempt ID CARD edit ATTEMPT | TEXT; attempt ID CARD remove ATTEMPT confirm\nrate ID CARD ATTEMPT | 1-5; unrate ID CARD ATTEMPT confirm\nsimulate ID | OBJECTION — one optional hypothetical reply, unsaved; never attributed to a real person\nCopy complete continuation commands: REV binds the revision and content; stale pages require a fresh page 1.\nlist [page]; show ID [page [rev REV]]; export ID; delete ID confirm\nPrivate entered data only. No conversation loop, sending or agreement. Simulate sends entered scenario/objection to the configured text model. Show/export expose all your prepared responses intentionally; practice hides them.\nUse \\| for literal pipes and \\\\ for backslashes; unknown escapes fail.\nLimits: 12 sessions, 12 cards/session, 2 attempts/card. Both attempt slots are reserved at admission, so bytes can fill before counts. Topic 160, other text 1000, attempts 320 UTF-8 bytes. Content 32768/state 49152 bytes; export 24576. Use list/export/delete to free space."
} satisfies AgentFeatureMetadata;
