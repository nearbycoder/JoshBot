import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "source-compare",
  "title": "Source comparison",
  "description": "Compare supplied accounts point by point and keep agreement, disagreement, and missing coverage separate.",
  "group": "Capture & recall",
  "keywords": [
    "compare sources",
    "contradiction",
    "synthesis",
    "evidence"
  ],
  "example": "/nobo-help agent source-compare create Two onboarding studies",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Source comparison — align exact supplied excerpts and keep missing coverage unknown.\nStart: /nobo-help agent source-compare create Two onboarding studies\nReplace COMPARISON/SOURCE/TOPIC/CELL with full returned IDs. Commands follow /nobo-help agent source-compare:\ncreate TITLE\nedit COMPARISON | TITLE\nsource COMPARISON add LABEL | PASTED_TEXT\nsource COMPARISON edit SOURCE | LABEL | PASTED_TEXT\ntopic COMPARISON add TITLE\ntopic COMPARISON edit TOPIC | TITLE\nquote COMPARISON TOPIC | SOURCE | EXACT_EXCERPT\nquote-edit COMPARISON CELL | TOPIC | SOURCE | EXACT_EXCERPT\nlabel COMPARISON TOPIC | unknown|agreement|disagreement\nremove COMPARISON source|topic|quote|label CHILD_ID confirm\ncompare COMPARISON [page N rev R]\nsynthesize COMPARISON\nlist [page N]\nshow COMPARISON [page N rev R]\nexport COMPARISON\ndelete COMPARISON [confirm]\nhelp\nChoose one label token. Labels require two nonempty current source cells except unknown. Source/topic edits clear dependent quotes and reset affected labels to unknown; source/topic removals also clear those selections. Quote edits/removals reset labels. No retained stale history. Use quote-edit to replace an existing cell. Label removal uses TOPIC; quote removal uses CELL. Literal pipe: \\|; backslash: \\\\. Surrounding whitespace is trimmed.\nDrafts may have 0–1 sources; useful comparison needs 2–5. Sources are at most 3000 characters/12000 UTF-8 bytes each; exact quote cells 600 characters/2400 bytes. Source labels/titles 160 bytes; topic titles 200. Missing cells stay unknown; lexical difference is not contradiction. Duplicate NFKC/case/whitespace-normalized quotes are not independent corroboration. User labels never become factual findings.\nOptional synthesize sends only selected cells/topics to the configured text model once. It selects/orders a constrained evidence digest, labeled unsaved interpretation; all displayed evidence is exact current supplied text. No invented factual prose. Input<=16000 bytes/instructions<=4000; accepted output<=4000 characters, complete reply<=3500 or rejected. These are post-generation limits, not an upstream billing cap. Largest permitted exact digests are preflighted before a call; oversized evidence refuses. Content stamps/revisions reject stale output. No automatic retry/save or generated continuation pages.\nPrivate/on demand; no context/search/URL fetch or external actions. Six comparisons, five sources/eight topics each; 65536 state bytes, 49152 content admission, 24576 complete export. Worst-case label/revision growth is reserved. Copy revision-bound pages; changed records restart page 1. Export/delete explicitly; no expiry/eviction."
} satisfies AgentFeatureMetadata;
