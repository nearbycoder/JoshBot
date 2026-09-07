import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { formatText, textkit } from "../lib/toolbox/textkit.js";
test("text workbench previews without mutation, applies with undo and counts graphemes", () => {
  const e: Entry[] = [];
  execute(textkit, e, "save Draft | one\ntwo\none");
  const id = e[0].id;
  assert.match(execute(textkit, e, `preview ${id} | bullets`), /- one/);
  assert.equal(e[0].body, "one\ntwo\none");
  execute(textkit, e, `apply ${id} | dedupe`);
  assert.equal(e[0].body, "one\ntwo");
  execute(textkit, e, `undo ${id}`);
  assert.equal(e[0].body, "one\ntwo\none");
  assert.throws(() => execute(textkit, e, `undo ${id}`), /No previous/);
  execute(textkit, e, `edit ${id} | 👨‍👩‍👧‍👦`);
  assert.match(execute(textkit, e, `stats ${id}`), /1 visible characters/);
  assert.equal(formatText("slug", "Café Launch!"), "cafe-launch");
  assert.equal(formatText("numbered", "- A\n2. B"), "1. A\n2. B");
  assert.throws(
    () => formatText("json", '{"id":999999999999999999999}'),
    /safe integers/,
  );
  assert.throws(() => formatText("json", "bad"), /valid JSON/);
  assert.equal(formatText("json", '{"a":1}'), '{\n  "a": 1\n}');
});
