import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "document-critic",
  "title": "Document critic",
  "description": "Check a draft against an explicit purpose, audience, structure, and review rubric.",
  "group": "Write & communicate",
  "keywords": [
    "document",
    "review",
    "rubric",
    "writing"
  ],
  "example": "/nobo-help agent document-critic create Setup guide | New users | Help a new user install the app",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Document critic: explicit purpose, audience and rubric; rules/opinions do not establish correctness.\nStart: /nobo-help agent document-critic create Setup guide | New users | Help a new user install the app\ntext DOC | text; revise DOC | text\nrequire DOC | Install,Verify,Troubleshooting (exact Markdown headings)\nedit DOC title|audience|purpose | value (choose one field)\nrubric DOC add rule; rubric DOC edit RULE | rule\nacronym DOC add TERM | expansion; acronym DOC edit ACRONYM | TERM | expansion\nExpansion may be empty; only explicitly listed uppercase terms are checked. Recognizes expansion (TERM) or TERM (expansion).\nmark DOC RULE | startLine | endLine | exact quote | user opinion (replaces that rule's finding)\nremove DOC rubric|acronym|mark CHILD confirm (mark uses RULE ID)\nclear DOC text|headings confirm\ncheck DOC [page N] [rev N]; lines DOC [page N] [rev N]\ncritique DOC: one optional model call sends supplied text/brief/rubric; returns at most 8 unsaved opinions. Review and add manually with mark. No search or context reads. No retries.\nlist [page]; show DOC [page N] [rev N]; export DOC; delete DOC confirm\nUse full returned IDs from show. Text/brief/headings edits invalidate findings. Numbered lines are 1-based; columns are UTF-16 units. Paragraphs are separated by blank lines; >120 whitespace-delimited words is a review hint.\nPipe fields trim outer whitespace; escape literal pipes as \\| and backslashes as \\\\. Source <=6000 units; 6 documents, 12 headings/rubric rules/findings, 20 acronym entries. 65536 state bytes/49152 new-content bytes; export <=24576 bytes. Byte quotas can fill first; export/delete to free space. show/export recover all accepted content. Private, on demand; no external actions."
} satisfies AgentFeatureMetadata;
