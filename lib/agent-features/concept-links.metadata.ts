import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "concept-links",
  "title": "Concept connections",
  "description": "Connect ideas with typed relationships and follow a short, explainable path between them.",
  "group": "Capture & recall",
  "keywords": [
    "concept map",
    "connections",
    "knowledge graph",
    "related"
  ],
  "example": "/nobo-help agent concept-links create Reliable systems",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 1,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Concept connections — explicit directed relationships and shortest explainable paths.\nStart: /nobo-help agent concept-links create Reliable systems\nReplace MAP/NODE/EDGE/ATTACHMENT with full returned IDs. Commands follow /nobo-help agent concept-links:\ncreate TITLE\nedit MAP | TITLE\nconcept MAP add TITLE | ANNOTATION\nconcept MAP edit NODE | TITLE | ANNOTATION\nconnect MAP FROM | supports|contrasts|example|depends-on | TO | LABEL\nconnect-edit MAP EDGE | FROM | TYPE | TO | LABEL\npath MAP FROM | TO [page N rev R]\nsources MAP [--kind note|memory] [QUERY or --source SOURCE_ID] [page N rev R fingerprint F]\nattach MAP NODE | note|memory | SOURCE_ID | SOURCE_FINGERPRINT | MAP_REVISION | EXACT_EXCERPT\nattach-edit MAP ATTACHMENT | NODE | KIND | SOURCE_ID | SOURCE_FINGERPRINT | MAP_REVISION | EXACT_EXCERPT\nremove MAP concept|edge|attachment CHILD_ID confirm\nlist [page N]\nshow MAP [page N rev R]\nexport MAP\ndelete MAP [confirm]\nhelp\nUse one TYPE/KIND token, not the displayed alternatives. Pipe escaping: \\|; backslash: \\\\. Fields trim surrounding whitespace. Titles 160 bytes, annotations 600, edge labels 400. Directed BFS uses insertion-order ties; cycles/shared nodes are safe. User relations are not causal proof. Removing a concept removes incident edges and attachments.\nOnly sources and attach/attach-edit read owned notes/approved memories, once per invocation. Sources gives current source fingerprints and map revision; attach rereads the selected kind and rejects stale/absent references. Use sources --source to retrieve complete adapter text; max 200 adapter items, 10 selected exact excerpts of 600 characters each/12000 text bytes. Coverage and meaningful source metadata are retained. show/path/export use historical snapshots; sources reports current/stale/absent provenance. No arbitrary workspaces/channels/artifacts, URL fetching, search or model calls.\nCopy exact revision-bound continuation commands. Changes require page 1. Every retained field is in show/export. Private/on demand; 8 maps, 40 nodes/80 edges each, 49152 state bytes, 32768 content admission, 24576 per complete export. Byte limits may bind first. Explicit export/delete; no eviction/expiry."
} satisfies AgentFeatureMetadata;
