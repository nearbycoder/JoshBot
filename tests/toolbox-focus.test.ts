import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {focus} from "../lib/toolbox/focus.js";
test("focus sessions preserve remaining time across pauses and count only completed blocks",()=>{
 const e:Entry[]=[],at=(minute:number)=>new Date(Date.UTC(2026,8,7,10,minute));execute(focus,e,"start Write | 25 | 5",at(0));const id=e[0].id;
 execute(focus,e,`pause ${id}`,at(10));assert.match(execute(focus,e,`status ${id}`,at(20)),/15 min left/);
 execute(focus,e,`resume ${id}`,at(20));assert.throws(()=>execute(focus,e,`next ${id}`,at(25)),/remaining/);
 assert.match(execute(focus,e,`next ${id}`,at(35)),/break.*5 min left · 1 completed/);
 execute(focus,e,`next ${id}`,at(40));execute(focus,e,`finish ${id}`,at(42));assert.equal(e[0].data.cycles,1);
 assert.throws(()=>execute(focus,e,`resume ${id}`,at(43)),/ended/);execute(focus,e,"start Again | 25 | 5",at(44));assert.equal(e.length,2);
});
