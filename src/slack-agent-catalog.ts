import type { App } from "@slack/bolt";
import type { ModalView, WebClient } from "@slack/web-api";
import type { evaluateNoboAccess } from "../lib/access-controls.js";
import { recordOpsError } from "../lib/ops-errors.js";
import { validateAgentIdentity } from "../lib/agent-features/identity.js";
import { agentFeatures, formatAgentFeatureHelp } from "../lib/agent-features/registry.js";
import {
  AGENT_CATALOG_PRIVACY, agentCatalogCommand, agentCatalogGroups, getAgentCatalogPage,
  isAgentCatalogGroup, normalizeAgentCatalogQuery, type AgentCatalogState,
} from "../lib/agent-features/catalog.js";

type CatalogViewState = AgentCatalogState & { featureId?: string };
type CatalogDependencies = { access: typeof evaluateNoboAccess };
type ViewClient = Pick<WebClient, "views">;
type SignedBody = { user: { id: string }; team?: { id: string } | null };
type ExistingView = { id: string; hash?: string; private_metadata?: string };
const namespace = "nobo_agent_catalog_";
const searchBlock = "agent_catalog_query";
const searchAction = "query";
const fallback = "Use /nobo-help agent in your Slack composer, or reopen Personal agents from Home.";
const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: false });
const section = (text: string) => ({ type: "section" as const, text: plain(text) });
const button = (text: string, action: string, value: string) => ({ type: "button" as const, text: plain(text), action_id: namespace + action, value });
const modal = (blocks: ModalView["blocks"], state?: CatalogViewState): ModalView => ({
  type: "modal", title: plain("Personal agents"), close: plain("Close"),
  callback_id: namespace + "submit", blocks,
  ...(state ? { private_metadata: JSON.stringify(state) } : {}),
});

/** Only navigation is retained. Identity and authorization never come from the view. */
export function parseAgentCatalogViewState(raw: unknown): { state: CatalogViewState; notice?: string } {
  const invalid = () => ({ state: { page: 1 }, notice: "This catalog view expired or had invalid filters. Start again below." });
  if (typeof raw !== "string" || raw.length > 800) return invalid();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const state = value as Record<string, unknown>;
    if (Object.keys(state).some(key => !["page", "group", "query", "featureId"].includes(key)) ||
        !Number.isSafeInteger(state.page) || (state.page as number) < 1 || (state.page as number) > 10_000 ||
        (state.group !== undefined && !isAgentCatalogGroup(state.group)) ||
        (state.query !== undefined && (typeof state.query !== "string" || normalizeAgentCatalogQuery(state.query) !== state.query)) ||
        (state.featureId !== undefined && (typeof state.featureId !== "string" || !agentFeatures.some(entry => entry.id === state.featureId)))) return invalid();
    return { state: { page: state.page as number,
      ...(state.group ? { group: state.group as AgentCatalogState["group"] } : {}),
      ...(state.query ? { query: state.query as string } : {}),
      ...(state.featureId ? { featureId: state.featureId as string } : {}),
    } };
  } catch { return invalid(); }
}

/** Split losslessly at complete lines/words. Never cut a surrogate pair or a command line. */
export function agentHelpSections(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 2_500) {
    let end = remaining.lastIndexOf("\n", 2_500);
    if (end < 1) end = remaining.lastIndexOf(" ", 2_500);
    if (end < 1) { end = 2_500; if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--; }
    chunks.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Pure metadata renderer: no preferences, feature state, source adapters or execution. */
export function buildSlackAgentCatalogView(state: CatalogViewState = { page: 1 }, notice?: string, controlsRevision = "initial"): ModalView {
  const validated = parseAgentCatalogViewState(JSON.stringify(state));
  state = validated.state; notice = notice ?? validated.notice;
  const feature = agentFeatures.find(entry => entry.id === state.featureId);
  if (feature) {
    return modal([
      section(`${feature.title}\n${feature.description}`),
      ...agentHelpSections(formatAgentFeatureHelp(feature)).map(section),
      section(`Try in your Slack composer:\n${feature.example}\n\nCommand help: /nobo-help agent ${feature.id} help`),
      { type: "actions", elements: [button("Back to results", "back", "back")] },
    ], state);
  }
  let page = getAgentCatalogPage(agentFeatures, state);
  if (page.error && page.total) {
    notice = page.error; state = { ...state, page: 1 }; page = getAgentCatalogPage(agentFeatures, state);
  }
  const groupOption = (slug: string, label: string) => ({ text: plain(label), value: slug });
  const options = [groupOption("all", "All groups"), ...agentCatalogGroups.map(group => groupOption(group.slug, group.label))];
  // Slack retains inputs with unchanged block/action IDs, even over new initial values.
  // The preceding view hash changes on each update; it is UI state, never authorization.
  const controlKey = /^[a-zA-Z0-9._-]{1,128}$/.test(controlsRevision) ? controlsRevision : "initial";
  const navigation = [];
  if (state.page > 1) navigation.push(button("Previous", "page", String(state.page - 1)));
  if (state.page < page.pages) navigation.push(button("Next", "page", String(state.page + 1)));
  if (state.query || state.group || notice) navigation.push(button("Reset", "reset", "reset"));
  return {
    ...modal([
      section(AGENT_CATALOG_PRIVACY),
      ...(notice ? [section(notice)] : []),
      { type: "actions", block_id: `agent_catalog_group_${controlKey}`, elements: [{
        type: "static_select", action_id: namespace + "group", placeholder: plain("All groups"),
        options, initial_option: options.find(option => option.value === (state.group ?? "all")),
      }] },
      { type: "input", block_id: `${searchBlock}_${controlKey}`, optional: true, label: plain("Search agents"),
        element: { type: "plain_text_input", action_id: searchAction, max_length: 100,
          ...(state.query ? { initial_value: state.query } : {}), placeholder: plain("Try meeting, writing, or a full agent ID") } },
      section(page.error ?? `${page.start}–${page.end} of ${page.total} · page ${state.page}/${page.pages}${state.query ? `\nSearch: ${state.query}` : ""}`),
      ...page.entries.map(entry => ({ ...section(`${entry.id} — ${entry.description}`), accessory: button("Help", "help", entry.id) })),
      ...(navigation.length ? [{ type: "actions" as const, elements: navigation }] : []),
      section(`${state.query && state.group ? "Search all groups in your Slack composer" : "In your Slack composer"}: ${agentCatalogCommand(state)}\nAgent commands: /nobo-help agent <id> help`),
    ], state),
    submit: plain("Search"),
  };
}

const deniedView = () => modal([section(`Personal agents are unavailable for this signed workspace/user. ${fallback}`)]);
function safeCatalogError(error: unknown): void {
  const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
  // Never log Slack's response bodies, user queries, metadata, or arbitrary exception text.
  if (["hash_conflict", "invalid_hash", "view_not_found", "not_found", "expired_trigger_id", "invalid_trigger", "trigger_expired", "trigger_exchanged"].includes(String(code))) return;
  recordOpsError("personal agent catalog", new Error("Catalog view could not be updated. Reopen Home or use /nobo-help agent."));
}
async function allowed(body: SignedBody, dependencies: CatalogDependencies): Promise<boolean> {
  try {
    const owner = { teamId: body.team?.id, userId: body.user.id };
    validateAgentIdentity(owner);
    return (await dependencies.access({ ...owner, action: "home_tools", surface: "slack-home" })).allowed;
  } catch (error) { safeCatalogError(error); return false; }
}
async function update(client: ViewClient, previous: ExistingView | undefined, view: ModalView): Promise<void> {
  if (!previous?.id || !previous.hash) return;
  try { await client.views.update({ view_id: previous.id, hash: previous.hash, view }); }
  catch (error) { safeCatalogError(error); }
}

/** The generic Home handler has already acknowledged; this entry never pushes a view. */
export async function openSlackAgentCatalog(body: SignedBody & { trigger_id?: string; view?: ExistingView & { type?: string } }, client: ViewClient, dependencies: CatalogDependencies): Promise<void> {
  if (!(await allowed(body, dependencies))) return;
  const view = buildSlackAgentCatalogView({ page: 1 }, undefined, body.view?.hash);
  if (body.view?.type === "modal") { await update(client, body.view, view); return; }
  if (!body.trigger_id) return;
  try { await client.views.open({ trigger_id: body.trigger_id, view }); }
  catch (error) { safeCatalogError(error); }
}

export function registerSlackAgentCatalogActions(bolt: App, dependencies: CatalogDependencies): void {
  // Distinct from /^nobo_home_/ so every interaction is acknowledged once.
  bolt.action(/^nobo_agent_catalog_/, async ({ ack, action, body, client }) => {
    await ack();
    const previous = "view" in body ? body.view : undefined;
    if (!(await allowed(body, dependencies))) { await update(client, previous, deniedView()); return; }
    let { state, notice } = parseAgentCatalogViewState(previous?.private_metadata);
    const actionId = "action_id" in action ? action.action_id : "";
    const value = "value" in action ? action.value : undefined;
    if (!notice) {
      if (actionId === namespace + "reset" && value === "reset") state = { page: 1 };
      else if (actionId === namespace + "back" && value === "back") { delete state.featureId; }
      else if (actionId === namespace + "group") {
        const group = "selected_option" in action ? action.selected_option?.value : undefined;
        if (group === "all" || isAgentCatalogGroup(group)) state = { ...(group !== "all" ? { group } : {}), ...(state.query ? { query: state.query } : {}), page: 1 };
        else notice = "Choose one of the catalog groups below.";
      } else if (actionId === namespace + "page" && typeof value === "string" && /^[1-9]\d{0,3}$/.test(value)) { delete state.featureId; state.page = Number(value); }
      else if (actionId === namespace + "help" && agentFeatures.some(entry => entry.id === value)) state.featureId = value;
      else notice = "That shortcut is no longer available. Choose an agent below.";
    }
    if (notice) { delete state.featureId; state.page = 1; }
    const nextView = buildSlackAgentCatalogView(state, notice, previous?.hash);
    // Keep an unsubmitted edit while paging/changing groups, without applying it as a filter.
    // Reset and invalid/stale navigation deliberately restore the validated filters instead.
    if (!notice && (actionId === namespace + "group" || actionId === namespace + "page")) {
      const inputId = previous?.blocks.find(block => block.type === "input" && block.block_id?.startsWith(searchBlock + "_"))?.block_id;
      const draft = inputId ? previous?.state?.values?.[inputId]?.[searchAction]?.value : undefined;
      if (typeof draft === "string" && draft.length <= 100 && draft.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(draft)) {
        for (const block of nextView.blocks) if (block.type === "input" && "element" in block && block.element.type === "plain_text_input") {
          block.element.initial_value = draft || undefined;
        }
      }
    }
    await update(client, previous, nextView);
  });
  bolt.view(namespace + "submit", async ({ ack, body, view }) => {
    // response_action:update keeps one modal alive; no hash-free views.update races.
    // Unlike an action ack, a successful empty submission ack would close the modal.
    if (!(await allowed(body, dependencies))) { await ack({ response_action: "update", view: deniedView() }); return; }
    const parsed = parseAgentCatalogViewState(view.private_metadata);
    if (parsed.notice) { await ack({ response_action: "update", view: buildSlackAgentCatalogView(parsed.state, parsed.notice, view.hash) }); return; }
    const input = view.blocks.find(block => block.type === "input" && block.block_id?.startsWith(searchBlock + "_"));
    const inputId = input?.block_id;
    if (!inputId || inputId.length > 160) { await ack({ response_action: "update", view: buildSlackAgentCatalogView({ page: 1 }, "This search form expired. Enter a new search below.", view.hash) }); return; }
    const value = view.state?.values?.[inputId]?.[searchAction]?.value ?? "";
    if (typeof value !== "string") { await ack({ response_action: "errors", errors: { [inputId]: "Enter a search phrase, or clear search to browse this group." } }); return; }
    const query = value.trim() ? normalizeAgentCatalogQuery(value) : undefined;
    if (value.trim() && !query) { await ack({ response_action: "errors", errors: { [inputId]: "Use at most 100 characters. Try meeting, or clear search to browse this group." } }); return; }
    const state: CatalogViewState = { ...(parsed.state.group ? { group: parsed.state.group } : {}), ...(query ? { query } : {}), page: 1 };
    await ack({ response_action: "update", view: buildSlackAgentCatalogView(state, undefined, view.hash) });
  });
}
