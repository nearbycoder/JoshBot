import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "timeline-builder",
  "title": "Evidence timeline",
  "description": "Arrange dated observations into a chronology while preserving uncertain dates and conflicting accounts.",
  "group": "Capture & recall",
  "keywords": [
    "timeline",
    "chronology",
    "events",
    "sequence"
  ],
  "example": "/nobo-help agent timeline-builder create Launch history",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Evidence timeline — mixed-precision chronology with explicit source labels and disputes.\nStart: /nobo-help agent timeline-builder create Launch history\nReplace TIMELINE/ENTRY/ORDER with returned full IDs. Commands follow /nobo-help agent timeline-builder:\ncreate TITLE\nedit TIMELINE | TITLE\nentry TIMELINE add LABEL | DATE | SOURCE LABEL | EXACT EXCERPT\nentry TIMELINE edit ENTRY | LABEL | DATE | SOURCE LABEL | EXACT EXCERPT\nbefore TIMELINE ENTRY | LATER_ENTRY\nbefore-edit TIMELINE ORDER | ENTRY | LATER_ENTRY\ndispute TIMELINE ENTRY | NOTE\ndispute-edit TIMELINE ENTRY | NOTE\nremove TIMELINE entry|order|dispute CHILD_ID confirm\nview TIMELINE [page N rev R]\nlist [page N]\nshow TIMELINE [page N rev R]\nexport TIMELINE\ndelete TIMELINE [confirm]\nhelp\nDATE is YYYY-MM-DD, an ISO instant with explicit Z/offset, or unknown. Instants, civil labels and unknowns remain separate. Orders are declarations, not verified chronology; cycles reject. One replaceable dispute per entry; removing an entry also removes incident orders and its dispute.\nTitles/labels 160 UTF-8 bytes; source labels 200; excerpts 600; disputes 256. Literal pipe: \\|; literal backslash: \\\\. Field whitespace is trimmed.\nSaved/report continuations carry revisions; use the exact returned command. Changed pages restart at page 1. All saved fields are available through show/export.\nPrivate, on demand; no model, context reads, search, URL fetching or external actions. 12 timelines, 30 observations/50 orders each; 49152 state bytes, 32768 new-content bytes, 24576 per complete export. Bytes and reserved dispute capacity can limit counts first. Export/delete explicitly to free space; no expiry or eviction."
} satisfies AgentFeatureMetadata;
