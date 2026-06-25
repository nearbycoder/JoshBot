import { createSlackSkillReply } from "./ai.js";
import { handleArtifactCommandText } from "./artifact-commands.js";
import { handleChannelDigestCommand } from "./channel-digests.js";
import type { ChannelMemoryEntry } from "./memory.js";
import type { NoboModelMessage } from "./nobo-messages.js";

type SlackSkillContext = {
  commandText: string;
  modelMessages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
  beforeModelReply?: () => void | Promise<void>;
};

type ParsedSkillCommand = {
  name: string;
  args: string;
};

const SKILL_HELP_LINES = [
  "`@NoBo skills` or `@NoBo help`: list available skills",
  "`@NoBo decision add <decision>` or `@NoBo decisions`: capture or list channel decisions",
  "`@NoBo summarize-thread [focus]`: summarize the current thread",
  "`@NoBo thread-todos`: extract action items and owners from the thread",
  "`@NoBo channel-digest daily 09:00 [focus]`: subscribe this channel to digests",
  "`@NoBo web-search <query>`: run an explicit web search",
  "`@NoBo show channel memory`, `forget channel memory ...`, `clear channel memory confirm`: shared channel memory controls",
  "`@NoBo artifacts [list|delete <id>|cleanup]`: manage generated artifacts",
  "`@NoBo remember ...`, `show my memory`, `clear my memory`: personal memory commands"
];

export function formatSlackSkillHelp() {
  return `Available skills:\n${SKILL_HELP_LINES.join("\n")}`;
}

export async function maybeHandleSlackSkillCommand({
  commandText,
  modelMessages,
  memories,
  currentUserId,
  channelMemories,
  channelId,
  onTextDelta,
  beforeModelReply
}: SlackSkillContext) {
  const command = parseSkillCommand(commandText);

  if (!command) {
    return null;
  }

  switch (command.name) {
    case "help":
    case "skills":
      return formatSlackSkillHelp();
    case "summarize-thread":
      await beforeModelReply?.();
      return createSlackSkillReply({
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: command.args
              ? `Use the summarize-thread skill. Summarize this Slack thread with special focus on: ${command.args}`
              : "Use the summarize-thread skill. Summarize this Slack thread. Keep it concise and easy to scan."
          }
        ],
        memories,
        currentUserId,
        channelMemories,
        channelId,
        skillName: "summarize-thread",
        instructions: `Your job is to summarize the current Slack thread.
- Prefer a short overview, key decisions, open questions, and next steps.
- If there are action items, include owners when they are clear.
- If the thread is very short, say that briefly instead of overproducing.`,
        onTextDelta
      });
    case "thread-todos":
      await beforeModelReply?.();
      return createSlackSkillReply({
        messages: [
          ...modelMessages,
          {
            role: "user",
            content:
              "Use the thread-todos skill. Extract the actionable todos from this Slack thread, including owners and status where possible."
          }
        ],
        memories,
        currentUserId,
        channelMemories,
        channelId,
        skillName: "thread-todos",
        instructions: `Your job is to extract action items from the current Slack thread.
- Return a short flat list.
- Each item should include the task, likely owner if known, and status if implied.
- If there are no clear action items, say that plainly.`,
        onTextDelta
      });
    case "channel-digest":
      return handleChannelDigestCommand({
        text: command.args,
        channelId,
        ownerUserId: currentUserId,
        commandName: "@NoBo channel-digest"
      });
    case "web-search":
      if (!command.args) {
        return "Usage: `@NoBo web-search <query>`";
      }

      await beforeModelReply?.();
      return createSlackSkillReply({
        messages: [
          {
            role: "user",
            content: `Use web search to answer this query: ${command.args}`
          }
        ],
        memories,
        currentUserId,
        channelMemories,
        channelId,
        skillName: "web-search",
        instructions: `Your job is to answer the user's explicit web-search request.
- Use the web search tool when it helps.
- Keep the answer concise.
- End with a short 'Sources:' section when you used web search.`,
        onTextDelta
      });
    case "artifacts":
      return handleArtifactCommandText(command.args || "list");
    case "list-artifacts":
      return handleArtifactCommandText(command.args ? `list ${command.args}` : "list");
    case "delete-artifact":
      return command.args
        ? handleArtifactCommandText(`delete ${command.args}`)
        : "Usage: `@NoBo delete-artifact <id>`";
    case "cleanup-artifacts":
      return handleArtifactCommandText(command.args || "cleanup");
    default:
      return null;
  }
}

function parseSkillCommand(commandText: string): ParsedSkillCommand | null {
  const trimmed = commandText.trim();

  if (!trimmed) {
    return null;
  }

  const [rawName, ...rest] = trimmed.split(/\s+/);
  const name = normalizeSkillName(rawName ?? "");

  if (!name) {
    return null;
  }

  const args = rest.join(" ").trim();

  if (name === "help" || name === "skills") {
    return { name, args };
  }

  if (name === "summary") {
    return { name: "summarize-thread", args };
  }

  if (name === "search") {
    return { name: "web-search", args };
  }

  if (name === "todos" || name === "action-items") {
    return { name: "thread-todos", args };
  }

  if (name === "digest") {
    return { name: "channel-digest", args };
  }

  if (name === "artifact") {
    return { name: "artifacts", args };
  }

  if (
    name === "summarize-thread" ||
    name === "thread-todos" ||
    name === "channel-digest" ||
    name === "web-search" ||
    name === "artifacts" ||
    name === "list-artifacts" ||
    name === "delete-artifact" ||
    name === "cleanup-artifacts" ||
    name === "prune-artifacts"
  ) {
    if (name === "prune-artifacts") {
      return { name: "cleanup-artifacts", args };
    }

    return { name, args };
  }

  return null;
}

function normalizeSkillName(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
