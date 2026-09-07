import assert from "node:assert/strict";import test from "node:test";
import {execute,type Entry} from "../lib/toolbox/core.js";import {snippets} from "../lib/toolbox/snippets.js";
test("snippets version edits, bound history and restore as a new revision",()=>{
 const e:Entry[]=[];execute(snippets,e,"add Query | sql | SELECT 1;");const id=e[0].id;
 execute(snippets,e,`edit ${id} | SELECT 2;`);assert.match(execute(snippets,e,`history ${id}`),/Revision 1/);
 execute(snippets,e,`restore ${id} | 1 | confirm`);assert.equal(e[0].body,"SELECT 1;");assert.equal(e[0].data.revision,3);
 for(let i=0;i<5;i++)execute(snippets,e,`edit ${id} | SELECT ${i};`);
 assert.equal((e[0].data.versions as unknown[]).length,5);assert.throws(()=>execute(snippets,e,`restore ${id} | 1 | confirm`),/not retained/);
 assert.match(execute(snippets,e,`copy ${id}`),/not executed/);
 assert.throws(()=>execute(snippets,[],"add Bad | <script> | alert(1)"),/language label/);
});
