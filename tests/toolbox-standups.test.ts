import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {standups} from "../lib/toolbox/standups.js";
test("standups assemble private drafts and carry plans without overwriting existing days",()=>{
 const e:Entry[]=[];execute(standups,e,"create 2026-09-07 | NoBo");const id=e[0].id;
 execute(standups,e,`yesterday ${id} | Shipped`);execute(standups,e,`today ${id} | Test`);execute(standups,e,`blockers ${id} | Review`);
 assert.match(execute(standups,e,`draft ${id}`),/Yesterday\nShipped\nToday\nTest\nBlockers\nReview/);
 execute(standups,e,`carry ${id} | 2026-09-08`);assert.equal(e[1].data.yesterday,"Test");assert.equal(e[1].data.blockers,"Review");assert.equal(e[1].data.today,"");
 assert.throws(()=>execute(standups,e,`carry ${id} | 2026-09-08`),/already exists/);
 assert.throws(()=>execute(standups,e,"create 2026-09-07 | NoBo"),/already exists/);
});
