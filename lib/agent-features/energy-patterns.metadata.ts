import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "energy-patterns",
  "title": "Energy pattern review",
  "description": "Find useful patterns in your own energy check-ins without treating mood or missing days as energy measurements.",
  "help": "Describe literal energy check-ins, without treating journal mood or missing days as energy.\nStart: /nobo-help agent energy-patterns checkin 2026-10-22 | morning | 4 | writing | Felt alert\ncheckin DATE | morning/afternoon/evening | ENERGY | ACTIVITY | NOTE\nENERGY is an integer 1–5; DATE is literal YYYY-MM-DD. Activity/note may be empty.\nedit CHECKIN | DATE | BAND | ENERGY | ACTIVITY | NOTE — replace all fields.\nnote CHECKIN | TEXT — replace context note, no causal inference.\nclear CHECKIN date/band/energy/activity/note confirm — remove a field; incomplete measurements are excluded.\npatterns START | END — inclusive range. At least 3 samples per band/activity before median/range/sample dates; sparse groups remain sparse.\njournals DATE — one read of only your owned journal. Lists literal day, title, ID and current fingerprint; copy emitted stamped continuations exactly.\njournal SOURCE_ID — inspect complete current source text/metadata, with one fresh journal read.\nattach CHECKIN | SOURCE_ID | FINGERPRINT | EXACT_EXCERPT — select at most 400 JS units from current journal text. Rereads once, validates fingerprint/span and saves excerpt/day/provenance. Reissue for that source to replace its snapshot. Historical excerpts are not current-source verification.\ndetach CHECKIN ATTACHMENT_ID confirm — remove selected excerpt only; never edits the journal.\nhelp; list [page N]; show CHECKIN [page N rev R stamp HASH]; export CHECKIN; delete CHECKIN confirm\nPatterns/journal pages emit page N rev R stamp HASH continuations; changes require restarting. Use full returned IDs. Literal pipes/backslashes: \\| / \\\\.\nPrivate/on demand; zero model/search calls, no health claims or background work. Activity 80, note 240 UTF-8 bytes; 90 check-ins, 10 selected excerpts total, 8000 title/excerpt bytes. Journal adapter max 100, one read per journals/attach invocation. Source failures preserve saved work; check /nobo-help tools journal list. State 49152 bytes; new content 32768; export 24576. Lifecycle projections reserve selected snapshot replacements and revisions. Limits may be reached by bytes first; use show/export then confirmed deletion to free space.\n",
  "group": "Review & maintain",
  "keywords": [
    "energy",
    "day rhythm",
    "reflection",
    "capacity"
  ],
  "example": "/nobo-help agent energy-patterns checkin 2026-10-22 | morning | 4 | writing | Felt alert",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 1,
    "storeReads": 8,
    "storeUpdates": 4
  }
} satisfies AgentFeatureMetadata;
