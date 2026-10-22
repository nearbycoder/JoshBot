import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "errand-batch",
  "title": "Errand windows",
  "description": "Find feasible errand groups from your available window, supplied opening hours, and travel estimates.",
  "group": "Organize life",
  "keywords": [
    "errands",
    "opening hours",
    "travel estimates",
    "route"
  ],
  "example": "/nobo-help agent errand-batch create Saturday errands | 2026-10-24 | 09:00 | 120 | home",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Errand windows — supplied opening hours, travel, service, waiting and return home.\nStart: /nobo-help agent errand-batch create Saturday errands | 2026-10-24 | 09:00 | 120 | home\ncreate TITLE | YYYY-MM-DD | DEPARTURE | AVAILABLE_MINUTES | HOME_LABEL\nstop ID add NAME | SERVICE_MINUTES | OPEN-CLOSE\nstop ID edit STOP | NAME | SERVICE_MINUTES | OPEN-CLOSE\nstop ID remove STOP confirm\nstop ID clear STOP name/window/serviceMinutes confirm\ntravel ID | FROM | TO | MINUTES\nuntravel ID | FROM | TO | confirm\nplan ID [PAGE [rev TOKEN]]\nedit ID | FIELD | VALUE\nclear ID FIELD confirm\nFields: title, date, departure, availableMinutes, startLabel. edit also accepts timezone (IANA); clearing required fields makes the plan incomplete.\nlist [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID [confirm]; help\nFROM/TO are home or full returned STOP IDs. Travel is directed; missing legs are unknown, never zero. Removing a stop deletes its incident legs. Edits replace supplied fields; plans are unsaved and always recomputed.\nTimes: HH:mm or HH:mmZ/HH:mm±HH:mm, e.g. 01:30-05:00. Windows: 09:00-12:00; explicit endpoint offsets also work. All times must round-trip in the saved caller IANA timezone. DST ambiguous times need explicit offsets; nonexistent times reject even with mismatching offsets. Dates 1900–2200 (shared resolver); no overnight outing/window. Budget 1–720 elapsed minutes and ends on that civil day; travel/service 0–720 minutes.\nStable greedy earliest-closing order then entered order, including waits. Infeasible stops and missing/late return remain visible. No maps, directions, optimality or live opening-hours claim.\nLabels <=160 UTF-8 bytes; timezone <=100. Escape literal | with \\| and backslash with \\\\.\n10 outings, 12 stops/156 directed legs each; new content <=32768, state <=49152, complete export <=24576 UTF-8 bytes. Byte limits can bind first. Revision growth reserved; delete explicitly to free space.\nPrivate/on demand. Zero model/search/context; no booking, jobs, notification or external action."
} satisfies AgentFeatureMetadata;
