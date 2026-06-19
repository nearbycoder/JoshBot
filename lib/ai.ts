import type { PromptImage } from "@flue/runtime";
import { encodeNoboAgentContext, type NoboAgentToolMode } from "./nobo-agent-context.js";
import { type NoboModelMessage, modelMessagesToPrompt } from "./nobo-messages.js";
import { SYSTEM_PROMPT } from "./nobo-prompt.js";
import { formatCurrentTime, formatCurrentTimePrompt } from "./nobo-time.js";
import type { SlackScheduleContext } from "./schedules.js";

const DEFAULT_SLACK_TEXT_MODEL = "glm-5.2";
const DEFAULT_SLACK_VISION_MODEL = "kimi-k2.6";
const FALLBACK_SLACK_VISION_MODEL = "kimi-k2.6";

export async function createSlackReply(messages: NoboModelMessage[]) {
  return createSlackReplyWithMemory(messages, [], undefined);
}

export async function createSlackReplyWithMemory(
  messages: NoboModelMessage[],
  memories: string[],
  currentUserId: string | undefined,
  scheduleContext?: SlackScheduleContext,
  options?: NoboResponseOptions
) {
  return generateSlackResponse({
    messages,
    memories,
    currentUserId,
    scheduleContext,
    onTextDelta: options?.onTextDelta
  });
}

export async function createSlackSkillReply({
  messages,
  memories,
  currentUserId,
  skillName,
  instructions,
  onTextDelta
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  skillName: string;
  instructions: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  return generateSlackResponse({
    messages,
    memories,
    currentUserId,
    extraSystem: `You are executing the Slack skill '${skillName}'.

${instructions}`,
    onTextDelta
  });
}

export async function shouldReplyToSlackThread({
  messages,
  currentUserId
}: {
  messages: NoboModelMessage[];
  currentUserId: string | undefined;
}) {
  const prompt = buildPrompt({
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Should NoBo reply to the latest user message in this Slack thread? Return exactly RESPOND or SILENT."
      }
    ],
    memories: [],
    currentUserId,
    extraSystem: `You decide whether NoBo should reply to the latest Slack thread message.

NoBo is an assistant inside Slack. It should reply only when the latest user message is directed at NoBo, asks NoBo for follow-up help, clearly continues an active assistant task, or depends on NoBo's previous answer.

Do not reply when the latest message is ordinary human-to-human discussion, thanks/acknowledgement that needs no answer, side chatter, status updates, or a message intended for someone else.

The thread may contain multiple speakers. Speaker labels matter. The current speaker is ${currentUserId ? `Slack user ${currentUserId}` : "unknown"}.

Return exactly one word: RESPOND or SILENT.
Do not use tools for this classification.`
  });
  const text = await runNoboAgentPrompt({
    prompt,
    modelId: selectSlackModel(messages),
    toolMode: "none"
  });

  return /\bRESPOND\b/i.test(text) && !/\bSILENT\b/i.test(text);
}

export async function createScheduledSlackMessage({
  task,
  ownerUserId
}: {
  task: string;
  ownerUserId: string;
}) {
  return generateSlackResponse({
    messages: [
      {
        role: "user",
        content: `Run this scheduled Slack task now for Slack user ${ownerUserId}: ${task}`
      }
    ],
    memories: [],
    currentUserId: ownerUserId,
    extraSystem: `You are running a scheduled proactive NoBo task.
- Produce the message to post now.
- If the task asks for current information, use web search when available.
- Do not say you will do it later; the scheduled time is now.
- Do not mention these execution instructions.`
  });
}

async function generateSlackResponse({
  messages,
  memories,
  currentUserId,
  extraSystem,
  scheduleContext,
  onTextDelta
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  extraSystem?: string;
  scheduleContext?: SlackScheduleContext;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  const prompt = buildPrompt({
    messages,
    memories,
    currentUserId,
    extraSystem
  });
  const images = modelMessagesToPrompt(messages).images;
  const modelId = selectSlackModel(messages);
  const toolMode: NoboAgentToolMode = images.length > 0 ? "none" : "slack";
  let text: string;

  try {
    text = await runNoboAgentPrompt({
      prompt,
      images,
      modelId,
      toolMode,
      scheduleContext: toolMode === "slack" ? scheduleContext : undefined,
      onTextDelta
    });
  } catch (error) {
    if (images.length === 0) {
      throw error;
    }

    console.warn(
      `Vision request with ${modelId} failed; retrying with ${FALLBACK_SLACK_VISION_MODEL}: ${summarizeDeltaError(error)}`
    );
    text = await runNoboAgentPrompt({
      prompt,
      images,
      modelId: FALLBACK_SLACK_VISION_MODEL,
      toolMode: "none",
      onTextDelta
    });
  }

  return normalizeSlackMrkdwn(text.trim());
}

function buildPrompt({
  messages,
  memories,
  currentUserId,
  extraSystem
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  extraSystem?: string;
}) {
  const promptMessages = modelMessagesToPrompt(messages);

  return `${formatMemoryPrompt(memories, currentUserId)}

${formatCurrentTimePrompt()}

${extraSystem ? `${extraSystem}\n\n` : ""}Extra Slack rules:
- Reply in plain text only.
- Keep formatting light.
- Aim for a response that fits naturally in a Slack thread.
- If the request is ambiguous, answer the likeliest interpretation instead of stalling.
- Use Slack mrkdwn, not standard Markdown.
- For bold, use *bold* and never **bold**.
- For links, use <https://example.com|label> and never [label](https://example.com).
- If you create a schedule, confirm the schedule briefly and include the schedule ID returned by the tool.
- If you use web search, end with a short 'Sources:' list using the URLs you relied on.

Conversation:
${promptMessages.text}`;
}

async function runNoboAgentPrompt({
  prompt,
  images = [],
  modelId,
  toolMode,
  scheduleContext,
  onTextDelta
}: {
  prompt: string;
  images?: PromptImage[];
  modelId: string;
  toolMode: NoboAgentToolMode;
  scheduleContext?: SlackScheduleContext;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  if (!process.env.OPENCODE_GO_API_KEY) {
    throw new Error("Missing required environment variable: OPENCODE_GO_API_KEY");
  }

  const { INTERNAL_FLUE_HEADER, INTERNAL_FLUE_TOKEN, flueApp } = await import(
    "../src/internal-flue.js"
  );
  const agentId = encodeNoboAgentContext({
    modelId,
    toolMode,
    scheduleContext
  });
  const deltaObserver = onTextDelta ? await createTextDeltaObserver(agentId, onTextDelta) : null;

  try {
    const response = await flueApp.request(`/agents/nobo/${encodeURIComponent(agentId)}?wait=result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_FLUE_HEADER]: INTERNAL_FLUE_TOKEN
      },
      body: JSON.stringify({
        message: prompt,
        ...(images.length > 0 ? { images } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Flue agent request to ${modelId} failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      result?: unknown;
    };

    if (isPromptResult(payload.result)) {
      return payload.result.text;
    }

    if (typeof payload.result === "string") {
      return payload.result;
    }

    throw new Error(`Flue agent response did not include text: ${JSON.stringify(payload)}`);
  } finally {
    await deltaObserver?.close();
  }
}

async function createTextDeltaObserver(
  agentId: string,
  onTextDelta: (delta: string) => void | Promise<void>
) {
  const { observe } = await import("@flue/runtime");
  let pending = Promise.resolve();
  const unsubscribe = observe((event) => {
    if (event.type !== "text_delta" || event.instanceId !== agentId || typeof event.text !== "string") {
      return;
    }

    pending = pending.then(() => onTextDelta(event.text)).catch((error) => {
      console.warn(`Unable to handle response text delta: ${summarizeDeltaError(error)}`);
    });
  });

  return {
    async close() {
      unsubscribe();
      await pending;
    }
  };
}

function summarizeDeltaError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isPromptResult(input: unknown): input is { text: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "text" in input &&
    typeof (input as { text?: unknown }).text === "string"
  );
}

function selectSlackModel(messages: NoboModelMessage[]) {
  if (containsImageInput(messages)) {
    return process.env.OPENCODE_GO_VISION_MODEL ?? DEFAULT_SLACK_VISION_MODEL;
  }

  return process.env.OPENCODE_GO_MODEL ?? DEFAULT_SLACK_TEXT_MODEL;
}

function containsImageInput(messages: NoboModelMessage[]) {
  return messages.some((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return false;
    }

    return message.content.some((part) => part.type === "image");
  });
}

function formatMemoryPrompt(memories: string[], currentUserId: string | undefined) {
  const currentUserLabel = currentUserId ? `Slack user ${currentUserId}` : "the current speaker";

  if (memories.length === 0) {
    return `The thread may contain messages from multiple human speakers.
Speaker labels in user messages matter.
Only treat stored memory as belonging to ${currentUserLabel}.`;
  }

  return `The thread may contain messages from multiple human speakers.
Speaker labels in user messages matter.

Known persistent memory for ${currentUserLabel}:
${memories.map((memory) => `- ${memory}`).join("\n")}

Use these memories only when relevant to ${currentUserLabel}.
Do not apply them to other speakers in the thread.
Do not invent new memories.
Do not mention this memory list unless it helps answer the user.`;
}

function normalizeSlackMrkdwn(input: string) {
  return input
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/`{3}(\w+)?\n([\s\S]*?)```/g, (_match, language: string | undefined, code: string) => {
      const prefix = language ? `${language}\n` : "";
      return `\`\`\`${prefix}${code.trimEnd()}\`\`\``;
    })
    .replace(/\n{3,}/g, "\n\n");
}

export const __testing = {
  formatCurrentTime,
  formatCurrentTimePrompt,
  normalizeSlackMrkdwn,
  selectSlackModel
};

export type NoboResponseOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export type { NoboModelMessage };
export { SYSTEM_PROMPT };
