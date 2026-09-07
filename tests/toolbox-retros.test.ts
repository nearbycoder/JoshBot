import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {retros} from "../lib/toolbox/retros.js";
test("retros organize categories, prioritize and reopen improvement cards",()=>{
 const e:Entry[]=[];execute(retros,e,"create Sprint");const id=e[0].id;
 execute(retros,e,`add ${id} | keep | Small PRs`);execute(retros,e,`add ${id} | change | Reviews`);execute(retros,e,`priority ${id} | 2 | 5`);
 assert.match(execute(retros,e,`report ${id}`),/priority 5.*Reviews/);
 assert.match(execute(retros,e,`resolve ${id} | 2`),/resolved; priority 5/);
 assert.match(execute(retros,e,`reopen ${id} | 2`),/open; priority 5/);
 execute(retros,e,`edit ${id} | 2 | Review latency`);assert.match(execute(retros,e,"list latency"),/Sprint/);
 assert.throws(()=>execute(retros,e,`add ${id} | wrong | X`),/Category/);assert.throws(()=>execute(retros,e,`priority ${id} | 2 | 1.5`),/whole number/);
});
