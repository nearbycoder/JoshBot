import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "renewal-radar",
  "title": "Renewal review",
  "description": "See notice deadlines and normalized costs for manually entered subscriptions and memberships.",
  "group": "Organize life",
  "keywords": [
    "renewals",
    "subscriptions",
    "notice",
    "cancellation window"
  ],
  "example": "/nobo-help agent renewal-radar add Design membership | 2026-12-01 | 14 | 120.00 | USD | year | 1",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Renewal review — entered notice dates and same-currency cost equivalents.\nStart: /nobo-help agent renewal-radar add Design membership | 2026-12-01 | 14 | 120.00 | USD | year | 1\nUse the returned ID in these commands:\nadd LABEL | YYYY-MM-DD | NOTICE_DAYS | AMOUNT | CURRENCY | month/year | INTERVAL\nupcoming DAYS [PAGE [rev TOKEN]]; costs [PAGE [rev TOKEN]]\nreview ID | keep/change | REASON\nreschedule ID | YYYY-MM-DD | MANUAL_CONFIRMATION_NOTE\nedit ID | FIELD | VALUE\nclear ID FIELD confirm\nFields: title, renewalDate, noticeDays, amount, currency, billingUnit, interval, termsNote, reviewNote, confirmationNote. clear also accepts status (clears its review note). Clearing dates/numbers means unknown.\nlist [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID [confirm]; help\nReturned page commands bind the saved content. Labels/reasons <=160 UTF-8 bytes; termsNote <=1000. Currency: 1–12 uppercase ASCII letters/digits starting with a letter. Amount 0–1000000.00, <=2 decimal places; notice 0–366 civil days; billing interval 1–120; horizon 0–3660 days.\nUse \\| for literal | and \\\\ for literal backslash; no other escapes.\nPrivate local decisions only; manual terms are unverified. No models, search, external account changes, cancellation, notifications or reminders. Equivalents use integer minor units and half-up display rounding; never combine currency labels.\n40 records; new content <=32768 and complete state <=49152 UTF-8 bytes, with reserved decision/confirmation space. Export <=24576 bytes. Delete explicitly to free space."
} satisfies AgentFeatureMetadata;
