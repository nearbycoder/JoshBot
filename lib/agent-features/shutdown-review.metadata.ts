import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "shutdown-review",
  "title": "Workday closure",
  "description": "Close the day by explicitly resolving loose ends and leaving a first step for tomorrow.",
  "help": "Close a civil workday by explicitly addressing loose ends and recording tomorrow's first step.\nStart: /nobo-help agent shutdown-review start 2026-10-22\nReplace DAY/LOOP/QUESTION with full returned IDs (DAY is a review ID, not a date).\nstart YYYY-MM-DD — one review per civil day.\nloop DAY add TEXT; loop DAY edit LOOP | TEXT; loop DAY remove LOOP confirm\nquestion DAY add TEXT; question DAY edit QUESTION | TEXT; question DAY remove QUESTION confirm\nUnresolved questions remain visible; closing does not claim they were answered.\ndisposition DAY LOOP | done/defer/drop/wait | DATE/none | REASON\nDefer/wait need a real next-review date on/after the review day. Done/drop use none. Reissue disposition to edit all its fields; clear-disposition DAY LOOP confirm removes it.\nfirst-step DAY | TEXT — set/replace restart cue; clear DAY first-step confirm\nedit DAY day | YYYY-MM-DD — change day, clear dispositions, reopen.\ncheck DAY — missing requirements, obligations and first step.\nclose DAY — requires every loop's disposition and a first step. This certifies only this local snapshot. All edits/removals reopen closed work; loop edits clear its disposition.\nreopen DAY — clear closure without changing work.\nhelp; list [page N]; show DAY [page N rev R stamp HASH]; check DAY [page N rev R stamp HASH]; export DAY; delete DAY confirm\nCopy emitted continuations exactly; revision and content stamp reject changed work. Literal pipes use \\| and backslashes \\\\.\nPrivate/on demand; no sources, model, search, sending, external task completion or background work. 20 reviews; 20 loops and 10 questions each; loop/first-step 300, question 240, reason 160 UTF-8 bytes. 49152 state bytes; 32768 content admission; 24576 complete export bytes. All admitted loop dispositions, dates, first step and closure bytes are reserved; count or byte limits can be reached first. Use list/show/export then confirmed removal to free space.\n",
  "group": "Review & maintain",
  "keywords": [
    "shutdown",
    "close day",
    "loose ends",
    "tomorrow"
  ],
  "example": "/nobo-help agent shutdown-review start 2026-10-22",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  }
} satisfies AgentFeatureMetadata;
