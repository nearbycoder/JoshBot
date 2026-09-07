import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {workload} from "../lib/toolbox/workload.js";
test("workload plans enforce capacity, prioritize overdue work and retain deferred tasks",()=>{
 const e:Entry[]=[],now=new Date("2026-09-07T12:00:00Z");execute(workload,e,"create Week | 2026-09-07 | 5",now);const id=e[0].id;
 execute(workload,e,`task ${id} | Large | 8 | 5 | 2026-09-09`,now);execute(workload,e,`task ${id} | Small | 3 | 4 | 2026-09-09`,now);execute(workload,e,`task ${id} | Urgent | 2 | 1 | 2026-09-06`,now);
 const result=execute(workload,e,`plan ${id}`,now);assert.match(result,/planned 5.00 h/);assert.match(result,/PLAN\n#3 Urgent/);assert.match(result,/DEFERRED\n#1 Large/);
 execute(workload,e,`done ${id} | 2`,now);assert.match(execute(workload,e,`plan ${id}`,now),/completed 3 h · planned 2.00 h/);
 execute(workload,e,`undo ${id} | 2`,now);execute(workload,e,`effort ${id} | 1 | 1`,now);assert.match(execute(workload,e,`plan ${id}`,now),/planned 3.00 h/);
 execute(workload,e,`done ${id} | 2`,now);assert.match(execute(workload,e,`capacity ${id} | 1`,now),/planned 0.00 h.*OVER CAPACITY/);
 assert.throws(()=>execute(workload,[],"create Bad | 2026-09-08 | 5",now),/Monday/);
 assert.throws(()=>execute(workload,e,`priority ${id} | 1 | 1.5`,now),/whole number/);
});
