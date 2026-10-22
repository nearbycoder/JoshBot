import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "change-impact",
  "title": "Change impact map",
  "description": "Trace which documents, routines, or commitments need review when one assumption or dependency changes.",
  "group": "Review & maintain",
  "keywords": [
    "impact analysis",
    "dependencies",
    "change",
    "downstream"
  ],
  "example": "/nobo-help agent change-impact create Launch dependencies",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Change impact map — Trace downstream review paths through entered dependencies.\nStart: /nobo-help agent change-impact create Launch dependencies\nitem MAP add Launch date | assumption | Me\nitem MAP add Announcement draft | document | Me\ndepends MAP ANNOUNCEMENT | DATE | Draft contains the launch date\nchange MAP DATE | Launch moved by one week\nimpact MAP CHANGE; resolve MAP CHANGE ANNOUNCEMENT | reviewed | Updated the date in my draft\nclose MAP CHANGE (records user-reported resolution; no external edit)\nCommands after /nobo-help agent change-impact:\ncreate TITLE; edit MAP | title | TEXT; clear MAP title confirm\nitem MAP add LABEL | TYPE | OWNER\nitem MAP edit ITEM | label|type|ownerLabel | VALUE (choose one)\nitem MAP clear ITEM label|ownerLabel confirm (choose one)\nitem MAP remove ITEM confirm (also incident edges and changes sourced there)\ndepends MAP DEPENDENT | PREREQUISITE | REASON\nedge-edit MAP EDGE | DEPENDENT | PREREQUISITE | REASON\nedge-remove MAP EDGE confirm\nchange MAP SOURCE_ITEM | DESCRIPTION\nchange-edit MAP CHANGE confirm | SOURCE_ITEM | DESCRIPTION\nchange-remove MAP CHANGE confirm\nimpact MAP CHANGE [PAGE]; path MAP CHANGE ITEM [PAGE]\nrefresh MAP CHANGE confirm\nresolve MAP CHANGE ITEM | reviewed|not-affected | REASON (choose one)\nresolve-remove MAP CHANGE ITEM confirm\nclose MAP CHANGE; reopen MAP CHANGE\nlist [PAGE]; show MAP [PAGE]; export MAP; delete MAP confirm\nFull returned IDs required. Copy PAGE rev TOKEN continuations unchanged. Pipe fields trim outer whitespace; use \\| and \\\\ escapes.\nTypes: assumption,document,routine,commitment,other. Owner labels are not Slack users. Direction: DEPENDENT depends-on PREREQUISITE. Cycles/self-links allowed; duplicate directed edges rejected. Reverse BFS visits each node once; shortest-path ties sort by dependent ID then edge ID. Changed source itself is excluded, even in a cycle. Every affected item needs reviewed/not-affected plus a reason before close. No downstream items means an empty queue, not a safety guarantee.\nEvery graph/item/title edit gives a new graph identity: previous queues/dispositions/status are explicitly historical, never current certification. resolve/close/reopen require current graph. refresh confirm replaces the snapshot/queue, clears old dispositions and reopens. change-edit confirm changes source/description with the same explicit clearing. Historical queues retain source snapshot/IDs/fingerprint/dispositions, not the old graph; original historical paths are unavailable after edits. Inspect current saved paths before reviewing. Disposition edit uses resolve after reopen; confirmed removal reopens. Required fields erase with their owning item/edge/change.\nPrivate entered data only; zero model/search/context calls, no document/routine actually changed. 8 maps,40 items,80 edges,5 changes/map. Title/label/edge reason160,owner/disposition reason96,description400 UTF-8 bytes. Command16000 bytes; state/content/export49152/32768/24576 serialized bytes. Reserve all affected dispositions and current-graph refresh before admission; bytes may bind first. Normal pages<=3500 units; complete detail in show/export and emitted path commands. At revision ceiling inspect/export/delete/recreate; no reset/eviction. Help needs no state."
} satisfies AgentFeatureMetadata;
