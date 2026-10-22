import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "interruption-audit",
  "title": "Interruption audit",
  "description": "Log disruptions briefly and see which triggers cost the most recovery time.",
  "help": "Log reported disruption and recovery time; compare categories without inferring Slack activity.\nStart: /nobo-help agent interruption-audit log 2026-10-22 | chat | Writing guide | 3 | 8 | estimated\nlog DATE | CATEGORY | TASK | DISRUPTION | RECOVERY | measured/estimated\nMinutes: whole 0–1440, or unknown. Zero is known. Date is a literal civil YYYY-MM-DD.\nreview START | END — inclusive range, saves/replaces the one range configuration and reports counts, totals and medians.\nreport RANGE_ID [page N rev R stamp HASH] — saved range with current logs/rules; continuations reject changes.\nrule CATEGORY | ADVICE — new prevention rule, no causal claim.\nedit LOG_ID | DATE | CATEGORY | TASK | DISRUPTION | RECOVERY | measured/estimated\nedit RULE_ID | CATEGORY | ADVICE\nedit RANGE_ID | START | END\nmeasure LOG_ID | DISRUPTION | RECOVERY | measured/estimated — fill/replace measurements.\nclear ID date/category/task/disruption/recovery/basis/advice confirm — remove the named field where applicable. Undated logs are excluded; removed basis is unknown.\nhelp; list [page N]; show ID [page N rev R stamp HASH]; export ID; delete ID confirm (also removes a range configuration).\nReplace IDs with full returned IDs. Escape literal pipes as \\| and backslashes as \\\\. All text is retained; export is complete JSON. List is current; detail/report continuations carry revision and content stamp.\nPrivate, on demand; no model, search, sources, sending or background jobs. 80 logs, 12 rules, one range; 49152 UTF-8 state bytes, 32768 new-content admission, 24576 export bytes. Category 80, task 240, advice 400 UTF-8 bytes. Required measurement/revision growth is reserved. Limits may be reached by bytes first; use list/show/export then confirmed deletion to free space.\n",
  "group": "Review & maintain",
  "keywords": [
    "interruptions",
    "focus",
    "switching",
    "recovery"
  ],
  "example": "/nobo-help agent interruption-audit log 2026-10-22 | chat | Writing guide | 3 | 8 | estimated",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  }
} satisfies AgentFeatureMetadata;
