import assert from "node:assert/strict";
import test from "node:test";
import { execute, runFeature, type Entry, type Store } from "../lib/toolbox/core.js";
import { notes } from "../lib/toolbox/notes.js";
import { toolboxView } from "../src/slack-toolbox.js";
import { handleSlackSlashCommandPayload } from "../lib/slack-commands.js";
export function memoryStore(): Store {
  const map = new Map<string, string>();
  return { get: async k => map.get(k) ?? null, compareSet: async (k, old, next) => { if ((map.get(k) ?? null) !== old) return false; map.set(k, next); return true; } };
}
test("notebook supports create, edit, append, search, tags, export, confirmed delete", () => {
  const entries: Entry[] = []; execute(notes, entries, "add Ideas | Original"); const id = entries[0].id;
  execute(notes, entries, `edit ${id} | Changed`); execute(notes, entries, `append ${id} | More`); execute(notes, entries, `tag ${id} | work,Work`);
  assert.equal(entries[0].body, "Changed\nMore"); assert.deepEqual(entries[0].tags, ["work"]);
  assert.match(execute(notes, entries, "list work"), /Ideas/); assert.equal(JSON.parse(execute(notes, entries, `export ${id}`)).title, "Ideas");
  assert.throws(() => execute(notes, entries, `delete ${id}`), /confirm/); execute(notes, entries, `delete ${id} confirm`); assert.equal(entries.length, 0);
});
test("toolbox scopes data to both workspace and user, retries CAS, deduplicates mutations", async () => {
  const store = memoryStore(); const owner = { userId: "U1", teamId: "T1" };
  const first = await runFeature(notes, "add Secret | Private", owner, "request1", store);
  assert.equal(await runFeature(notes, "add Secret | Private", owner, "request1", store), first);
  assert.match(await runFeature(notes, "list", { ...owner, userId: "U2" }, undefined, store), /No entries/);
  assert.match(await runFeature(notes, "list", { ...owner, teamId: "T2" }, undefined, store), /No entries/);
  await Promise.all([runFeature(notes, "add Second | two", owner, "r2", store), runFeature(notes, "add Third | three", owner, "r3", store)]);
  assert.match(await runFeature(notes, "list", owner, undefined, store), /3 entries/);
  assert.match(await runFeature(notes, "list", {}, undefined, store), /signed Slack/);
});
test("invalid inputs do not write and modal stays within Slack limits", async () => {
  const store = memoryStore(), owner = { userId: "U1", teamId: "T1" };
  assert.match(await runFeature(notes, "add Missing", owner, "r", store), /2 nonempty/);
  assert.match(await runFeature(notes, "list", owner, undefined, store), /No entries/);
  assert.throws(() => execute(notes, [], "page 1.5"), /whole number/);
  const view = toolboxView("<@everyone>".repeat(2800));
  assert.ok(view.blocks.length < 100); assert.ok(view.blocks.every(b => !("text" in b) || typeof b.text !== "object" || b.text!.text.length <= 3000));
  assert.ok(view.private_metadata); assert.notEqual(toolboxView().private_metadata, toolboxView().private_metadata);
});
test("registered slash command routes toolbox help privately without Redis", async () => {
  const result = await handleSlackSlashCommandPayload({ command: "/nobo-help", text: "tools notes help", user_id: "U1", team_id: "T1", channel_id: "C1" });
  assert.equal(result.response.response_type, "ephemeral"); assert.equal(result.response.mrkdwn, false); assert.match(result.response.text, /Private notebook/);
});
