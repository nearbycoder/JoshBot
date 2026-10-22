import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  agentCatalogGroups, findAgentCatalogEntries, formatAgentCatalog, getAgentCatalogPage,
  normalizeAgentCatalogQuery, parseAgentCatalogCommand, validateAgentCatalog,
} from "../lib/agent-features/catalog.js";
import { agentFeatures, formatAgentFeatureHelp, formatAgentHelp } from "../lib/agent-features/registry.js";
import { existingAgentMetadata } from "../lib/agent-features/catalog-metadata.js";
import { handleAgentCommand } from "../lib/agent-features/index.js";
import type { AgentFeatureMetadata } from "../lib/agent-features/types.js";

const owner = { teamId: "TCATALOG", userId: "UCATALOG", requestId: "never-written" };
const noStartup = {
  createBackend: async () => { assert.fail("catalog initialized backend"); },
  preferences: async () => { assert.fail("catalog read preferences"); },
  getRunSignal: () => { assert.fail("catalog initialized runtime"); },
  timeoutSignal: () => { assert.fail("catalog created a timer"); },
  loadServices: async () => { assert.fail("catalog loaded services"); },
};
test("registry contains every completed module once with exact new catalog metadata and real help", async () => {
  validateAgentCatalog(agentFeatures);
  assert.equal(agentFeatures.length, 70);
  const completed = JSON.parse(await readFile(new URL("../docs/personal-agent-50-catalog.json", import.meta.url), "utf8")) as AgentFeatureMetadata[];
  assert.equal(existingAgentMetadata.length, 20);
  assert.equal(completed.length, 50);
  assert.deepEqual(new Set(agentFeatures.map(entry => entry.id)), new Set([...existingAgentMetadata, ...completed].map(entry => entry.id)));
  for (const entry of completed) {
    const registered = agentFeatures.find(feature => feature.id === entry.id)!;
    for (const key of ["id", "title", "description", "group", "keywords", "example"] as const) assert.deepEqual(registered[key], entry[key], `${entry.id}.${key}`);
    assert.equal(formatAgentFeatureHelp(registered), registered.help, "new help receives no legacy context claims");
  }
  for (const feature of agentFeatures) {
    const help = await handleAgentCommand(`${feature.id} help`, owner, undefined, noStartup);
    assert.equal(help, formatAgentFeatureHelp(feature));
    assert.ok(help.length <= 3_500, `${feature.id}: ${help.length}`);
    assert.ok(feature.example!.length <= 240, feature.id);
    assert.ok(feature.keywords!.length <= 6);
  }
});

test("catalog rejects duplicate IDs, reserved routes, unknown groups and incomplete navigation metadata", () => {
  const entry = agentFeatures[0];
  for (const id of ["catalog", "search", "help", "Bad-ID", "x".repeat(65)]) assert.throws(() => validateAgentCatalog([{ ...entry, id }]), /ID/);
  assert.throws(() => validateAgentCatalog([entry, entry]), /Duplicate/);
  assert.throws(() => validateAgentCatalog([{ ...entry, group: "unknown" }]), /group/);
  assert.throws(() => validateAgentCatalog([{ ...entry, example: undefined }]), /metadata/);
  assert.throws(() => validateAgentCatalog([{ ...entry, keywords: [] }]), /metadata/);
});

test("every complete catalog and group page reconstructs a stable, unique registry", async () => {
  const expected = findAgentCatalogEntries(agentFeatures, { page: 1 }).map(entry => entry.id);
  assert.equal(formatAgentHelp(), formatAgentCatalog(agentFeatures));
  const global: string[] = [], groups: string[] = [];
  for (const group of [undefined, ...agentCatalogGroups.map(group => group.slug)]) {
    const first = getAgentCatalogPage(agentFeatures, { group, page: 1 });
    const ids: string[] = [];
    for (let page = 1; page <= first.pages; page++) {
      const result = getAgentCatalogPage(agentFeatures, { group, page });
      assert.equal(result.error, undefined);
      assert.ok(result.entries.length > 0 && result.entries.length <= 10);
      assert.ok(result.text.length <= 3_500);
      assert.equal(result.start, ids.length + 1);
      ids.push(...result.entries.map(entry => entry.id));
      assert.equal(result.end, ids.length);
      const command = `catalog${group ? ` group ${group}` : ""} page ${page}`;
      assert.equal(await handleAgentCommand(command, owner, undefined, noStartup), result.text);
      if (page < first.pages) assert.ok(result.text.includes(`Next: /nobo-help agent catalog${group ? ` group ${group}` : ""} page ${page + 1}`));
      else assert.doesNotMatch(result.text, /Next:/);
    }
    assert.equal(ids.length, first.total);
    assert.equal(new Set(ids).size, ids.length);
    if (group) groups.push(...ids); else global.push(...ids);
    const bad = getAgentCatalogPage(agentFeatures, { group, page: first.pages + 1 });
    assert.ok(bad.error); assert.match(bad.text, /Restart: .*page 1/);
  }
  assert.deepEqual(global, expected);
  assert.deepEqual(groups, expected);
  const first = await handleAgentCommand("", owner, undefined, noStartup);
  assert.match(first, /1–10 of 70 · page 1\/7/);
  for (const group of agentCatalogGroups) assert.ok(first.includes(group.slug));
});

test("search is token-based, deterministic, case-insensitive and prioritizes exact ID then ID/title", () => {
  const base = agentFeatures[0];
  const make = (id: string, title: string, description = "", keywords: string[] = []) => ({ ...base, id, title, description, keywords });
  const entries = [make("meeting-z", "Meetings"), make("other-b", "Notes", "meeting"), make("meeting", "Exact"), make("other-a", "A", "", ["meeting"]), make("a-title", "Meeting practice")];
  const state = { query: "meeting", page: 1 };
  assert.deepEqual(findAgentCatalogEntries(entries, state).map(entry => entry.id), ["meeting", "a-title", "meeting-z", "other-a", "other-b"]);
  assert.deepEqual(findAgentCatalogEntries(entries.toReversed(), { ...state, query: "MEETING" }), findAgentCatalogEntries(entries, state));
  assert.equal(findAgentCatalogEntries(entries, { query: "meeting practice", page: 1 })[0].id, "a-title");
  for (const entry of agentFeatures) assert.equal(getAgentCatalogPage(agentFeatures, { query: entry.id, page: 1 }).entries[0]?.id, entry.id);
  const first = getAgentCatalogPage(agentFeatures, { query: "private", page: 1 });
  assert.ok(first.pages > 1);
  const all = Array.from({ length: first.pages }, (_, i) => getAgentCatalogPage(agentFeatures, { query: "private", page: i + 1 }));
  assert.deepEqual(all.flatMap(page => page.entries), findAgentCatalogEntries(agentFeatures, { query: "private", page: 1 }));
  assert.ok(all.slice(0, -1).every(page => page.text.includes(`search private page ${page.state.page + 1}`)));
});

test("navigation grammar accepts only terminal numeric page suffixes and never truncates queries", async () => {
  assert.deepEqual(parseAgentCatalogCommand("  SEARCH  meeting   page  2 "), { state: { query: "meeting", page: 2 } });
  for (const query of ["page", "page design", "meeting page words", "meeting page -1", "meeting page 1.5"]) assert.deepEqual(parseAgentCatalogCommand(`search ${query}`), { state: { query, page: 1 } });
  assert.equal(normalizeAgentCatalogQuery(" a  b\n c "), "a b c");
  for (const query of ["漢".repeat(100), "🦊".repeat(50)]) assert.equal(normalizeAgentCatalogQuery(query), query);
  for (const query of ["x".repeat(101), "🦊".repeat(51), "\ud800", "x\0y"]) assert.equal(normalizeAgentCatalogQuery(query), undefined);
  for (const command of ["catalog page 0", "catalog page -1", "catalog page 1.2", "catalog page 99999999999999999999", "catalog group unknown", "catalog group plan page2", "help unexpected", "search", "search page 2", "search meeting page 0", `search ${"x".repeat(101)}`, "catalog " + "x".repeat(50_000)]) {
    const result = await handleAgentCommand(command, owner, undefined, noStartup);
    assert.match(result, /Open the catalog:/, command);
    assert.ok(result.length < 3_500);
  }
  assert.match(await handleAgentCommand("search zero-matches-xyz", owner, undefined, noStartup), /No agents match/);
  assert.match(await handleAgentCommand("search meeting page 999", owner, undefined, noStartup), /Restart: \/nobo-help agent search meeting page 1/);
  const escaped = await handleAgentCommand('search <@UOTHER> & `test` 漢', owner, undefined, noStartup);
  assert.match(escaped, /&lt;@UOTHER&gt; &amp; `test` 漢/);
  assert.doesNotMatch(escaped, /<@UOTHER>|&amp;lt;/);
  for (const command of ["", "catalog", "search meeting", "inbox help"]) await assert.rejects(() => handleAgentCommand(command, { userId: "foreign:owner", teamId: "TCATALOG" }, undefined, noStartup), /signed Slack/);
});

test("packing reduces row count after escaping without losing Unicode, commands or accurate ranges", () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({ ...agentFeatures[0], id: `sample-${String(i).padStart(2, "0")}`, description: "漢🦊 <&> ".repeat(60) }));
  const first = getAgentCatalogPage(entries);
  assert.ok(first.entries.length < 10);
  const recovered = [];
  for (let page = 1; page <= first.pages; page++) {
    const result = getAgentCatalogPage(entries, { page });
    assert.ok(result.text.length <= 3_500);
    assert.ok(result.text.isWellFormed());
    assert.equal(result.start, recovered.length + 1);
    recovered.push(...result.entries);
    assert.equal(result.end, recovered.length);
    for (const entry of result.entries) assert.ok(result.text.includes(entry.id + " — "));
  }
  assert.deepEqual(recovered, entries);
});
