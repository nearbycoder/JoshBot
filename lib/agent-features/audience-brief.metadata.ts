import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "audience-brief",
  "title": "Audience brief",
  "description": "Adapt one set of facts into concise updates for different readers without losing required details.",
  "group": "Write & communicate",
  "keywords": [
    "executive update",
    "audience",
    "briefing",
    "compression"
  ],
  "example": "/nobo-help agent audience-brief create Pilot update",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Build audience-specific updates from one canonical set of entered facts.\nStart: /nobo-help agent audience-brief create Pilot update\nCommands follow /nobo-help agent audience-brief. Use returned ID, FACT and AUDIENCE values.\ncreate TITLE\nfact ID add TEXT | required/important/optional\nfact ID edit FACT | TEXT | required/important/optional\nfact ID remove FACT confirm (also removes its audience requirement links)\naudience ID add NAME | NEEDS | WORDS\naudience ID edit AUDIENCE | NAME | NEEDS | WORDS\naudience ID remove AUDIENCE confirm\nrequire ID AUDIENCE | FACT; unrequire ID AUDIENCE | FACT confirm\nlead ID | TEXT; ask ID | TEXT\nedit ID | title/lead/ask | TEXT; clear ID FIELD confirm\nrender ID AUDIENCE [page] — deterministic variant and complete fact coverage\npolish ID AUDIENCE — one optional unsaved narrative; exact references/quotes required\nlist [page]; show ID [page]; export ID; delete ID confirm\nWords: 20–1000, whitespace-separated in lead/ask/fact text, excluding display labels. Required facts never silently drop. Optional selection: importance, audience-needs word overlap, then entered order. Required overflow gives an explanation, not a clipped variant. Variants are unsaved and revision-labeled; canonical facts remain retrievable.\nPrivate entered data only. Nothing sends. Polish sends selected facts/audience to the configured text model; review semantic fidelity yourself.\nEscape pipes as \\| and backslashes as \\\\; unknown escapes fail.\nLimits: 10 briefs, 20 facts and 5 audiences each; names/title 160 and text 1000 UTF-8 bytes. Content 32768/state 49152 bytes; export 24576. Use list/export/delete to free space."
} satisfies AgentFeatureMetadata;
