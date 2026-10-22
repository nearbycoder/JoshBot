import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "argument-map",
  "title": "Argument map",
  "description": "Make a position’s reasons, objections, rebuttals, and evidence gaps visible.",
  "group": "Decide & analyze",
  "keywords": [
    "argument",
    "reasoning",
    "objections",
    "rebuttal"
  ],
  "example": "/nobo-help agent argument-map create Use a shorter onboarding form",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Argument map: make support, evidence gaps, objections and rebuttals visible.\nStart: /nobo-help agent argument-map create Use a shorter onboarding form\nnode MAP add reason | Fewer fields reduce initial effort\nnode MAP add objection | Required information may be missing\nlink MAP REASON | supports | ROOT\nlink MAP OBJECTION | challenges | REASON\nnode MAP add TYPE | text (claim, reason, objection, rebuttal, evidence)\nnode MAP edit NODE | TYPE | text\nposition MAP | main position (root stays a claim)\nlabel MAP EVIDENCE_NODE | supplied evidence label\nlink MAP FROM | RELATION | TO\nlink-edit MAP EDGE | FROM | RELATION | TO\nRelations: supports from claim/reason/rebuttal to claim/reason/rebuttal; challenges from objection to any non-objection; rebuts from rebuttal to objection; evidences from evidence to any non-evidence. Self-links, duplicate links and directed cycles fail without saving. Cycles mean circular dependence, not proof of falsehood.\nremove MAP node|edge|label CHILD confirm (choose one kind)\nRemoving a node removes its attached edges and preserves other nodes. Remove evidence labels before changing that node to another type. Remove links incompatible with a type edit first. Delete the whole map to remove the root.\naudit MAP [page N] [rev N]: unsupported leaves and unanswered objections\nview MAP [page N] [rev N]: breadth-first adjacency, shared references expanded once, disconnected components included\nlist [page]; show MAP [page N] [rev N]; export MAP; delete MAP confirm\nUse full returned map/root/node/edge IDs. Evidence labels are user-supplied and do not establish truth. A rebuttal edge means a response was recorded, not that the objection was defeated.\nPipe fields trim outer whitespace; escape literal pipes as \\| and backslashes as \\\\. 10 maps, 32 nodes including root, 64 edges/map. Node text <=600 UTF-8 bytes; evidence labels <=200. 49152 total/32768 new-content/24576 exported-record bytes; byte quotas may fill first. Maximum revision widths are reserved; optional nodes/edges/labels are new content. Export/delete to free space. Full original fields and IDs remain in show/export. Private, on demand, deterministic: no model, search, context reads or external actions."
} satisfies AgentFeatureMetadata;
