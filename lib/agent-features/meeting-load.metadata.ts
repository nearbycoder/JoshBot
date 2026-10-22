import type { AgentFeatureMetadata } from "./types.js";

export default {
  "id": "meeting-load",
  "title": "Meeting load review",
  "description": "Measure calendar fragmentation, back-to-back pressure, and protected-time breaches in a confirmed snapshot.",
  "help": "Measure busy-time union, uninterrupted gaps and recovery pressure in your confirmed calendar import.\nStart: /nobo-help agent meeting-load create Workweek review | 2026-10-26 | 2026-10-30\ncreate TITLE | START | END — inclusive 1–14 civil days, default 09:00–17:00/focus60/recovery10.\nsettings REPORT | HH:MM-HH:MM | MIN_FOCUS | RECOVERY — same daily work window, including weekends; only end may be 24:00. Focus 1–1440/recovery 0–1440 minutes.\nrange REPORT | START | END; edit REPORT title | TEXT\nlabels REPORT | BYTES — 0–80 UTF-8 bytes per label preview; intervals are never clipped from the source set.\nanalyze REPORT — one complete confirmed-calendar read, max 100 events, saved compact snapshot. Invalid/unresolved intervals or DST work boundaries fail visibly, preserving the last report.\nreport REPORT — saved arithmetic, capture date/zone/coverage and assumptions.\nwhat-if REPORT recovery | MINUTES — recompute with saved snapshot/assumptions; zero source reads. Changed current configuration is labeled STALE until analyze.\nclear REPORT title/range/settings/snapshot/labels confirm — remove field/snapshot; labels resets 80. Reissue range/settings to restore required fields.\nhelp; list [page N]; show REPORT [page N rev R stamp HASH]; export REPORT; delete REPORT confirm\nReport and what-if pages also emit page N rev R stamp HASH; copy exactly. All IDs/times/flags/original all-day dates/source zones survive in compact export with named columns; show is lossless. Use full returned IDs. Literal pipes/backslashes: \\| / \\\\.\nBusy duration is union of clipped half-open intervals; transparent/point events consume none. Gaps qualify at MIN_FOCUS. Recovery deficits sum after each distinct clipped busy end until next busy start/work end; overlap gives zero recovery. Touching ends are explicit. All-day dates stay civil; DST uses real elapsed minutes and caller IANA zone. Empty imports remain unverified; no external-calendar completeness or booking guarantee.\n8 configurations; ≤14 days and100 source references/report; ≤8000 source-label bytes; one snapshot/config. Commands 16000/state 49152/content 32768/export 24576 bytes; snapshot 22000 bytes. Existing snapshot slots reserve full replacements, so bytes may limit reports before count 8. Normal replies≤3500 JS units. Source capacity errors: inspect calendar list, shorten labels/remove only explicitly unwanted events. No autoeviction. Zero model/search/background calls; at most one event read per analyze. Private; no calendar changes. Use show/export then confirmed deletion to free local space.\n",
  "group": "Review & maintain",
  "keywords": [
    "meetings",
    "fragmentation",
    "calendar load",
    "buffer"
  ],
  "example": "/nobo-help agent meeting-load create Workweek review | 2026-10-26 | 2026-10-30",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 1,
    "storeReads": 8,
    "storeUpdates": 4
  }
} satisfies AgentFeatureMetadata;
