import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {goals} from "../lib/toolbox/goals.js";
test("goals record absolute progress, correct totals, revise targets and show due status",()=>{
 const e:Entry[]=[],now=new Date("2026-09-07T12:00:00Z");execute(goals,e,"create Read | 10 | books | 2026-09-17",now);const id=e[0].id;
 assert.match(execute(goals,e,`progress ${id} | 5 | Halfway`,now),/50.0%/);
 execute(goals,e,`progress ${id} | 4 | Correction`,now);assert.equal(e[0].data.current,4);
 assert.match(execute(goals,e,`target ${id} | 4`,now),/Goal reached/);
 execute(goals,e,`target ${id} | 8`,now);assert.match(execute(goals,e,`due ${id} | 2026-09-01`,now),/Overdue/);
 assert.throws(()=>execute(goals,e,`target ${id} | 0`,now),/0.001/);
 for(let i=0;i<25;i++)execute(goals,e,`progress ${id} | 4 | Check ${i}`,now);assert.equal((e[0].data.history as unknown[]).length,20);
});
