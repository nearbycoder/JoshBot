import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {timelog} from "../lib/toolbox/timelog.js";
test("time tracking enforces a single timer and totals clipped date spans",()=>{
 const e:Entry[]=[],now=new Date("2026-09-08T12:00:00Z");execute(timelog,e,"start NoBo | Review",new Date("2026-09-08T10:00:00Z"));
 assert.throws(()=>execute(timelog,e,"start Other | Task",now),/Stop/);assert.match(execute(timelog,e,"stop",now),/120.0 minutes/);
 execute(timelog,e,"log NoBo | 2026-09-07T23:00:00Z | 2026-09-08T01:00:00Z | Late work",now);
 assert.match(execute(timelog,e,"report 2026-09-07 | 2026-09-07",now),/Total: 1.00 h/);
 assert.match(execute(timelog,e,"report 2026-09-08 | 2026-09-08",now),/Total: 3.00 h/);
 assert.throws(()=>execute(timelog,e,"log NoBo | 2026-09-08T10:30:00Z | 2026-09-08T11:00:00Z | Overlap",now),/overlaps/);
 assert.throws(()=>execute(timelog,e,"log NoBo | 2026-09-08T09:00 | 2026-09-08T10:00 | Naive",now),/offset/);
 execute(timelog,e,`adjust ${e[0].id} | 2026-09-08T10:00:00Z | 2026-09-08T11:00:00Z`,now);assert.match(execute(timelog,e,"report 2026-09-08 | 2026-09-08",now),/Total: 2.00 h/);
});
