import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { releases } from "../lib/toolbox/releases.js";
test("release readiness requires nonempty gates and evidence for every pass", () => {
  const e: Entry[] = [];
  assert.match(execute(releases, e, "create v1"), /NOT READY/);
  const id = e[0].id;
  execute(releases, e, `gate ${id} | Tests | Josh`);
  execute(releases, e, `gate ${id} | Docs | Sam`);
  assert.throws(
    () => execute(releases, e, `record ${id} | 1 | pass | ok`),
    /evidence/,
  );
  execute(releases, e, `record ${id} | 1 | pass | CI run passed`);
  assert.match(execute(releases, e, `readiness ${id}`), /NOT READY/);
  execute(releases, e, `record ${id} | 2 | blocked | Guide missing`);
  assert.match(execute(releases, e, `readiness ${id}`), /NOT READY/);
  assert.match(
    execute(releases, e, `record ${id} | 2 | pass | Guide reviewed`),
    /READY according to/,
  );
  assert.match(
    execute(releases, e, `reset ${id} confirm`),
    /0\/2 gates passed/,
  );
  assert.throws(
    () => execute(releases, e, `gate ${id} | tests | Other`),
    /already exists/,
  );
});
