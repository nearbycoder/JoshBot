import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@slack/bolt";
import type { ModalView } from "@slack/web-api";
import { agentFeatures, formatAgentFeatureHelp } from "../lib/agent-features/registry.js";
import { agentCatalogGroups, getAgentCatalogPage } from "../lib/agent-features/catalog.js";
import { clearRecentOpsErrorsForTesting, getRecentOpsErrors } from "../lib/ops-errors.js";
import { registerSlackHomeActions } from "../src/slack-home-actions.js";
import { agentHelpSections, buildSlackAgentCatalogView, parseAgentCatalogViewState } from "../src/slack-agent-catalog.js";

type Handler = (input: any) => Promise<void>;
function harness() {
  const actions: { pattern: RegExp | string; handle: Handler }[] = [], submissions: typeof actions = [];
  const calls: string[] = [], updates: any[] = [], opens: any[] = [], accessInputs: any[] = [], acknowledgements: any[] = [];
  let allowed = true, accessError = false, updateError = "", openError = "", revision = 0, accessWait: Promise<void> | undefined;
  let view: any;
  const signed = { user: { id: "UCATALOG" }, team: { id: "TCATALOG" }, trigger_id: "fresh-trigger" };
  const client = {
    views: {
      open: async (input: any) => { calls.push("open"); opens.push(input); if (openError) throw { data: { error: openError }, body: "PrivateBody" }; view = { ...input.view, id: "VCATALOG", hash: `h${++revision}` }; return { view }; },
      update: async (input: any) => { calls.push("update"); updates.push(input); assert.equal(input.hash, view.hash); if (updateError) throw { data: { error: updateError }, body: "PrivateBody" }; view = { ...input.view, id: view.id, hash: `h${++revision}` }; return { view }; },
      push: async () => { assert.fail("catalog grew a modal stack"); },
    },
    chat: new Proxy({}, { get: () => () => assert.fail("catalog posted to Slack") }),
  };
  const bolt = { action: (pattern: RegExp | string, handle: Handler) => actions.push({ pattern, handle }), view: (pattern: RegExp | string, handle: Handler) => submissions.push({ pattern, handle }) };
  registerSlackHomeActions(bolt as unknown as App, {
    access: (async (input: any) => { calls.push("access"); accessInputs.push(input); await accessWait; if (accessError) throw new Error("PrivateBody: failed policy"); return { allowed }; }) as any,
    publish: (async () => { assert.fail("catalog republished Home"); }) as any,
    details: async () => { assert.fail("catalog read dashboard details"); },
  });
  const match = (patterns: typeof actions, id: string) => {
    const found = patterns.filter(({ pattern }) => typeof pattern === "string" ? pattern === id : pattern.test(id));
    assert.equal(found.length, 1, `${id} must have exactly one registered handler`);
    return found[0].handle;
  };
  async function action(action: any, overrides: any = {}) {
    let acks = 0;
    const body = { ...signed, ...(view ? { view } : {}), ...overrides };
    await match(actions, action.action_id)({ action, body, client, ack: async () => { acks++; calls.push("ack"); } });
    assert.equal(acks, 1);
  }
  async function submit(query: unknown, overrides: any = {}) {
    let acks = 0;
    const inputView = { ...view, state: { values: { agent_catalog_query: { query: { value: query } } } }, ...overrides };
    await match(submissions, "nobo_agent_catalog_submit")({ body: signed, view: inputView, client, ack: async (value: any) => {
      acks++; calls.push("ack"); acknowledgements.push(value);
      if (value?.response_action === "update") view = { ...value.view, id: inputView.id, hash: `h${++revision}` };
    } });
    assert.equal(acks, 1); return acknowledgements.at(-1);
  }
  return { calls, updates, opens, accessInputs, acknowledgements, action, submit,
    open: () => action({ action_id: "nobo_home_tools", selected_option: { value: "agents" } }),
    get view() { return view; }, set view(value) { view = value; },
    set allowed(value: boolean) { allowed = value; }, set accessError(value: boolean) { accessError = value; },
    set accessWait(value: Promise<void> | undefined) { accessWait = value; },
    set updateError(value: string) { updateError = value; }, set openError(value: string) { openError = value; },
  };
}
const state = (view: ModalView) => JSON.parse(view.private_metadata!);
const helpRows = (view: any): any[] => view.blocks.filter((block: any) => block.accessory?.action_id === "nobo_agent_catalog_help");
function checkBounds(view: any) {
  assert.ok(view.blocks.length <= 20, String(view.blocks.length));
  assert.ok(helpRows(view).length <= 10);
  for (const block of view.blocks) if (block.type === "section") {
    assert.equal(block.text.type, "plain_text", "literal mentions and copied commands remain inert");
    assert.ok(block.text.text.length <= 2_500);
    assert.ok(block.text.text.isWellFormed());
  }
  if (view.private_metadata) assert.ok(view.private_metadata.length <= 800);
}

test("real Home registration opens once, then group/page/search/help/back update private metadata only", async t => {
  for (const entry of agentFeatures) t.mock.method(entry, "execute", async () => { assert.fail("browsing executed an agent"); });
  const h = harness();
  await h.open();
  assert.deepEqual(h.calls, ["ack", "access", "open"]);
  assert.equal(h.opens[0].trigger_id, "fresh-trigger");
  assert.deepEqual(helpRows(h.view).map(row => row.accessory.value), getAgentCatalogPage(agentFeatures).entries.map(entry => entry.id));
  const select = h.view.blocks.find((block: any) => block.block_id === "agent_catalog_group").elements[0];
  assert.deepEqual(select.options.map((option: any) => option.value), ["all", ...agentCatalogGroups.map(group => group.slug)]);
  assert.equal(h.view.blocks.find((block: any) => block.type === "input").dispatch_action, undefined);
  assert.equal(h.view.submit.text, "Search"); checkBounds(h.view);
  await h.action({ action_id: "nobo_agent_catalog_group", selected_option: { value: "capture" } });
  assert.deepEqual(state(h.view), { group: "capture", page: 1 });
  await h.action({ action_id: "nobo_agent_catalog_page", value: "2" });
  assert.deepEqual(state(h.view), { group: "capture", page: 2 });
  const pageTwo = helpRows(h.view).map(row => row.accessory.value);
  await h.action({ action_id: "nobo_agent_catalog_help", value: pageTwo[0] });
  assert.ok(JSON.stringify(h.view).includes(`/nobo-help agent ${pageTwo[0]} help`));
  assert.ok(h.view.blocks.some((block: any) => block.text?.text.includes(agentFeatures.find(entry => entry.id === pageTwo[0])!.example)));
  await h.action({ action_id: "nobo_agent_catalog_back", value: "back" });
  assert.deepEqual(state(h.view), { group: "capture", page: 2 });
  assert.deepEqual(helpRows(h.view).map(row => row.accessory.value), pageTwo);
  const ack = await h.submit("  private  ");
  assert.equal(ack.response_action, "update");
  assert.deepEqual(state(h.view), { group: "capture", query: "private", page: 1 });
  const firstMatch = helpRows(h.view)[0].accessory.value;
  await h.action({ action_id: "nobo_agent_catalog_help", value: firstMatch });
  assert.deepEqual(state(h.view), { group: "capture", query: "private", page: 1, featureId: firstMatch });
  await h.action({ action_id: "nobo_agent_catalog_back", value: "back" });
  assert.deepEqual(state(h.view), { group: "capture", query: "private", page: 1 });
  await h.submit(""); assert.deepEqual(state(h.view), { group: "capture", page: 1 });
  assert.equal(h.opens.length, 1);
  assert.equal(h.accessInputs.length, 9);
  for (const input of h.accessInputs) assert.deepEqual(input, { teamId: "TCATALOG", userId: "UCATALOG", action: "home_tools", surface: "slack-home" });
  for (const update of h.updates) { assert.ok(update.hash); checkBounds(update.view); }
});

test("all rendered pages/groups and every real help stay bounded and preserve full help losslessly", () => {
  for (const group of [undefined, ...agentCatalogGroups.map(group => group.slug)]) {
    const page = getAgentCatalogPage(agentFeatures, { group, page: 1 });
    for (let n = 1; n <= page.pages; n++) checkBounds(buildSlackAgentCatalogView({ group, page: n }));
  }
  for (const entry of agentFeatures) {
    const help = formatAgentFeatureHelp(entry);
    const view = buildSlackAgentCatalogView({ page: 1, featureId: entry.id }); checkBounds(view);
    assert.equal(agentHelpSections(help).join(""), help);
    const sections = view.blocks.slice(1, -2) as { text: { text: string } }[];
    assert.equal(sections.map(block => block.text.text).join(""), help);
  }
  const long = "Header\n" + "漢🦊 line\n".repeat(900) + "\n/nobo-help agent meeting-prep help";
  assert.equal(agentHelpSections(long).join(""), long);
  assert.ok(agentHelpSections(long).every(part => part.length <= 2_500 && part.isWellFormed()));
});

test("invalid action values or metadata safely reset without executing or trusting identity", async () => {
  for (const raw of ["garbage", "[]", "null", "x".repeat(801), JSON.stringify({ page: 0 }), JSON.stringify({ page: 1, query: "x".repeat(101) }), JSON.stringify({ page: 1, group: "bogus" }), JSON.stringify({ page: 1, featureId: "does-not-exist" }), JSON.stringify({ page: 1, owner: "UOTHER", channel: "COTHER" })]) {
    assert.ok(parseAgentCatalogViewState(raw).notice);
    const h = harness(); await h.open(); h.view.private_metadata = raw;
    await h.action({ action_id: "nobo_agent_catalog_help", value: "inbox capture BAD" });
    assert.deepEqual(state(h.view), { page: 1 }); assert.ok(helpRows(h.view).length > 0);
    assert.ok(!h.view.private_metadata.includes("UOTHER"));
  }
  const h = harness(); await h.open();
  for (const action of [
    { action_id: "nobo_agent_catalog_help", value: "inbox capture BAD" },
    { action_id: "nobo_agent_catalog_page", value: "0" },
    { action_id: "nobo_agent_catalog_page", value: "9999" },
    { action_id: "nobo_agent_catalog_group", selected_option: { value: "foreign" } },
    { action_id: "nobo_agent_catalog_unknown", value: "run" },
  ]) { await h.action(action); assert.equal(state(h.view).page, 1); assert.ok(helpRows(h.view).length > 0); checkBounds(h.view); }
});

test("explicit search validates length, preserves group and renders untrusted text literally once", async () => {
  const h = harness(); await h.open(); await h.action({ action_id: "nobo_agent_catalog_group", selected_option: { value: "capture" } });
  const special = '<@UOTHER> <!channel> <https://x.test|label> & `code` 漢🦊';
  await h.submit(special);
  assert.deepEqual(state(h.view), { group: "capture", query: special, page: 1 });
  assert.ok(h.view.blocks.some((block: any) => block.text?.text.includes(special)));
  assert.doesNotMatch(JSON.stringify(h.view), /&lt;|&amp;/);
  assert.match(JSON.stringify(h.view), /No agents match/); checkBounds(h.view);
  await h.submit("漢".repeat(100)); assert.equal(state(h.view).query.length, 100);
  for (const invalid of ["x".repeat(101), "\ud800", 123, "x\0y"]) assert.equal((await h.submit(invalid)).response_action, "errors");
  assert.equal(h.opens.length, 1);
});

test("access is checked on entry and every action and submit; signed denial removes controls", async () => {
  const h = harness(); h.allowed = false; await h.open(); assert.equal(h.opens.length, 0);
  h.allowed = true; await h.open(); h.allowed = false;
  await h.action({ action_id: "nobo_agent_catalog_help", value: "inbox" });
  assert.match(JSON.stringify(h.view), /unavailable/); assert.equal(helpRows(h.view).length, 0);
  assert.equal((await h.submit("meeting")).response_action, "update"); assert.equal(helpRows(h.view).length, 0);
  const invalid = harness();
  await invalid.action({ action_id: "nobo_home_tools", selected_option: { value: "agents" } }, { team: undefined });
  assert.equal(invalid.opens.length, 0); assert.equal(invalid.accessInputs.length, 0);
  await invalid.open();
  await invalid.action({ action_id: "nobo_agent_catalog_help", value: "inbox" }, { user: { id: "malformed:owner" } });
  assert.equal(helpRows(invalid.view).length, 0);
  clearRecentOpsErrorsForTesting();
  const failed = harness(); failed.accessError = true; await failed.open();
  assert.equal(failed.opens.length, 0); assert.doesNotMatch(JSON.stringify(getRecentOpsErrors()), /PrivateBody/);
});

test("stale hashes, closed modals and expired triggers end quietly without pushes or public fallback", async () => {
  clearRecentOpsErrorsForTesting();
  for (const code of ["hash_conflict", "invalid_hash", "view_not_found", "not_found"]) {
    const h = harness(); await h.open(); const before = h.view; h.updateError = code;
    await h.action({ action_id: "nobo_agent_catalog_page", value: "2" });
    assert.equal(h.updates.length, 1); assert.equal(h.opens.length, 1); assert.equal(h.view, before);
  }
  for (const code of ["expired_trigger_id", "invalid_trigger", "trigger_exchanged"]) { const h = harness(); h.openError = code; await h.open(); assert.equal(h.updates.length, 0); }
  assert.deepEqual(getRecentOpsErrors(), []);
  const h = harness(); await h.open(); h.view.hash = undefined;
  await h.action({ action_id: "nobo_agent_catalog_page", value: "2" }); assert.equal(h.updates.length, 0);
  const generic = harness(); await generic.open(); generic.updateError = "unknown-sensitive-body";
  await generic.action({ action_id: "nobo_agent_catalog_page", value: "2" });
  assert.match(JSON.stringify(getRecentOpsErrors()), /Reopen Home/);
  assert.doesNotMatch(JSON.stringify(getRecentOpsErrors()), /PrivateBody|unknown-sensitive-body/);
});

test("opening from an existing modal updates its supplied hash instead of pushing", async () => {
  const h = harness(); h.view = { id: "VEXISTING", hash: "old-hash", type: "modal", private_metadata: "" };
  await h.open(); assert.equal(h.opens.length, 0); assert.equal(h.updates.length, 1); assert.equal(h.updates[0].hash, "old-hash");
});

test("Home entry and buttons acknowledge before unresolved access; submission updates only after access", async () => {
  const h = harness();
  let release!: () => void;
  h.accessWait = new Promise<void>(resolve => { release = resolve; });
  const opening = h.open(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ["ack", "access"]); assert.equal(h.opens.length, 0);
  release(); await opening;
  h.calls.length = 0;
  h.accessWait = new Promise<void>(resolve => { release = resolve; });
  const paging = h.action({ action_id: "nobo_agent_catalog_page", value: "2" }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ["ack", "access"]); assert.equal(h.updates.length, 0);
  release(); await paging;
  h.calls.length = 0;
  h.accessWait = new Promise<void>(resolve => { release = resolve; });
  const searching = h.submit("meeting"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, ["access"]);
  release(); assert.equal((await searching).response_action, "update");
});
