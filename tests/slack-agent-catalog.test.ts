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
  const searchInput = () => view?.blocks.find((block: any) => block.type === "input");
  const groupInput = () => view?.blocks.find((block: any) => block.elements?.some((element: any) => element.action_id === "nobo_agent_catalog_group"));
  // Model Slack's retained form values when both block_id and action_id are reused.
  function applyView(next: any, id: string) {
    const values: Record<string, any> = {};
    for (const block of next.blocks) for (const element of block.element ? [block.element] : block.elements ?? []) {
      if (!["plain_text_input", "static_select"].includes(element.type)) continue;
      const retained = view?.state?.values?.[block.block_id]?.[element.action_id];
      values[block.block_id] = { [element.action_id]: retained ?? (element.type === "plain_text_input" ? { value: element.initial_value ?? null } : { selected_option: element.initial_option ?? null }) };
    }
    view = { ...next, id, hash: `h${++revision}`, state: { values } };
  }
  function editQuery(value: unknown) {
    const block = searchInput();
    if (block) view.state.values[block.block_id][block.element.action_id] = { value };
  }
  const client = {
    views: {
      open: async (input: any) => { calls.push("open"); opens.push(input); if (openError) throw { data: { error: openError }, body: "PrivateBody" }; applyView(input.view, "VCATALOG"); return { view }; },
      update: async (input: any) => { calls.push("update"); updates.push(input); assert.equal(input.hash, view.hash); if (updateError) throw { data: { error: updateError }, body: "PrivateBody" }; applyView(input.view, view.id); return { view }; },
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
    if (action.action_id === "nobo_agent_catalog_group" && groupInput()) view.state.values[groupInput().block_id][action.action_id] = { selected_option: action.selected_option };
    const body = { ...signed, ...(view ? { view } : {}), ...overrides };
    await match(actions, action.action_id)({ action, body, client, ack: async () => { acks++; calls.push("ack"); } });
    assert.equal(acks, 1);
  }
  async function submit(query: unknown, overrides: any = {}) {
    let acks = 0;
    editQuery(query);
    const inputView = { ...view, ...overrides };
    await match(submissions, "nobo_agent_catalog_submit")({ body: signed, view: inputView, client, ack: async (value: any) => {
      acks++; calls.push("ack"); acknowledgements.push(value);
      if (value?.response_action === "update") applyView(value.view, inputView.id);
    } });
    assert.equal(acks, 1); return acknowledgements.at(-1);
  }
  return { calls, updates, opens, accessInputs, acknowledgements, action, submit, editQuery,
    get visibleQuery() { const block = searchInput(); return block ? view.state.values[block.block_id][block.element.action_id].value ?? "" : undefined; },
    get visibleGroup() { const block = groupInput(); return block ? view.state.values[block.block_id].nobo_agent_catalog_group.selected_option?.value : undefined; },
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
  const select = h.view.blocks.find((block: any) => block.elements?.some((element: any) => element.action_id === "nobo_agent_catalog_group")).elements[0];
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

test("repeated reset clears Slack-retained controls; draft edits survive group/page and help/back restores applied filters", async () => {
  const h = harness(); await h.open();
  for (let round = 0; round < 3; round++) {
    h.editQuery("  private  ");
    await h.action({ action_id: "nobo_agent_catalog_group", selected_option: { value: "capture" } });
    assert.equal(h.visibleQuery, "  private  ", "group change must not erase an unsubmitted edit");
    assert.equal(h.visibleGroup, "capture"); assert.equal(state(h.view).query, undefined, "group change does not submit search");
    await h.action({ action_id: "nobo_agent_catalog_page", value: "2" });
    assert.equal(h.visibleQuery, "  private  "); assert.equal(state(h.view).query, undefined);
    await h.submit(h.visibleQuery);
    assert.equal(h.visibleQuery, "private", "new initial value replaces retained unnormalized input");
    assert.deepEqual(state(h.view), { group: "capture", query: "private", page: 1 });
    const helpId = helpRows(h.view)[0].accessory.value;
    await h.action({ action_id: "nobo_agent_catalog_help", value: helpId });
    await h.action({ action_id: "nobo_agent_catalog_back", value: "back" });
    assert.equal(h.visibleQuery, "private"); assert.equal(h.visibleGroup, "capture");
    const oldInputIds = h.view.blocks.filter((block: any) => block.block_id).map((block: any) => block.block_id);
    await h.action({ action_id: "nobo_agent_catalog_reset", value: "reset" });
    assert.deepEqual(state(h.view), { page: 1 });
    assert.equal(h.visibleQuery, ""); assert.equal(h.visibleGroup, "all");
    assert.ok(h.view.blocks.every((block: any) => !block.block_id || !oldInputIds.includes(block.block_id)));
    await h.submit(""); assert.deepEqual(state(h.view), { page: 1 });
    checkBounds(h.view);
  }
  assert.equal(h.opens.length, 1);
  for (const update of h.updates) for (const block of update.view.blocks) if (block.block_id) {
    assert.ok(block.block_id.length <= 160);
    assert.match(block.block_id, /^agent_catalog_(?:query|group)_(?:h\d+|initial)$/);
    assert.doesNotMatch(block.block_id, /private|capture|UCATALOG|TCATALOG/);
  }
});

test("reset respects missing/stale hashes and closed views without replacing their forms", async () => {
  for (const failure of ["missing", "hash_conflict", "view_not_found"]) {
    const h = harness(); await h.open(); await h.submit("private");
    const before = h.view;
    if (failure === "missing") h.view.hash = undefined; else h.updateError = failure;
    await h.action({ action_id: "nobo_agent_catalog_reset", value: "reset" });
    assert.equal(h.view, before); assert.equal(h.visibleQuery, "private");
    assert.equal(h.opens.length, 1); assert.equal(h.updates.length, failure === "missing" ? 0 : 1);
  }
  const h = harness(); await h.open();
  await h.submit("private", { blocks: [] });
  assert.deepEqual(state(h.view), { page: 1 }); assert.equal(h.visibleQuery, "");
  assert.match(JSON.stringify(h.view), /search form expired/);
  for (const controlsRevision of ["x".repeat(129), "private query <&>", "\ud800"]) {
    const view = buildSlackAgentCatalogView({ page: 1 }, undefined, controlsRevision);
    assert.ok(view.blocks.filter(block => block.block_id).every(block => block.block_id?.endsWith("_initial")));
  }
});

for (const kind of ["page", "group"] as const) test(`cleared null search draft survives ${kind} until explicit Search across repeated back/reset flows`, async () => {
  const h = harness(); await h.open();
  const navigate = () => h.action(kind === "page"
    ? { action_id: "nobo_agent_catalog_page", value: "2" }
    : { action_id: "nobo_agent_catalog_group", selected_option: { value: "capture" } });
  for (let round = 0; round < 3; round++) {
    await h.submit("private"); h.editQuery(null);
    const beforeIds = h.view.blocks.filter((block: any) => block.block_id).map((block: any) => block.block_id);
    await navigate();
    assert.equal(state(h.view).query, "private", "navigation must keep the applied filter until Search");
    assert.equal(h.visibleQuery, "", "Slack's null is an explicitly cleared, unsubmitted draft");
    const input = h.view.blocks.find((block: any) => block.type === "input");
    assert.equal(input.element.initial_value, undefined);
    assert.ok(h.view.blocks.every((block: any) => !block.block_id || !beforeIds.includes(block.block_id)));
    checkBounds(h.view);
    const id = helpRows(h.view)[0].accessory.value;
    const applied = state(h.view);
    await h.action({ action_id: "nobo_agent_catalog_help", value: id });
    await h.action({ action_id: "nobo_agent_catalog_back", value: "back" });
    assert.deepEqual(state(h.view), applied); assert.equal(h.visibleQuery, "private", "Back restores the applied filters");
    h.editQuery(null); await navigate(); assert.equal(h.visibleQuery, "");
    const ack = await h.submit(null);
    assert.equal(ack.response_action, "update"); assert.equal(ack.view.submit.text, "Search");
    assert.deepEqual(state(h.view), { ...(kind === "group" ? { group: "capture" } : {}), page: 1 });
    assert.equal(h.visibleQuery, ""); checkBounds(h.view);
    await h.action({ action_id: "nobo_agent_catalog_reset", value: "reset" });
    assert.deepEqual(state(h.view), { page: 1 }); assert.equal(h.visibleQuery, ""); assert.equal(h.visibleGroup, "all");
  }
  assert.equal(h.opens.length, 1);
});

test("absent or malformed drafts restore the applied filter rather than acting as an explicit clear", async () => {
  for (const malformed of [undefined, 123, {}, "x".repeat(101), "\ud800", "x\0y"]) {
    const h = harness(); await h.open(); await h.submit("private");
    if (malformed === undefined) h.view.state.values = {}; else h.editQuery(malformed);
    await h.action({ action_id: "nobo_agent_catalog_page", value: "2" });
    assert.equal(h.visibleQuery, "private"); assert.equal(state(h.view).query, "private"); checkBounds(h.view);
  }
});

test("null drafts keep supplied-hash concurrency for missing, stale and closed views", async () => {
  for (const failure of ["missing", "hash_conflict", "view_not_found"]) {
    const h = harness(); await h.open(); await h.submit("private"); h.editQuery(null);
    const before = h.view;
    if (failure === "missing") h.view.hash = undefined; else h.updateError = failure;
    await h.action({ action_id: "nobo_agent_catalog_page", value: "2" });
    assert.equal(h.view, before); assert.equal(h.visibleQuery, "");
    assert.deepEqual(state(h.view), { query: "private", page: 1 });
    assert.equal(h.opens.length, 1); assert.equal(h.updates.length, failure === "missing" ? 0 : 1);
  }
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
  for (const invalid of ["x".repeat(101), "\ud800", 123, "x\0y"]) {
    const before = state(h.view), inputId = h.view.blocks.find((block: any) => block.type === "input").block_id;
    const ack = await h.submit(invalid);
    assert.equal(ack.response_action, "errors"); assert.deepEqual(Object.keys(ack.errors), [inputId]);
    assert.ok(typeof ack.errors[inputId] === "string" && ack.errors[inputId].length <= 150 && ack.errors[inputId].isWellFormed());
    assert.deepEqual(state(h.view), before, "a form error must not apply an invalid filter");
  }
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
