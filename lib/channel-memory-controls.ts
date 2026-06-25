import {
  clearChannelMemories,
  getChannelMemorySnapshot,
  removeChannelMemory,
  type ChannelMemoryEntry
} from "./memory.js";

type ChannelMemoryAction =
  | { name: "show" }
  | { name: "help" }
  | { name: "forget"; query: string }
  | { name: "clear"; confirmed: boolean };

type ChannelMemoryControlSource = "slash" | "mention";

export async function handleChannelMemorySlashCommandText({
  text,
  channelId
}: {
  text: string;
  channelId?: string;
}) {
  const trimmed = text.trim();
  const action = trimmed ? parseChannelMemoryBody(trimmed) : { name: "show" as const };

  if (!action) {
    return formatChannelMemorySlashHelp();
  }

  return handleChannelMemoryAction(action, channelId, "slash");
}

export async function maybeHandleChannelMemoryMentionCommand({
  text,
  channelId
}: {
  text: string;
  channelId?: string;
}) {
  const action = parseChannelMemoryMention(text);

  if (!action) {
    return null;
  }

  return handleChannelMemoryAction(action, channelId, "mention");
}

export function formatChannelMemorySlashHelp() {
  return [
    "*NoBo channel memory*",
    "`/nobo-memory`: show shared channel memory and settings",
    "`/nobo-memory forget <number|text>`: forget one item",
    "`/nobo-memory clear confirm`: clear shared channel memory"
  ].join("\n");
}

async function handleChannelMemoryAction(
  action: ChannelMemoryAction,
  channelId: string | undefined,
  source: ChannelMemoryControlSource
) {
  if (action.name === "help") {
    return source === "slash" ? formatChannelMemorySlashHelp() : formatChannelMemoryMentionHelp();
  }

  if (!channelId || !isSharedSlackChannelId(channelId)) {
    return "Run this in a Slack channel.";
  }

  switch (action.name) {
    case "show":
      return formatChannelMemorySnapshot(await getChannelMemorySnapshot(channelId));
    case "forget":
      return forgetChannelMemory(channelId, action.query);
    case "clear":
      return clearChannelMemory(channelId, action.confirmed, source);
  }
}

async function forgetChannelMemory(channelId: string, query: string) {
  if (!query.trim()) {
    return "Usage: `/nobo-memory forget <number|text>`";
  }

  const result = await removeChannelMemory(channelId, query);

  if (!result.ok) {
    return `Couldn't update channel memory: ${result.reason}`;
  }

  if (result.status === "missing") {
    return "No matching channel memory.";
  }

  if (result.status === "ambiguous") {
    return `Matched more than one item:\n${result.matches.map(formatNumberedChannelMemoryMatch).join("\n")}`;
  }

  return `Forgot channel memory #${result.removedIndex + 1}: ${formatChannelMemoryEntry(result.removed)}`;
}

async function clearChannelMemory(
  channelId: string,
  confirmed: boolean,
  source: ChannelMemoryControlSource
) {
  if (!confirmed) {
    return source === "slash"
      ? "To clear shared channel memory, run `/nobo-memory clear confirm`."
      : "To clear shared channel memory, say `@NoBo clear channel memory confirm`.";
  }

  const result = await clearChannelMemories(channelId);

  if (!result.ok) {
    return `Couldn't clear channel memory: ${result.reason}`;
  }

  return `Cleared ${result.cleared} channel memory item${result.cleared === 1 ? "" : "s"}. Active listening: ${formatOnOff(result.settings.activeListening)}.`;
}

function formatChannelMemorySnapshot({
  memories,
  settings
}: {
  memories: ChannelMemoryEntry[];
  settings: { activeListening: boolean };
}) {
  const status = `Active listening: ${formatOnOff(settings.activeListening)}.`;

  if (memories.length === 0) {
    return `Shared channel memory is empty. ${status}`;
  }

  return `Shared channel memory (${memories.length}). ${status}\n${memories.map(formatNumberedChannelMemoryEntry).join("\n")}`;
}

function formatNumberedChannelMemoryEntry(entry: ChannelMemoryEntry, index: number) {
  return `${index + 1}. ${formatChannelMemoryEntry(entry)}`;
}

function formatNumberedChannelMemoryMatch({
  index,
  memory
}: {
  index: number;
  memory: ChannelMemoryEntry;
}) {
  return `${index + 1}. ${formatChannelMemoryEntry(memory)}`;
}

function formatChannelMemoryEntry(entry: ChannelMemoryEntry) {
  const speaker = entry.role === "assistant" ? "NoBo" : entry.userId ? `User ${entry.userId}` : "User";
  return `${speaker}: ${collapseWhitespace(entry.content).slice(0, 240)}`;
}

function parseChannelMemoryMention(text: string): ChannelMemoryAction | null {
  const trimmed = text.trim();

  if (/^(?:channel|shared)\s+memory\s+help$/i.test(trimmed)) {
    return { name: "help" };
  }

  if (
    /^(?:(?:show|list)\s+)?(?:this\s+)?(?:channel|shared)(?:'s)?\s+(?:memory|settings)$/i.test(trimmed) ||
    /^what do you remember about (?:this|the) channel\??$/i.test(trimmed)
  ) {
    return { name: "show" };
  }

  const forgetMatch =
    trimmed.match(/^(?:forget|remove|delete)\s+(?:from\s+)?(?:this\s+)?(?:channel|shared)\s+memory\s+(.+)$/i) ??
    trimmed.match(/^(?:channel|shared)\s+memory\s+(?:forget|remove|delete)\s+(.+)$/i);
  if (forgetMatch) {
    return { name: "forget", query: forgetMatch[1] ?? "" };
  }

  const clearMatch =
    trimmed.match(/^(?:clear|reset)\s+(?:this\s+)?(?:channel|shared)\s+memory(?:\s+(.+))?$/i) ??
    trimmed.match(/^(?:channel|shared)\s+memory\s+(?:clear|reset)(?:\s+(.+))?$/i);
  if (clearMatch) {
    return { name: "clear", confirmed: normalizeConfirm(clearMatch[1] ?? "") === "confirm" };
  }

  return null;
}

function parseChannelMemoryBody(text: string): ChannelMemoryAction | null {
  const trimmed = text.trim();

  if (!trimmed) {
    return { name: "show" };
  }

  if (trimmed.toLowerCase() === "help") {
    return { name: "help" };
  }

  if (/^(show|list|status|settings)$/i.test(trimmed)) {
    return { name: "show" };
  }

  const forgetMatch = trimmed.match(/^(forget|remove|delete)\s+(.+)$/i);
  if (forgetMatch) {
    return { name: "forget", query: forgetMatch[2] ?? "" };
  }

  const clearMatch = trimmed.match(/^(clear|reset)(?:\s+(.+))?$/i);
  if (clearMatch) {
    return { name: "clear", confirmed: normalizeConfirm(clearMatch[2] ?? "") === "confirm" };
  }

  return null;
}

function formatChannelMemoryMentionHelp() {
  return [
    "*NoBo channel memory*",
    "`@NoBo show channel memory`",
    "`@NoBo forget channel memory <number|text>`",
    "`@NoBo clear channel memory confirm`"
  ].join("\n");
}

function isSharedSlackChannelId(channelId: string) {
  return /^[CG][A-Z0-9]+$/i.test(channelId);
}

function normalizeConfirm(input: string) {
  return input.trim().toLowerCase();
}

function formatOnOff(value: boolean) {
  return value ? "on" : "off";
}

function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

export const __testing = {
  formatChannelMemorySnapshot,
  isSharedSlackChannelId,
  parseChannelMemoryBody,
  parseChannelMemoryMention
};
