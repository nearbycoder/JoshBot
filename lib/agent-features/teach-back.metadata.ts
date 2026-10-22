import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "teach-back",
  "title": "Teach-back review",
  "description": "Explain supplied material in your own words, then compare your explanation with an explicit concept rubric.",
  "group": "Learn & improve",
  "keywords": [
    "explain",
    "understanding",
    "Feynman",
    "teach back"
  ],
  "example": "/nobo-help agent teach-back create Explain cache invalidation | Cached data must be refreshed when the source changes.",
  "resourceBudgets": {
    "generations": 1,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Teach-back review — compare your explanation with exact supplied concept evidence.\nStart: /nobo-help agent teach-back create Explain cache invalidation | Cached data must be refreshed when the source changes.\nCommands after /nobo-help agent teach-back (use returned full SESSION/CONCEPT IDs):\ncreate TITLE | SOURCE\nconcept SESSION add LABEL | TERM[,TERM...] | EXACT-SOURCE-SPAN\nexplain SESSION | EXPLANATION\nreview SESSION [page N] [rev R]\nself-rate SESSION CONCEPT | clear|partial|missing | NOTE\ncoach SESSION\nedit SESSION title|source|explanation | TEXT\nsource SESSION | SOURCE\nclear SESSION title|source|explanation confirm\nconcept SESSION edit CONCEPT | LABEL | TERM[,TERM...] | EXACT-SOURCE-SPAN\nconcept SESSION clear CONCEPT label|requiredTerms|sourceSpan confirm\nconcept SESSION remove CONCEPT confirm\nself-rate SESSION CONCEPT clear confirm\nhelp; list [N]; show SESSION [page N] [rev R]; export SESSION; delete SESSION [confirm]\nNext: add concepts, explain, review lexical hints and self-rate. self-rate replaces rating/note. Exact spans bind the first verbatim occurrence (zero-based JS offsets). Synonyms may be lexical gaps; coverage is never comprehension proof. Missing concepts keep their excerpts.\nSource/explanation/rubric edits mark self-ratings stale. Source edits require explicit concept rebinding; old excerpts remain labeled stale. clear source does not erase retained concept quotes: clear their sourceSpan or remove concepts to erase those too. Every accepted field can be replaced/cleared or removed with its containing record.\ncoach sends current supplied material to the configured model once for one unsaved evidence-linked opinion and <=3 questions. No automatic grades, retries, repair, saved suggestions or card changes. Complete invalid/oversized replies are rejected, never clipped. Stop cancels the invocation; edited/deleted sessions discard stale results.\nBounds: 8 sessions, 12 concepts each; source 6000 JS units/18000 UTF-8 bytes, explanation 3000/9000; label/title 120 bytes, <=8 terms of 40 bytes, span 600 units/1800 bytes, note 160 bytes. Command/model input 16000 bytes; instructions <=4000 bytes; accepted model output <=4000 units AND complete reply <=3500. These are post-generation acceptance limits, not upstream token caps.\nState 65536 bytes, content 49152, complete export 24576. Remaining maximum explanation/self-ratings are reserved; bytes may bind first. list shows quota; export then delete SESSION confirm frees space. Literal pipes: \\|; backslashes: \\\\. Private plain slash text; zero searches/context reads.\nSource/content assessment versions have an intentional finite limit of 9,007,199,254,740,991. At exhaustion, changes/removals needing a new version are refused; valid saved data and history stay unchanged. Use export ID for the complete record, then delete ID confirm only to erase that entire root and its history, or create a separate record from explicitly re-entered data. Root revision ceilings still permit removals when semantic versions have capacity."
} satisfies AgentFeatureMetadata;
