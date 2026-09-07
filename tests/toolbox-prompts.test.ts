import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { prompts } from "../lib/toolbox/prompts.js";
test("prompt templates validate variables and substitute literally without execution", () => {
  const e: Entry[] = [];
  execute(
    prompts,
    e,
    "add Explain | Explain {{topic}} to {{audience}}. {{topic}}",
  );
  const id = e[0].id;
  assert.equal(execute(prompts, e, `variables ${id}`), "topic, audience");
  assert.match(
    execute(prompts, e, `render ${id} | topic=$& | audience=beginner`),
    /Explain \$& to beginner\. \$&/,
  );
  assert.throws(
    () => execute(prompts, e, `render ${id} | topic=Redis`),
    /Missing/,
  );
  assert.throws(
    () => execute(prompts, e, `render ${id} | topic=x | topic=y`),
    /once/,
  );
  assert.throws(
    () => execute(prompts, e, "add Invalid | {{Bad-name}}"),
    /variables/,
  );
  execute(prompts, e, `edit ${id} | Static text`);
  assert.match(execute(prompts, e, `render ${id}`), /Static text/);
});
