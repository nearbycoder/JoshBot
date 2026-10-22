import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "process-friction",
  "title": "Process friction review",
  "description": "Separate active work, waiting, and handoffs in a routine and test a cheaper process on paper.",
  "group": "Review & maintain",
  "keywords": [
    "process",
    "waiting",
    "bottleneck",
    "improvement"
  ],
  "example": "/nobo-help agent process-friction create Monthly report | 4",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Process friction review — Separate active work, waiting and handoffs; test entered assumptions on paper.\nStart: /nobo-help agent process-friction create Monthly report | 4\nstep PROCESS add Gather figures | 20 | 60 | Me | Needed for accuracy\nstep PROCESS add Review figures | 15 | 120 | Reviewer | Required approval\nanalyze PROCESS; what-if PROCESS STEP | wait | 30; scenario-preview PROCESS\nCopy the emitted save-scenario command and give the scenario a name.\nCommands after /nobo-help agent process-friction:\ncreate TITLE | OCCURRENCES_PER_MONTH\nedit PROCESS | title|repetitions | VALUE (choose one)\nclear PROCESS title confirm\nstep PROCESS add LABEL | ACTIVE_MINUTES | WAIT_MINUTES | OWNER | REQUIRED_REASON_OR_none\nstep PROCESS edit STEP | label|active|wait|ownerLabel|requiredReason | VALUE (choose one)\nstep PROCESS clear STEP label|ownerLabel|requiredReason confirm (choose one)\nstep PROCESS remove STEP confirm; move PROCESS STEP | POSITION_1_BASED\nwhat-if PROCESS STEP | active|wait|owner|remove | VALUE (choose one)\nrevise PROCESS SCENARIO STEP | active|wait|owner|remove | VALUE (choose one)\nscenario-preview PROCESS [PAGE]\nsave-scenario PROCESS TOKEN | NAME\nscenario-name PROCESS SCENARIO | NAME\nscenario-clear-name PROCESS SCENARIO confirm\nscenario-remove PROCESS SCENARIO confirm; discard PROCESS confirm\nanalyze PROCESS [PAGE]; list [PAGE]; show PROCESS [PAGE]; export PROCESS; delete PROCESS confirm\nFull returned IDs required; copy PAGE rev TOKEN continuations unchanged. Pipe escapes \\| and \\\\; outer whitespace trims. none is reserved for an absent required reason on step creation. Clear removes it explicitly.\nTimes: nonnegative minutes <=1000000 with <=3 decimals; occurrences integer1–10000. A what-if changes exactly one step assumption. For remove, VALUE is the replacement rationale (required if the step has a required reason). Scenarios do not change the baseline. Inspect the pending assumption before save; token is consumed once. revise previews a full replacement on the CURRENT baseline; save explicitly replaces that scenario. Edit any snapshot source fields in baseline then revise to replace them; scenario-remove erases all retained fields. Pending previews replace prior tokens; baseline edits/moves/removals invalidate pending and mark saved scenarios historical, even if the baseline is later changed back.\nActive+wait=sequential elapsed; monthly totals multiply occurrences. Adjacent differing nonempty owner labels count as handoffs; unknown boundaries excluded. Largest-wait ties pick first. Historical scenarios retain the changed-step snapshot and numerical comparison, not the entire old graph. No equivalent labor/cloud savings or guaranteed savings; no automation, Slack identity resolution or external actions.\n12 processes,24 steps,3 saved scenarios,1 pending preview each. Title/step/name160,owner128,reason/rationale320 UTF-8 bytes. Command16000 bytes; state/content/export49152/32768/24576 serialized bytes. Dynamic reservation covers all scenario slots/final names; bytes may bind first. Detail pages<=3500 units. At revision ceiling inspect/export/delete/recreate. Private; zero model/search/context calls. No reset/eviction. Help needs no state."
} satisfies AgentFeatureMetadata;
