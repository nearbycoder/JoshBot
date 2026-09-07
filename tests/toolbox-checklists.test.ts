import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { checklists } from "../lib/toolbox/checklists.js";
test("checklists track progress, undo, removal and confirmed reset with stable numbers", () => {
  const e: Entry[] = []; execute(checklists,e,"create Release"); const id=e[0].id;
  execute(checklists,e,`item ${id} | Test`); execute(checklists,e,`item ${id} | Deploy`);
  assert.match(execute(checklists,e,`done ${id} | 1`), /1\/2 complete/);
  assert.match(execute(checklists,e,`undo ${id} | 1`), /0\/2 complete/);
  execute(checklists,e,`remove ${id} | 1 | confirm`); assert.match(execute(checklists,e,`progress ${id}`), /2\. Deploy/);
  execute(checklists,e,`item ${id} | Verify`); assert.match(execute(checklists,e,`progress ${id}`), /3\. Verify/);
  execute(checklists,e,`done ${id} | 2`); assert.throws(()=>execute(checklists,e,`reset ${id}`), /confirm/);
  assert.match(execute(checklists,e,`reset ${id} confirm`), /0\/2 complete/);
  assert.throws(()=>execute(checklists,e,`done ${id} | 999`), /not found/);
});
