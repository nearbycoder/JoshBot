import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "reading-path",
  "title": "Reading paths",
  "description": "Order a small reading collection by prerequisite concepts and available reading time.",
  "group": "Capture & recall",
  "keywords": [
    "reading order",
    "prerequisites",
    "reading budget",
    "study route"
  ],
  "example": "/nobo-help agent reading-path create Learn queue basics",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 1,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Reading paths — fit whole readings and their prerequisites into an explicit time budget.\nStart: /nobo-help agent reading-path create Learn queue basics\nReplace PATH/ITEM/EDGE/ATTACHMENT with returned full IDs. Commands follow /nobo-help agent reading-path:\ncreate GOAL\nedit PATH | GOAL\nitem PATH add TITLE | MINUTES | SOURCE_LABEL\nitem PATH edit ITEM | TITLE | MINUTES | SOURCE_LABEL\nrequires PATH DEPENDENT | PREREQUISITE\nrequires-edit PATH EDGE | DEPENDENT | PREREQUISITE\nroute PATH | MINUTES [page N rev R]\nread PATH ITEM\nunread PATH ITEM confirm\nbookmarks PATH [QUERY or --source SOURCE_ID] [page N rev R fingerprint F]\nattach PATH ITEM | SOURCE_ID | SOURCE_FINGERPRINT | PATH_REVISION\nattach-edit PATH ATTACHMENT | ITEM | SOURCE_ID | SOURCE_FINGERPRINT | PATH_REVISION\nremove PATH item|edge|attachment CHILD_ID confirm\nlist [page N]\nshow PATH [page N rev R]\nexport PATH\ndelete PATH [confirm]\nhelp\nLiteral pipe: \\|; backslash: \\\\. Surrounding whitespace is trimmed. Goal/title 160 UTF-8 bytes, source label 200. Reading minutes are whole 1–1440; route budget 1–10080. Stable topological/insertion order, greedy whole-reading allocation; shared prerequisite closure counted once. Cycles/missing dependencies reject atomically. Oversized readings are deferred, never truncated. Reading is a user report, not mastery; bookmark read flags do not imply reading completion here.\nCompletion policy: changed item title/source, prerequisite edits/removals, bookmark attach/replacement/removal, or unread clears that item's and downstream completion reports. Minutes-only edits retain reading reports. Item removal also removes incident edges and its bookmark snapshot. Changed goal does not imply learning achievement.\nOnly bookmarks and attach/attach-edit read owned bookmark metadata once, up to 100 adapter items. Explicit selection fresh-checks the fingerprint/path revision. At most 10 complete snapshots/10000 text bytes, one per reading; oversized sources reject without clipping. Exact credential-free HTTP(S) URLs remain inert text; no article fetch, model, search, arbitrary workspace/channel/artifact or read-later import. show/route/export retain historical provenance; bookmarks reports stale/absent/current-within-coverage status.\nCopy emitted continuation commands: saved reports bind revision; bookmark pages also bind source snapshot. Changes require page 1. All fields/full URLs are retrievable through show/export. Private/on demand; 10 paths, 24 readings/48 edges each. 49152 state bytes, 32768 content admission, 24576 complete export; worst-case completion timestamps/revisions reserved. Bytes may limit counts first. Explicit export/delete; no expiry/eviction."
} satisfies AgentFeatureMetadata;
