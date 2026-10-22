import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "claim-check",
  "title": "Draft claim check",
  "description": "Map factual claims in a draft to supplied evidence and expose unsupported or mismatched claims.",
  "group": "Write & communicate",
  "keywords": [
    "claims",
    "evidence",
    "citations",
    "fact check"
  ],
  "example": "/nobo-help agent claim-check create Pilot announcement | Ten users completed onboarding in two minutes.",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Draft claim check: supplied excerpt coverage, not factual certification.\nStart: /nobo-help agent claim-check create Pilot announcement | Ten users completed onboarding in two minutes.\nclaim DOC add exact current span\nclaim DOC add-at OFFSET | exact span (for repeated text)\nclaim DOC edit CLAIM | exact span; claim DOC edit-at CLAIM | OFFSET | exact span\nOffsets are zero-based UTF-16, end exclusive. Claim edits re-anchor and clear their mappings; draft revisions retain old claims visibly STALE.\nevidence DOC add label | exact excerpt\nevidence DOC edit EVIDENCE | label | exact excerpt\ndate DOC EVIDENCE | YYYY-MM-DD (set/change supplied evidence date)\nmap DOC CLAIM | EVIDENCE | support|contradict|unclear (choose one label; replaces that pair)\nunmap DOC CLAIM EVIDENCE confirm\nremove DOC claim|evidence|date CHILD confirm (choose one kind)\nrevise DOC | text; title DOC | title\nEvidence edits/date changes mark prior mappings stale; explicitly map again. Removing claims/evidence removes attached mappings.\naudit DOC [page N] [rev N]; show DOC [page N] [rev N]\nsuggest-claims DOC: one optional call sends the draft to the model; at most 10 unsaved exact-span proposals. Manually add/map accepted ones. No automatic retries or saving.\nlist [page]; export DOC; delete DOC confirm\nUse full IDs from show. Numeric hints compare digit tokens and English number words zero–nineteen, tens, hundred/thousand/million/billion; they do not perform arithmetic or verify sources. Dates are supplied labels, unknown unless entered; URLs are not fetched.\nPipe fields trim outer whitespace; escape literal pipes as \\| and backslashes as \\\\. 6 drafts; 6000 units of source, 12 claims and 12 excerpts of 600 units each. Up to 144 distinct claim/evidence pairs, subject to bytes. First mapping per claim and date/revision growth are reserved; extra mappings are optional new content. 65536 state/49152 content/24576 export UTF-8 bytes; quota may fill first. Export/delete to free space. All retained source/claim/evidence/mapping data is retrievable. No searches, context reads or external actions."
} satisfies AgentFeatureMetadata;
