import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { timezones } from "../lib/toolbox/timezones.js";
test("timezone planner uses DST-aware exact instants and checks complete meeting windows", () => {
  const e: Entry[] = [];
  execute(timezones, e, "create Team | America/Chicago, Europe/London");
  const id = e[0].id;
  assert.match(
    execute(timezones, e, `convert ${id} | 2026-03-08T08:00:00Z`),
    /03:00/,
  );
  const result = execute(
    timezones,
    e,
    `overlap ${id} | 2026-09-07T00:00:00Z | 60 | 9 | 17`,
  );
  assert.match(result, /2026-09-07T14:00:00.000Z/);
  assert.doesNotMatch(result, /2026-09-07T16:00:00.000Z/);
  assert.match(
    execute(timezones, e, `overlap ${id} | 2026-09-05T00:00:00Z | 60 | 9 | 17`),
    /No shared/,
  );
  assert.throws(
    () => execute(timezones, e, `zone ${id} | Nowhere/Invalid`),
    /IANA/,
  );
  assert.throws(
    () => execute(timezones, e, `convert ${id} | 2026-09-07T15:00`),
    /offset/,
  );
  execute(timezones, e, `zone ${id} | Asia/Tokyo`);
  execute(timezones, e, `remove-zone ${id} | Asia/Tokyo | confirm`);
  assert.equal((e[0].data.zones as string[]).length, 2);
});
