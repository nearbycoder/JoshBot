import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "habit-experiments",
  "title": "Habit design experiments",
  "description": "Test a smaller version, cue, or environment change against an explicit habit baseline.",
  "help": "Compare a habit intervention with literal completion dates and explicit opportunities.\nStart: /nobo-help agent habit-experiments create Reading cue | Put the book beside the kettle\ncreate TITLE | INTERVENTION\nhabits EXPERIMENT — one fresh owned-habit read; IDs and fingerprints.\nattach EXPERIMENT | HABIT_SOURCE [| FINGERPRINT] — explicit selection. One read; optional displayed fingerprint rejects changed selection. Reattach replaces source snapshot and invalidates comparisons.\nwindows EXPERIMENT | BASELINE_START | BASELINE_END | INTERVENTION_START | INTERVENTION_END\nInclusive YYYY-MM-DD windows, 1–90 days each; baseline ends before intervention starts.\nopportunities EXPERIMENT | BASELINE | INTERVENTION — integers 0–90 or unknown; cannot exceed window days or be below known recorded counts. Never inferred from window length.\nfreeze EXPERIMENT — one habit read, freeze before snapshot; capture may be retrospective.\ncompare EXPERIMENT — one habit read; freezes before if absent, saves counts/status. Then report EXPERIMENT to see denominators and limits. Changed baseline dates are labeled stale; label/target changes or missing source invalidate comparison.\nreport EXPERIMENT [page N rev R stamp HASH]\nreset-snapshot EXPERIMENT confirm — remove before/comparison snapshots; freeze again explicitly.\nedit EXPERIMENT title/intervention | TEXT\nclear EXPERIMENT title/intervention/windows/opportunities/source confirm\nEdits clear dependent snapshots; windows changes also clear opportunities. Reissue windows/opportunities to edit all fields. Deletion never changes the habit store.\nhelp; list [page N]; show EXPERIMENT [page N rev R stamp HASH]; export EXPERIMENT; delete EXPERIMENT confirm\nUse full returned IDs and exact emitted continuations. Literal pipes/backslashes: \\| / \\\\.\nOriginal UTC habit day labels never shift to caller-local dates. Missing days array is unknown; empty is zero recorded. Unlogged days are not failures; 0 opportunities gives undefined adherence, never a division by zero. No causal claims.\nPrivate/on demand; zero model/search. 12 experiments, one selected habit each; max100 adapter habits, one read per source command. Label text≤2000 UTF-8 bytes plus ≤366 validated source dates. Title120/intervention300 bytes. State49152/content32768/export24576 bytes; selected source replacements and both observations are reserved, so bytes can limit counts first. No cache/background work. Check tools habits list for source failures; show/export then delete to free local space.\n",
  "group": "Learn & improve",
  "keywords": [
    "habit design",
    "cue",
    "experiment",
    "adherence"
  ],
  "example": "/nobo-help agent habit-experiments create Reading cue | Put the book beside the kettle",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 1,
    "storeReads": 8,
    "storeUpdates": 4
  }
} satisfies AgentFeatureMetadata;
