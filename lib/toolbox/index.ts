import { checklists } from "./checklists.js";
import { prompts } from "./prompts.js";
import { runFeature, type Feature } from "./core.js";
import { notes } from "./notes.js";
import { bookmarks } from "./bookmarks.js";
export const features: Feature[] = [
  prompts,
  checklists,
  notes, bookmarks,
];
export async function handleToolbox(text: string, owner: { userId?: string; teamId?: string }, requestId?: string) {
  const [, id, command] = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  if (!id || id === "help") return `Private NoBo toolbox\nOpen NoBo Home → Your NoBo tools → Personal toolbox.\nOr /nobo-help tools <tool> help\n\n${features.map(f => `${f.id}: ${f.title} — ${f.description}`).join("\n")}\n\nStored in existing Redis, scoped to your workspace and user. No model calls or external services. Do not store passwords or secrets here.`;
  const feature = features.find(f => f.id === id);
  return feature ? runFeature(feature, command ?? "help", owner, requestId) : "Unknown tool. Use /nobo-help tools to see the available tools.";
}
