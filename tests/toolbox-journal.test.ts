import assert from "node:assert/strict";import test from "node:test";
import {execute,type Entry} from "../lib/toolbox/core.js";import {journal} from "../lib/toolbox/journal.js";
test("journal replaces a day, validates dates/mood and reviews inclusive ranges",()=>{
 const e:Entry[]=[];execute(journal,e,"write 2026-09-07 | 4 | Shipped | Test first");execute(journal,e,"write 2026-09-07 | 5 | Revised | Rest");
 assert.equal(e.length,1);assert.match(execute(journal,e,"entry 2026-09-07"),/Revised/);
 execute(journal,e,"write 2026-09-08 | 3 | Read | Focus");assert.match(execute(journal,e,"review 2026-09-07 | 2026-09-08"),/Average mood 4.0/);
 assert.throws(()=>execute(journal,e,"write 2026-02-30 | 3 | Win | Lesson"),/real date/);
 assert.throws(()=>execute(journal,e,"write 2026-09-09 | 3.5 | Win | Lesson"),/whole number/);
 assert.throws(()=>execute(journal,e,"review 2026-09-08 | 2026-09-07"),/Start date/);
});
