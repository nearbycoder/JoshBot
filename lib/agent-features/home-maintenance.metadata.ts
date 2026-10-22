import type { AgentFeatureMetadata } from "./types.js";
export default {
  "id": "home-maintenance",
  "title": "Home maintenance planner",
  "description": "Track service intervals and meter-based upkeep from your own manuals and service records.",
  "group": "Organize life",
  "keywords": [
    "maintenance",
    "home",
    "service interval",
    "upkeep"
  ],
  "example": "/nobo-help agent home-maintenance add Air filter | Appliance manual | 90 | none",
  "resourceBudgets": {
    "generations": 0,
    "searches": 0,
    "contextReads": 0,
    "storeReads": 8,
    "storeUpdates": 4
  },
  "help": "Home maintenance planner — dates and usage from supplied manuals; no maintenance advice inferred.\nStart: /nobo-help agent home-maintenance add Air filter | Appliance manual | 90 | none\nadd LABEL | MANUAL | DAYS/none | USAGE_INTERVAL/none\nservice ID | YYYY-MM-DD | METER/none | NOTE\nmeter ID | VALUE\ncorrect ID | VALUE | REASON\nhistory ID [PAGE [rev TOKEN]]\nhistory ID edit SERVICE | YYYY-MM-DD | METER/none | NOTE | CORRECTION_REASON\nhistory ID remove SERVICE confirm\nhistory ID clear SERVICE meter/note/correctionReason confirm\nedit ID | title/manual/intervalDays/intervalUsage | VALUE\nclear ID FIELD confirm (also latestMeter/latestReason)\ndue YYYY-MM-DD [PAGE [rev TOKEN]]\nlist [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID [confirm]; help\nUse full returned IDs. Every service date is actual past/today in caller timezone. History edit explicitly corrects a service; last baseline is the latest retained civil date, then entered order for ties. Latest meter stays independently entered. No hidden history.\nEither supplied threshold can make an asset due; missing required baselines/readings remain unknown. Normal readings/service meters are monotonic; decreases need explicit correction reasons. Clear a service meter/note or remove its entire dated row with confirmation.\nLabels <=160, manual <=1000, notes/reasons <=160 UTF-8 bytes. Days 1–3650; readings 0–1000000000 with <=3 decimals; usage interval positive in the same supplied meter units.\nEscape literal pipes as \\| and backslashes as \\\\; no other escapes.\n30 assets, 10 services each; byte/reservation limits may be reached first. New content <=32768, state <=49152, export <=24576 UTF-8 bytes. All remaining service slots and latest-reading growth are reserved at admission. Optional history corrections require new-content space. Delete explicitly to free space.\nPrivate/on demand. No model/search/context, notifications, bookings, jobs or external actions."
} satisfies AgentFeatureMetadata;
