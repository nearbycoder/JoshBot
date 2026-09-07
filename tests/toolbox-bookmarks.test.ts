import assert from "node:assert/strict";
import test from "node:test";
import { execute, type Entry } from "../lib/toolbox/core.js";
import { bookmarks } from "../lib/toolbox/bookmarks.js";
test("bookmarks normalize Slack links, manage reading queue and retain notes", () => {
  const entries: Entry[] = []; execute(bookmarks, entries, "add Docs | <https://docs.slack.dev|Docs> | Reference"); const id = entries[0].id;
  assert.match(execute(bookmarks, entries, "queue"), /Docs/); execute(bookmarks, entries, `read ${id}`); assert.match(execute(bookmarks, entries, "queue"), /clear/);
  execute(bookmarks, entries, `unread ${id}`); execute(bookmarks, entries, `annotate ${id} | Updated`); execute(bookmarks, entries, `url ${id} | https://example.com`);
  assert.match(entries[0].body, /example.com/); assert.match(execute(bookmarks, entries, "list Updated"), /Docs/);
  assert.throws(() => execute(bookmarks, entries, "add Duplicate | https://example.com | Note"), /already saved/);
});
test("bookmarks reject unsafe URLs and incomplete input", () => {
  for (const url of ["javascript:alert(1)", "http://example.com", "https://user:pass@example.com", "invalid"]) assert.throws(() => execute(bookmarks, [], `add Bad | ${url} | Note`));
  assert.throws(() => execute(bookmarks, [], "add Missing"));
});
