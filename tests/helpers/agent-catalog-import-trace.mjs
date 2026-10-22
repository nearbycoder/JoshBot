import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// A separate process is essential: parity tests deliberately import every implementation.
const loaded = new Set();
registerHooks({ load(url, context, nextLoad) { loaded.add(url); return nextLoad(url, context); } });
let startup = 0;
const unexpected = () => { startup++; throw new Error("Unexpected catalog startup"); };
globalThis.fetch = unexpected;
const { handleAgentCommand } = await import("../../lib/agent-features/index.ts");
const { agentFeatures } = await import("../../lib/agent-features/registry.ts");
const { agentCatalogGroups, getAgentCatalogPage } = await import("../../lib/agent-features/catalog.ts");
const { buildSlackAgentCatalogView } = await import("../../src/slack-agent-catalog.ts");
const owner = { teamId: "TTRACE", userId: "UTRACE", requestId: "no-receipt" };
const dependencies = { createBackend: unexpected, preferences: unexpected, getRunSignal: unexpected, timeoutSignal: unexpected, loadServices: unexpected };
let routes = 0;
const run = async command => { assert.ok(await handleAgentCommand(command, owner, undefined, dependencies)); routes++; };
for (const command of ["", "help", "catalog", "search meeting", "search private page 2", "search <@UOTHER> &", "search " + "x".repeat(101), "catalog page 0", "catalog group invalid", "missing help"]) await run(command);
for (const group of [undefined, ...agentCatalogGroups.map(item => item.slug)]) {
  const first = getAgentCatalogPage(agentFeatures, { group, page: 1 });
  for (let page = 1; page <= first.pages; page++) {
    await run(`catalog${group ? ` group ${group}` : ""} page ${page}`);
    assert.ok(buildSlackAgentCatalogView({ group, page }).blocks.length <= 20);
  }
}
for (const entry of agentFeatures) {
  await run(`${entry.id} help`);
  await run(`search ${entry.id}`);
  assert.ok(buildSlackAgentCatalogView({ page: 1, featureId: entry.id }).blocks.length <= 20);
}
await assert.rejects(() => handleAgentCommand("help", {}, undefined, dependencies), /signed Slack/);
const implementations = [...loaded].filter(url => agentFeatures.some(entry => url.endsWith(`/agent-features/${entry.id}.ts`) || url.endsWith(`/agent-features/${entry.id}.js`)));
assert.ok([...loaded].some(url => url.endsWith("/agent-features/index.ts")), "the import hook must observe the real dispatcher");
assert.ok([...loaded].some(url => url.endsWith("/src/slack-agent-catalog.ts")), "the import hook must observe the Home renderer");
const forbidden = [...loaded].filter(url => /\/(?:context(?:\/[^/]+)?|services|runtime|store|redis|preferences|ai|providers)(?:\.[cm]?[jt]s|\/)/.test(url) || /node_modules\/(?:@redis|redis|exa-js|@earendil-works)\//.test(url));
assert.deepEqual(implementations, []);
assert.deepEqual(forbidden, []);
assert.equal(startup, 0);
console.log(JSON.stringify({ routes, registered: agentFeatures.length, implementationLoads: implementations.length, forbiddenLoads: forbidden.length, startup, scope: "direct handleAgentCommand discovery and pure Home renderer; signed ingress policy and whole Home wiring excluded" }));
