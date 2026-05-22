import { type ModelMessage } from "ai";
import { createSlackSkillReply } from "./ai.js";

type SlackSkillContext = {
  commandText: string;
  modelMessages: ModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
};

type ParsedSkillCommand = {
  name: string;
  args: string;
};

const SKILL_HELP = [
  "`@JoshBot skills` or `@JoshBot help`: list available skills",
  "`@JoshBot summarize-thread [focus]`: summarize the current thread",
  "`@JoshBot thread-todos`: extract action items and owners from the thread",
  "`@JoshBot web-search <query>`: run an explicit web search",
  "`@JoshBot remember ...`, `show my memory`, `clear my memory`: personal memory commands"
].join("\n");

export async function maybeHandleSlackSkillCommand({
  commandText,
  modelMessages,
  memories,
  currentUserId
}: SlackSkillContext) {
  const command = parseSkillCommand(commandText);

  if (!command) {
    return null;
  }

  switch (command.name) {
    case "help":
    case "skills":
      return `Available skills:\n${SKILL_HELP}`;
    case "summarize-thread":
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
        skillName: "summarize-thread",
        instructions: `Your job is to summarize the current Slack thread.
- Prefer a short overview, key decisions, open questions, and next steps.
- If there are action items, include owners when they are clear.
- If the thread is very short, say that briefly instead of overproducing.`
      });
    case "thread-todos":
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
        skillName: "thread-todos",
        instructions: `Your job is to extract action items from the current Slack thread.
- Return a short flat list.
- Each item should include the task, likely owner if known, and status if implied.
- If there are no clear action items, say that plainly.`
      });
    case "web-search":
      if (!command.args) {
        return "Usage: `@JoshBot web-search <query>`";
      }

      return createSlackSkillReply({
        messages: [
          {
            role: "user",
            content: `Use web search to answer this query: ${command.args}`
          }
        ],
        memories,
        currentUserId,
        skillName: "web-search",
        instructions: `Your job is to answer the user's explicit web-search request.
- Use the web search tool when it helps.
- Keep the answer concise.
- End with a short 'Sources:' section when you used web search.`
      });
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

  if (name === "summarize-thread" || name === "thread-todos" || name === "web-search") {
    return { name, args };
  }

  return null;
}

function normalizeSkillName(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
