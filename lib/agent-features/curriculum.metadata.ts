import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "curriculum",
  "title": "Learning curriculum",
  "description": "Build a prerequisite-aware study plan with bounded session capacity and evidence of readiness.",
  "group": "Learn & improve",
  "keywords": [
    "study plan",
    "syllabus",
    "prerequisites",
    "curriculum"
  ],
  "example": "/nobo-help agent curriculum create Learn SQL joins | 3 | 25",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Learning curriculum — allocate whole study sessions and require explicit readiness evidence.\nStart: /nobo-help agent curriculum create Learn SQL joins | 3 | 25\nCommands after /nobo-help agent curriculum (replace COURSE/UNIT with returned full IDs):\ncreate TARGET | SESSIONS-PER-WEEK | MINUTES-PER-SESSION\nunit COURSE add LABEL | ESTIMATE-SESSIONS | READINESS-TEST\nunit COURSE edit UNIT | LABEL | ESTIMATE-SESSIONS | READINESS-TEST\nunit COURSE clear UNIT label|estimateSessions|readinessTest confirm\nunit COURSE remove UNIT confirm\nrequires COURSE UNIT | PREREQUISITE-ID[,PREREQUISITE-ID...]\nrequires COURSE UNIT clear confirm\nplan COURSE [page N] [rev R]\ndemonstrate COURSE UNIT | EVIDENCE\nevidence COURSE UNIT | YYYY-MM-DD | EVIDENCE\nreopen COURSE UNIT confirm\nedit COURSE target|sessionsPerWeek|sessionMinutes | VALUE\nclear COURSE target|sessionsPerWeek|sessionMinutes confirm\nhelp; list [N]; show COURSE [page N] [rev R]; export COURSE; delete COURSE [confirm]\nNext: add units, set prerequisites, plan, then demonstrate a ready unit. requires replaces the entire prerequisite set. demonstrate/evidence replace the current user report; reopen erases it. Unit/criterion/prerequisite/target changes mark dependent demonstrations stale; retained evidence stays in show. Removing a unit removes its edges and stales dependents.\nOnly explicit current demonstrations unlock prerequisites. A 12-week allocation is conditional study preparation, not mastery or certification. Missing criteria are unknown, blocked means missing prerequisite evidence. No calendar dates are invented; evidence dates are civil labels.\nBounds: 8 courses, 24 units/60 edges each; 1–14 sessions/week, 1–180 minutes/session, 1–168 estimated sessions/unit. Target/label 120 UTF-8 bytes; readiness/evidence 240 each. State 49152 bytes, content 32768, complete export 24576. Lifecycle evidence is reserved; bytes can bind first. list reports usage; export then delete COURSE confirm frees space.\nLiteral pipes: \\|; backslashes: \\\\. Plain slash text. Private, on demand; zero model/search/context calls. Unregistered integration is owned by the parent."
} satisfies AgentFeatureMetadata;
