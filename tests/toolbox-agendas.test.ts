import assert from "node:assert/strict";import test from "node:test";import {execute,type Entry} from "../lib/toolbox/core.js";import {agendas} from "../lib/toolbox/agendas.js";
test("agendas timebox topics, preserve stable numbers on reorder and expose overruns",()=>{
 const e:Entry[]=[];execute(agendas,e,"create Planning | 30");const id=e[0].id;
 execute(agendas,e,`topic ${id} | Scope | Josh | 20 | Decide`);assert.match(execute(agendas,e,`topic ${id} | Risk | Sam | 20 | Mitigate`),/OVER BUDGET by 10/);
 execute(agendas,e,`move ${id} | 2 | 1`);assert.match(execute(agendas,e,`timeline ${id}`),/0–20 min · #2 Risk/);
 execute(agendas,e,`minutes ${id} | 2 | 10`);assert.match(execute(agendas,e,`timeline ${id}`),/30\/30 minutes/);
 assert.throws(()=>execute(agendas,e,`move ${id} | 2 | 1.5`),/whole number/);
 execute(agendas,e,`remove ${id} | 1 | confirm`);assert.match(execute(agendas,e,`timeline ${id}`),/10\/30 minutes/);
});
