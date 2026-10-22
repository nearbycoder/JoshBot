import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "mistake-patterns",
  "title": "Mistake pattern review",
  "description": "Group repeated errors by your labels and track whether a prevention rule actually helped.",
  "group": "Learn & improve",
  "keywords": [
    "mistakes",
    "error patterns",
    "prevention",
    "reflection"
  ],
  "example": "/nobo-help agent mistake-patterns record 2026-10-22 | Review | Missed an edge case | testing",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Mistake pattern review — compare dated errors with user-reported opportunities.\nStart: /nobo-help agent mistake-patterns record 2026-10-22 | Review | Missed an edge case | testing\nCommands after /nobo-help agent mistake-patterns (use returned full IDs):\nrecord YYYY-MM-DD | SITUATION | OBSERVABLE-ERROR | CATEGORY\nrule add RULE-TEXT | CATEGORY | START-YYYY-MM-DD\nopportunity RULE | YYYY-MM-DD | success|failure | EVIDENCE\npatterns [CATEGORY] [page N] [snapshot HASH]\npatterns [page N] [snapshot HASH] | CATEGORY (literal label)\nreview RULE [page N] [rev R] [snapshot HASH]\nlink CASE | RULE\nunlink CASE confirm\nedit CASE date|situation|observableError|category | VALUE\nedit RULE text|category|startDate | VALUE\nclear CASE date|situation|observableError|category confirm\nclear RULE text|category|startDate confirm\nopportunity RULE edit OPPORTUNITY | YYYY-MM-DD | success|failure | EVIDENCE\nopportunity RULE remove OPPORTUNITY confirm\nhelp; list [N] [snapshot HASH]; show ID [page N] [rev R]; export ID; delete ID [confirm]\nNext: add a rule, report actual opportunities, review. Dates are civil labels without timezone conversion. AFTER includes the start day; BEFORE excludes it. No opportunity reports means denominator unknown, never zero improvement. Failure fractions describe reported opportunities only; incident logs are not exposure samples. Overlapping rules cannot establish causality; categories imply no diagnosis.\nRule edits stale opportunity assessments. Editing an opportunity explicitly reasserts it against the current rule. Unlink cases before changing a linked category. Rule deletion removes owned opportunities and unlinks retained cases. show/export retain stale evidence. Every field is editable or clearable; remove an opportunity to erase its required date/outcome/evidence together.\nLiteral pipes: \\|; backslashes: \\\\. Plain slash text. 60 cases, 12 rules, 60 opportunities total (including reserved first follow-ups); 49152 state bytes, 32768 content, 24576 complete export. Each new rule reserves one maximum follow-up; additional opportunities are new content. Situation 180, error 300, category 80, rule 240, evidence 160 UTF-8 bytes. list shows usage; export then delete ID confirm frees space.\nPrivate, on demand; zero model/search/context calls. No causal claims or external actions."
} satisfies AgentFeatureMetadata;
