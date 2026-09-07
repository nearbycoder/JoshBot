import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {glossary} from "../lib/toolbox/glossary.js";
test("glossary resolves case-insensitive aliases, blocks collisions and separates quiz answers",()=>{
 const e:Entry[]=[];execute(glossary,e,"define ADR | Architecture decision record");const id=e[0].id;execute(glossary,e,`alias ${id} | Decision record`);
 assert.match(execute(glossary,e,"lookup DECISION RECORD"),/Architecture decision record/);
 assert.throws(()=>execute(glossary,e,"define adr | Duplicate"),/already belongs/);
 execute(glossary,e,"define API | Interface");assert.throws(()=>execute(glossary,e,`rename ${id} | API`),/already belongs/);
 assert.doesNotMatch(execute(glossary,e,`quiz ${id}`),/Architecture decision record/);
 execute(glossary,e,`revise ${id} | Updated meaning`);assert.match(execute(glossary,e,`answer ${id}`),/Updated meaning/);
 execute(glossary,e,`unalias ${id} | decision record`);assert.match(execute(glossary,e,"lookup decision record"),/No exact/);
});
