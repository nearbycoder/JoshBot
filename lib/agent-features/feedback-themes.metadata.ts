import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "feedback-themes",
  "title": "Feedback theme review",
  "description": "Group received feedback by exact evidence and turn repeated themes into a concrete response experiment.",
  "group": "Learn & improve",
  "keywords": [
    "feedback themes",
    "development",
    "patterns",
    "review"
  ],
  "example": "/nobo-help agent feedback-themes create Quarterly feedback",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Feedback theme review — Group received feedback by exact evidence and turn repeated themes into a concrete response experiment.\nStart: /nobo-help agent feedback-themes create Quarterly feedback\nThen: quote REVIEW add SPEAKER | YYYY-MM-DD | CONTEXT | EXACT_QUOTE; theme REVIEW add LABEL; assign REVIEW QUOTE | THEME; counterexample REVIEW THEME | TEXT; experiment REVIEW THEME | RESPONSE; themes REVIEW [PAGE [rev TOKEN]].\nEdit: edit REVIEW | title | VALUE; clear REVIEW title confirm.\nquote REVIEW edit QUOTE | SPEAKER | DATE | CONTEXT | TEXT (becomes unassigned); quote REVIEW remove QUOTE confirm.\ntheme REVIEW edit THEME | LABEL; theme REVIEW remove THEME confirm (unassigns retained quotes; removes owned counterexamples/experiment).\nunassign REVIEW QUOTE confirm; counterexample-edit REVIEW THEME COUNTEREXAMPLE | TEXT; counterexample-remove REVIEW THEME COUNTEREXAMPLE confirm.\nexperiment REVIEW THEME | NEW_RESPONSE replaces it; experiment-remove REVIEW THEME confirm.\nOptional: suggest-themes REVIEW, one unsaved grouping of existing quote IDs, all IDs unique/accounted for. Create themes and assign manually. No generated labels, quotes or personality findings. No context reads.\nLimits: title/speaker/theme 160 bytes, context 500, quote/counterexample 1000, response experiment 320. Exact duplicate evidence, repeated wording and separately entered excerpts are distinguished; source labels are not verified people. All dates are civil labels.\nUse returned full IDs. Pipes separate fields; escape literal pipes as \\| and backslashes as \\\\. Private, on demand; no search or external actions.\nManage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.\nCapacity: 12 reviews; 30 feedback excerpts, 10 themes and 3 counterexamples/theme. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only."
} satisfies AgentFeatureMetadata;
