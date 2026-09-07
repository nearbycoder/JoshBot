import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { scorecards } from "../lib/toolbox/scorecards.js";
test("scorecards require complete input, calculate weights, surface ties and remove stale scores", () => {
  const e: Entry[] = [];
  execute(scorecards, e, "create Pick");
  const id = e[0].id;
  for (const c of ["Speed | 3", "Cost | 1"])
    execute(scorecards, e, `criterion ${id} | ${c}`);
  for (const o of ["A", "B"]) execute(scorecards, e, `option ${id} | ${o}`);
  assert.throws(() => execute(scorecards, e, `rank ${id}`), /Missing/);
  for (const o of ["A", "B"]) {
    execute(scorecards, e, `score ${id} | ${o} | Speed | 5`);
    execute(scorecards, e, `score ${id} | ${o} | Cost | 1`);
  }
  assert.match(execute(scorecards, e, `rank ${id}`), /80.0%/);
  assert.match(execute(scorecards, e, `rank ${id}`), /tied/);
  execute(scorecards, e, `score ${id} | B | Speed | 4`);
  assert.match(execute(scorecards, e, `rank ${id}`), /1. A: 80.0%/);
  execute(scorecards, e, `remove-criterion ${id} | Cost | confirm`);
  assert.match(execute(scorecards, e, `rank ${id}`), /100.0%/);
  assert.throws(
    () => execute(scorecards, e, `score ${id} | A | Speed | 6`),
    /0 to 5/,
  );
});
