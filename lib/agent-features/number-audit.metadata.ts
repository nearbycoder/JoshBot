import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "number-audit",
  "title": "Number audit",
  "description": "Check stated totals, percentage changes, and weighted averages against explicit numeric inputs.",
  "group": "Decide & analyze",
  "keywords": [
    "arithmetic",
    "percentages",
    "reconcile",
    "numbers"
  ],
  "example": "/nobo-help agent number-audit create Launch metrics",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Number audit — Check totals, percentage changes and weighted averages against entered inputs.\nStart: /nobo-help agent number-audit create Launch metrics\nThen: check AUDIT add percent-change | 20,12 | -40 | 0.01 | percent\ncheck AUDIT add sum | 15,25,10 | 55 | 0 | minutes\nrun AUDIT; correct AUDIT CHECK | 50; run AUDIT\nCommands after /nobo-help agent number-audit:\ncreate TITLE\ncheck AUDIT add OPERATION | OPERANDS | CLAIM | TOLERANCE | UNIT\ncheck AUDIT edit CHECK | OPERATION | OPERANDS | CLAIM | TOLERANCE | UNIT\ncheck AUDIT remove CHECK confirm\ncorrect AUDIT CHECK | CLAIM\nedit AUDIT | title | TITLE; clear AUDIT title confirm\nrun AUDIT [PAGE]; list [PAGE]; show AUDIT [PAGE]; export AUDIT; delete AUDIT confirm\nCopy emitted PAGE rev TOKEN continuations unchanged. Full returned IDs required.\nOperations: sum, percent-change (exactly before,after), weighted-average. Comma-separated operands: value or value@unit; weighted operands: value:weight or value@unit:weight. Example weighted-average | 10:1,20:3 | 17.5 | 0 | points. All operand units must match; sum/average output unit must match them. Percent output unit is exactly percent; unannotated inputs share base. No conversion. Weights nonnegative with positive total; no unpaired weights.\nPlain decimals only, <=6 decimal places and absolute value <=1000000000. No exponent, negative zero, or expressions. Tolerance nonnegative. Exact rational comparisons; displayed approximations round half away from zero to 12 decimals. Tiny nonzero results retain exact fractions. Percent change = (after-before)/before ×100, using signed before even when negative; zero before is undefined.\nTitle <=160 UTF-8 bytes, unit <=40; 12 audits, 20 checks/audit, 20 operands/check. Command <=16000 bytes. State/content/export limits 49152/32768/24576 serialized bytes; bytes may bind before counts. No retained computed history. Remove a check to erase all its required inputs, or edit it explicitly. At revision ceiling export/delete/recreate; no reset. Help uses no stored data.\nPrivate entered data only. Zero model, search or context calls; no external actions. Pipe fields trim outer whitespace; escape literal pipe as \\| and backslash as \\\\. Complete details through show/export; deletion is explicit."
} satisfies AgentFeatureMetadata;
