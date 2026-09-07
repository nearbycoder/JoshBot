import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {businessDays,countdowns} from "../lib/toolbox/countdowns.js";
test("countdowns handle weekends, past dates, inclusive upcoming windows and archives",()=>{
 assert.equal(businessDays("2026-09-04","2026-09-07"),1);assert.equal(businessDays("2026-09-07","2026-09-14"),5);assert.equal(businessDays("2026-09-07","2026-09-04"),-1);
 const e:Entry[]=[],now=new Date("2026-09-07T23:00:00Z");execute(countdowns,e,"add Launch | 2026-09-07",now);const id=e[0].id;
 assert.match(execute(countdowns,e,"upcoming 0",now),/Today/);execute(countdowns,e,`archive ${id}`,now);assert.match(execute(countdowns,e,"upcoming 30",now),/No active/);
 execute(countdowns,e,`restore ${id}`,now);assert.match(execute(countdowns,e,`reschedule ${id} | 2026-09-04`,now),/3 calendar days ago/);
 assert.throws(()=>execute(countdowns,e,"upcoming 1.5",now),/whole number/);assert.throws(()=>execute(countdowns,e,"add Bad | 2026-02-30",now),/real date/);
});
