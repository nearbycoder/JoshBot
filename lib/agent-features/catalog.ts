import type { AgentFeatureMetadata } from "./types.js";

export const agentCatalogGroups = [
  { slug: "plan", label: "Plan & prioritize" },
  { slug: "capture", label: "Capture & recall" },
  { slug: "write", label: "Write & communicate" },
  { slug: "decide", label: "Decide & analyze" },
  { slug: "learn", label: "Learn & improve" },
  { slug: "life", label: "Organize life" },
  { slug: "review", label: "Review & maintain" },
] as const;
export type AgentCatalogGroup = typeof agentCatalogGroups[number]["slug"];
export type AgentCatalogState = { group?: AgentCatalogGroup; query?: string; page: number };
export const AGENT_CATALOG_LIMIT = 3_500;
export const AGENT_CATALOG_PRIVACY = "Personal agents stay private. Browsing runs no agent; use a command in your Slack composer to start.";
const prefix = "/nobo-help agent";
const reset = `Open the catalog: ${prefix} catalog`;
const reserved = new Set(["catalog", "search", "help"]);
const compareId = (a: AgentFeatureMetadata, b: AgentFeatureMetadata) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const escapeCatalogText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const isAgentCatalogGroup = (value: unknown): value is AgentCatalogGroup => agentCatalogGroups.some(group => group.slug === value);

/** Check the real registered metadata, never a filesystem or proposed catalog. */
export function validateAgentCatalog(entries: readonly AgentFeatureMetadata[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || reserved.has(entry.id) || ids.has(entry.id)) throw new Error("Duplicate, reserved or invalid personal agent ID.");
    ids.add(entry.id);
    if (!agentCatalogGroups.some(group => group.label === entry.group)) throw new Error(`Unknown personal agent group: ${entry.id}.`);
    if (!entry.title || !entry.description || !entry.help || !entry.example?.startsWith(`${prefix} ${entry.id} `) || !entry.keywords?.length) throw new Error(`Incomplete personal agent metadata: ${entry.id}.`);
  }
}

export function normalizeAgentCatalogQuery(value: string): string | undefined {
  // Count normalized UTF-16 units, just as Slack's text contract does. Never clip a query.
  const query = value.trim().replace(/\s+/gu, " ");
  return query.length > 0 && query.length <= 100 && query.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(query) ? query : undefined;
}

type CatalogCommand = { state: AgentCatalogState; error?: never } | { error: string; state?: never };
/** null means an ordinary feature route; reserved names always finish here. */
export function parseAgentCatalogCommand(text: string): CatalogCommand | null {
  const normalized = text.trim().replace(/\s+/gu, " ");
  const [verb = "", ...parts] = normalized.split(" ");
  if (!verb || (verb.toLowerCase() === "help" && !parts.length)) return { state: { page: 1 } };
  if (!reserved.has(verb.toLowerCase())) return null;
  const invalid = (message: string): CatalogCommand => ({ error: `${message}\n${reset}` });
  if (verb.toLowerCase() === "help") return invalid(`Use ${prefix} <id> help for an agent’s commands.`);
  if (verb.toLowerCase() === "search") {
    let query = parts.join(" "), page = 1;
    // Only a terminal numeric suffix is navigation. "page", "page design", etc. are literal search words.
    const suffix = /(?:^| )page (\d+)$/i.exec(query);
    if (suffix) { page = Number(suffix[1]); query = query.slice(0, suffix.index); }
    if (!Number.isSafeInteger(page) || page < 1) return invalid("Choose a positive page number. Try /nobo-help agent search meeting.");
    const clean = normalizeAgentCatalogQuery(query);
    if (!clean) return invalid("Enter a search of 1–100 characters. Try /nobo-help agent search meeting.");
    return { state: { query: clean, page } };
  }
  const match = /^(?:group ([a-z]+)(?: |$))?(?:page (\d+))?$/i.exec(parts.join(" "));
  if (!match) return invalid(`Use ${prefix} catalog group plan page 2, or ${prefix} catalog page 2.`);
  const group = match[1]?.toLowerCase(), page = match[2] ? Number(match[2]) : 1;
  if (group && !isAgentCatalogGroup(group)) return invalid(`Choose a group: ${agentCatalogGroups.map(item => item.slug).join(", ")}.`);
  if (!Number.isSafeInteger(page) || page < 1) return invalid("Choose a positive page number.");
  return { state: { ...(group ? { group: group as AgentCatalogGroup } : {}), page } };
}

export function findAgentCatalogEntries(entries: readonly AgentFeatureMetadata[], state: AgentCatalogState): AgentFeatureMetadata[] {
  const label = agentCatalogGroups.find(group => group.slug === state.group)?.label;
  const filtered = entries.filter(entry => !label || entry.group === label);
  if (state.query) {
    const query = state.query.toLowerCase(), tokens = query.split(" ");
    const ranked = filtered.flatMap(entry => {
      const primary = `${entry.id} ${entry.title}`.toLowerCase();
      const all = `${primary} ${entry.description} ${(entry.keywords ?? []).join(" ")}`.toLowerCase();
      if (!tokens.every(token => all.includes(token))) return [];
      return [{ entry, rank: entry.id === query ? 0 : tokens.every(token => primary.includes(token)) ? 1 : 2 }];
    });
    return ranked.sort((a, b) => a.rank - b.rank || compareId(a.entry, b.entry)).map(item => item.entry);
  }
  return filtered.sort((a, b) => agentCatalogGroups.findIndex(group => group.label === a.group) - agentCatalogGroups.findIndex(group => group.label === b.group) || compareId(a, b));
}

export function agentCatalogCommand(state: AgentCatalogState, page = state.page): string {
  // Slash search is global; Home may intersect a search with a selected group.
  const base = state.query ? `${prefix} search ${state.query}` : `${prefix} catalog${state.group ? ` group ${state.group}` : ""}`;
  return `${base} page ${page}`;
}
const scopeText = (state: AgentCatalogState) => [state.group ? agentCatalogGroups.find(group => group.slug === state.group)!.label : "All groups", state.query ? `Search: ${state.query}` : ""].filter(Boolean).join(" · ");
const row = (entry: AgentFeatureMetadata) => escapeCatalogText(`${entry.id} — ${entry.description.replace(/\s+/gu, " ")}`);
function pageFrame(state: AgentCatalogState, total: number, start: number, end: number, pages: number, rows: string[]): string {
  return [
    "Personal agents", AGENT_CATALOG_PRIVACY,
    `Groups: ${agentCatalogGroups.map(group => group.slug).join(" · ")}`,
    escapeCatalogText(scopeText(state)), `${start}–${end} of ${total} · page ${state.page}/${pages}`, "", ...rows, "",
    ...(state.page > 1 ? [`Previous: ${escapeCatalogText(agentCatalogCommand(state, state.page - 1))}`] : []),
    ...(state.page < pages ? [`Next: ${escapeCatalogText(agentCatalogCommand(state, state.page + 1))}`] : []),
    `Group: ${prefix} catalog group plan`, `Search: ${prefix} search meeting`, `Help: ${prefix} <id> help`,
  ].join("\n");
}

export type AgentCatalogPage = {
  state: AgentCatalogState; entries: readonly AgentFeatureMetadata[]; total: number;
  pages: number; start: number; end: number; text: string; error?: string;
};
/** Stable packing uses a conservative frame bound independent of the requested page. */
export function getAgentCatalogPage(entries: readonly AgentFeatureMetadata[], state: AgentCatalogState = { page: 1 }): AgentCatalogPage {
  const failure = (error: string, total = 0, pages = 0): AgentCatalogPage => ({ state, entries: [], total, pages, start: 0, end: 0, error, text: `${escapeCatalogText(error)}\n${reset}` });
  if ((state.group !== undefined && !isAgentCatalogGroup(state.group)) || (state.query !== undefined && normalizeAgentCatalogQuery(state.query) !== state.query)) return failure("These filters are invalid. Start a new catalog search.");
  const matches = findAgentCatalogEntries(entries, state), total = matches.length;
  if (!total) return failure(`No agents match ${scopeText(state)}. Try ${prefix} search meeting or ${prefix} catalog group plan.`);
  // total + 1 reserves both navigation lines even when the real page is first/last.
  const reserve = pageFrame({ ...state, page: total + 1 }, total, total, total, total + 2, []).length;
  const pages: AgentFeatureMetadata[][] = [];
  for (const entry of matches) {
    const current = pages.at(-1), size = row(entry).length + 1;
    if (size + reserve > AGENT_CATALOG_LIMIT) return failure("An agent description cannot fit a catalog page. Use its ID followed by help.");
    if (!current || current.length === 10 || current.reduce((sum, item) => sum + row(item).length + 1, 0) + size + reserve > AGENT_CATALOG_LIMIT) pages.push([entry]);
    else current.push(entry);
  }
  if (!Number.isSafeInteger(state.page) || state.page < 1 || state.page > pages.length) return failure(`Choose page 1–${pages.length}. Restart: ${agentCatalogCommand(state, 1)}`, total, pages.length);
  const selected = pages[state.page - 1], start = pages.slice(0, state.page - 1).reduce((sum, page) => sum + page.length, 1), end = start + selected.length - 1;
  return { state, entries: selected, total, pages: pages.length, start, end, text: pageFrame(state, total, start, end, pages.length, selected.map(row)) };
}

export function formatAgentCatalog(entries: readonly AgentFeatureMetadata[], state: AgentCatalogState = { page: 1 }): string {
  return getAgentCatalogPage(entries, state).text;
}
