import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { habits } from "../lib/toolbox/habits.js";
test("habits count unique days, bridge yesterday, detect gaps and allow corrections", () => {
  const e: Entry[] = [],
    now = new Date("2026-09-10T12:00:00Z");
  execute(habits, e, "create Read | 5", now);
  const id = e[0].id;
  for (const d of ["07", "08", "09", "09"])
    execute(habits, e, `check ${id} | 2026-09-${d}`, now);
  assert.match(
    execute(habits, e, `stats ${id} | 2026-09-10`, now),
    /current streak 3 days · best 3/,
  );
  assert.equal((e[0].data.days as string[]).length, 3);
  execute(habits, e, `uncheck ${id} | 2026-09-08`, now);
  assert.match(
    execute(habits, e, `stats ${id} | 2026-09-10`, now),
    /current streak 1 days · best 1/,
  );
  assert.throws(
    () => execute(habits, e, `check ${id} | 2026-09-11`, now),
    /future/,
  );
  assert.throws(
    () => execute(habits, [], "create Read | 2.5", now),
    /whole number/,
  );
});
