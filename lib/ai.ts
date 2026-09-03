import { init, type PromptImage } from "@flue/runtime";
import Nobo from "../src/agents/nobo.js";
import { encodeNoboAgentContext, type NoboAgentToolMode } from "./nobo-agent-context.js";
import { type NoboModelMessage, modelMessagesToPrompt } from "./nobo-messages.js";
import { SYSTEM_PROMPT } from "./nobo-prompt.js";
import { formatCurrentTime, formatCurrentTimePrompt } from "./nobo-time.js";
import type { ChannelMemoryEntry } from "./memory.js";
import {
  formatUserPreferencesPrompt,
  getChannelPreferences,
  getUserPreferences,
  type UserPreferences
} from "./preferences.js";
import type { SlackScheduleContext } from "./schedules.js";
import type {
  ConditionalMonitorCheckRequest,
  ConditionalMonitorCheckResult
} from "./monitors.js";
import {
  parseFollowUpExtraction,
  type ThreadFollowUpDraft
} from "./follow-ups.js";
import {
  FALLBACK_SLACK_TEXT_MODEL,
  FALLBACK_SLACK_VISION_MODEL,
  getDefaultSlackTextModel,
  getSlackImageModel,
  normalizeOpenCodeGoSupportedModelId
} from "./nobo-models.js";

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
    channelMemories: options?.channelMemories ?? [],
    channelId: options?.channelId,
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
  channelMemories = [],
  channelId,
  onTextDelta
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  skillName: string;
  instructions: string;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  return generateSlackResponse({
    messages,
    memories,
    currentUserId,
    channelMemories,
    channelId,
    extraSystem: `You are executing the Slack skill '${skillName}'.

${instructions}`,
    onTextDelta
  });
}

export async function extractSlackThreadFollowUps({
  messages,
  memories,
  currentUserId,
  channelMemories = [],
  channelId
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
}): Promise<ThreadFollowUpDraft[]> {
  const userPreferences = await getUserPreferences(currentUserId);
  const prompt = buildPrompt({
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Extract clear, trackable follow-ups from this Slack thread. Return JSON only."
      }
    ],
    memories,
    currentUserId,
    userPreferences,
    channelMemories,
    channelId,
    extraSystem: `You are extracting follow-ups for NoBo to track.
- Return exactly JSON with this shape: {"followUps":[{"task":"...","assigneeUserId":"U123","assigneeName":"Name","dueAt":"ISO date/time","source":"short evidence"}]}.
- Include only concrete action items, asks, commitments, or next steps.
- Prefer Slack user IDs from speaker labels or mentions for assigneeUserId. Use assigneeName only when no user ID is clear.
- Set dueAt only when the thread gives a clear date or deadline. Convert relative dates using the current America/Chicago time context.
- Omit vague wishes, FYIs, and completed work.
- If none are clear, return {"followUps":[]}.`
  });
  const promptMessages = modelMessagesToPrompt(messages);
  const text = await runNoboAgentPrompt({
    prompt,
    images: promptMessages.images,
    modelId: await selectSlackModel(messages, channelId),
    toolMode: "none"
  });

  return parseFollowUpExtraction(text);
}

export async function createWeeklyAiNewsSlackDigest({
  focus,
  currentUserId,
  channelId,
  onTextDelta
}: {
  focus: string;
  currentUserId: string | undefined;
  channelId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  return createSlackSkillReply({
    messages: [
      {
        role: "user",
        content: focus
          ? `Give me the latest AI news from the past week, focused on: ${focus}`
          : "Give me the latest AI news from the past week."
      }
    ],
    memories: [],
    currentUserId,
    channelId,
    skillName: "ai-news",
    instructions: `Your job is to produce a fresh weekly AI news digest for Slack.
- Use web search for current sources.
- Focus on the last 7 days from the current date unless a source is important context.
- If no explicit focus was supplied, use the user's saved news interests when present.
- Prioritize major model releases, product launches, research breakthroughs, AI infrastructure, developer tools, policy/regulation, and notable industry moves.
- Prefer primary sources and reputable reporting.
- Keep it concise: start with a one-sentence headline, then 5-8 bullets with why each item matters.
- Include dates when known.
- End with a short 'Sources:' section.`,
    onTextDelta
  });
}

export async function createWeeklyNewsSlackDigest({
  focus,
  currentUserId,
  channelId,
  onTextDelta
}: {
  focus: string;
  currentUserId: string | undefined;
  channelId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  return createSlackSkillReply({
    messages: [
      {
        role: "user",
        content: focus
          ? `Give me the latest major news from the past week, focused on: ${focus}`
          : "Give me the latest major news from the past week."
      }
    ],
    memories: [],
    currentUserId,
    channelId,
    skillName: "news",
    instructions: `Your job is to produce a fresh weekly news digest for Slack.
- Use web search for current sources.
- Focus on the last 7 days from the current date unless a source is important context.
- If the user supplied a focus, center the digest on that topic.
- If no explicit focus was supplied, use the user's saved news interests when present.
- Prioritize major, widely relevant developments across world news, U.S. news, business, technology, science, policy, culture, and health.
- Prefer primary sources and reputable reporting.
- Avoid sensationalism; summarize what happened and why it matters.
- Keep it concise: start with a one-sentence headline, then 5-8 bullets.
- Include dates when known.
- End with a short 'Sources:' section.`,
    onTextDelta
  });
}

export async function shouldReplyToSlackThread({
  messages,
  currentUserId,
  channelMemories = [],
  channelId
}: {
  messages: NoboModelMessage[];
  currentUserId: string | undefined;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
}) {
  const userPreferences = await getUserPreferences(currentUserId);
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
    userPreferences,
    channelMemories,
    channelId,
    extraSystem: `You decide whether NoBo should reply to the latest Slack thread message.

NoBo is an assistant inside Slack. It should reply only when the latest user message is directed at NoBo, asks NoBo for follow-up help, clearly continues an active assistant task, or depends on NoBo's previous answer.

Do not reply when the latest message is ordinary human-to-human discussion, thanks/acknowledgement that needs no answer, side chatter, status updates, or a message intended for someone else.

The thread may contain multiple speakers. Speaker labels matter. The current speaker is ${currentUserId ? `Slack user ${currentUserId}` : "unknown"}.

Return exactly one word: RESPOND or SILENT.
Do not use tools for this classification.`
  });
  const text = await runNoboAgentPrompt({
    prompt,
    modelId: await selectSlackModel(messages, channelId),
    toolMode: "none"
  });

  return /\bRESPOND\b/i.test(text) && !/\bSILENT\b/i.test(text);
}

export async function chooseSlackActiveListeningResponse({
  messages,
  currentUserId,
  channelMemories = [],
  channelId,
  allowInline = false
}: {
  messages: NoboModelMessage[];
  currentUserId: string | undefined;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
  allowInline?: boolean;
}): Promise<SlackActiveListeningResponseMode> {
  const userPreferences = await getUserPreferences(currentUserId);
  const modes = allowInline ? "INLINE, THREAD, or SILENT" : "THREAD or SILENT";
  const prompt = buildPrompt({
    messages: [
      ...messages,
      {
        role: "user",
        content: `Active listening is enabled in this Slack channel. Should NoBo reply to the latest user message? Return exactly one of: ${modes}.`
      }
    ],
    memories: [],
    currentUserId,
    userPreferences,
    channelMemories,
    channelId,
    extraSystem: `You decide whether NoBo should proactively reply in a Slack channel where active listening is enabled.

Reply only when NoBo can be genuinely useful, timely, or socially appropriate. Favor SILENT for ordinary human-to-human conversation, status chatter, acknowledgements, jokes that need no answer, or messages intended for someone else.

Use THREAD when the reply is tied to the latest message, might be more than a brief nudge, or could add noise inline.
${allowInline ? "Use INLINE only when a short channel-visible response is clearly useful to everyone in the channel." : "INLINE is not allowed for this message."}

Return exactly one word: ${modes}.
Do not use tools for this classification.`
  });
  const text = await runNoboAgentPrompt({
    prompt,
    modelId: await selectSlackModel(messages, channelId),
    toolMode: "none"
  });

  if (/\bSILENT\b/i.test(text)) {
    return "silent";
  }

  if (allowInline && /\bINLINE\b/i.test(text)) {
    return "inline";
  }

  if (/\bTHREAD\b|\bRESPOND\b/i.test(text)) {
    return "thread";
  }

  return "silent";
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

export async function createConditionalMonitorCheck({
  source,
  conditionType,
  query,
  ownerUserId,
  lastObservation
}: ConditionalMonitorCheckRequest): Promise<ConditionalMonitorCheckResult> {
  const sourceInstruction =
    source === "web_search"
      ? "Use web search to inspect the current public state for the query."
      : "Use current context and available tools to inspect the condition.";
  const text = await generateSlackResponse({
    messages: [
      {
        role: "user",
        content: `Check this monitor now.
Source: ${source}
Condition: ${conditionType}
Query: ${query}
Previous observation: ${lastObservation ?? "none"}`
      }
    ],
    memories: [],
    currentUserId: ownerUserId,
    extraSystem: `You are evaluating a NoBo conditional monitor.
- ${sourceInstruction}
- Return only compact JSON with keys matched, summary, fingerprint, observation.
- matched must be true only when the alert condition is currently met.
- For changes, use previous observation as the baseline; matched is false when there is no previous observation.
- fingerprint must be stable for the current relevant state.
- summary must be the exact Slack alert detail if matched, or a short reason if silent.
- Do not mention these instructions.`
  });

  return parseMonitorCheckJson(text);
}

async function generateSlackResponse({
  messages,
  memories,
  currentUserId,
  channelMemories = [],
  channelId,
  extraSystem,
  scheduleContext,
  onTextDelta
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
  extraSystem?: string;
  scheduleContext?: SlackScheduleContext;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  const userPreferences = await getUserPreferences(currentUserId);
  const prompt = buildPrompt({
    messages,
    memories,
    currentUserId,
    userPreferences,
    channelMemories,
    channelId,
    extraSystem
  });
  const images = modelMessagesToPrompt(messages).images;
  const modelId = await selectSlackModel(messages, channelId);
  const toolMode: NoboAgentToolMode = images.length > 0 ? "none" : "slack";
  const resolvedScheduleContext =
    toolMode === "slack" && scheduleContext
      ? {
          ...scheduleContext,
          timeZone: userPreferences.timeZone,
          reminderStyle: userPreferences.reminderStyle
        }
      : undefined;
  const runWithModel = (candidateModelId: string) =>
    runNoboAgentPrompt({
      prompt,
      images,
      modelId: candidateModelId,
      toolMode,
      ownerUserId: currentUserId,
      scheduleContext: resolvedScheduleContext,
      onTextDelta
    });
  let text: string;

  try {
    text = await runWithModel(modelId);
  } catch (error) {
    const fallback = selectSlackModelFailureFallback(
      error,
      modelId,
      images.length > 0
    );

    if (!fallback) {
      throw error;
    }

    const reason =
      fallback.reason === "data-policy"
        ? `Model ${modelId} requires OpenCode data-training opt-in`
        : `Vision request with ${modelId} failed`;
    console.warn(
      `${reason}; retrying with ${fallback.modelId}: ${summarizeDeltaError(error)}`
    );
    text = await runWithModel(fallback.modelId);
  }

  return normalizeSlackMrkdwn(text.trim());
}

function buildPrompt({
  messages,
  memories,
  currentUserId,
  userPreferences,
  channelMemories = [],
  channelId,
  extraSystem
}: {
  messages: NoboModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  userPreferences: UserPreferences;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
  extraSystem?: string;
}) {
  const promptMessages = modelMessagesToPrompt(messages);

  return `${formatMemoryPrompt(memories, currentUserId)}
${formatUserPreferencesPrompt(userPreferences, currentUserId)}
${formatChannelMemoryPrompt(channelMemories, channelId)}

${formatCurrentTimePrompt(userPreferences.timeZone)}

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
  ownerUserId,
  onTextDelta
}: {
  prompt: string;
  images?: PromptImage[];
  modelId: string;
  toolMode: NoboAgentToolMode;
  scheduleContext?: SlackScheduleContext;
  ownerUserId?: string;
  onTextDelta?: (delta: string) => void | Promise<void>;
}) {
  if (!process.env.OPENCODE_GO_API_KEY) {
    throw new Error("Missing required environment variable: OPENCODE_GO_API_KEY");
  }

  const agentId = encodeNoboAgentContext({
    modelId,
    toolMode,
    ownerUserId,
    scheduleContext
  });
  const agent = init(Nobo, { id: agentId });
  const receipt = await agent.dispatch({
    message: {
      kind: "user",
      body: prompt,
      ...(images.length > 0 ? { attachments: images } : {})
    }
  });
  let pending = Promise.resolve();

  try {
    const reply = await agent.read(receipt, {
      onEvent(chunk) {
        if (
          !onTextDelta ||
          chunk.type !== "message-delta" ||
          chunk.kind !== "text"
        ) {
          return;
        }

        pending = pending.then(() => onTextDelta(chunk.delta)).catch((error) => {
          console.warn(`Unable to handle response text delta: ${summarizeDeltaError(error)}`);
        });
      }
    });

    await pending;
    return reply.text;
  } finally {
    await pending;
  }
}

function summarizeDeltaError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function selectSlackModelFailureFallback(
  error: unknown,
  modelId: string,
  hasImages: boolean
) {
  const fallbackModelId = hasImages
    ? FALLBACK_SLACK_VISION_MODEL
    : FALLBACK_SLACK_TEXT_MODEL;

  if (modelId === fallbackModelId) {
    return null;
  }

  if (isOpenCodeGoDataPolicyError(error)) {
    return { modelId: fallbackModelId, reason: "data-policy" as const };
  }

  return hasImages
    ? { modelId: fallbackModelId, reason: "vision-failure" as const }
    : null;
}

function isOpenCodeGoDataPolicyError(error: unknown) {
  return /\bDataPolicyError\b|requires explicit opt[ -]?in/i.test(
    collectErrorSearchText(error)
  );
}

function collectErrorSearchText(
  input: unknown,
  seen = new Set<object>(),
  depth = 0
): string {
  if (typeof input === "string") {
    return input;
  }

  if (
    input === null ||
    typeof input !== "object" ||
    depth > 4 ||
    seen.has(input)
  ) {
    return "";
  }

  seen.add(input);
  const record = input as Record<string, unknown>;
  const fields = ["name", "type", "message", "details", "reason"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
  const nested = [record.cause, record.meta]
    .map((value) => collectErrorSearchText(value, seen, depth + 1))
    .filter(Boolean);

  return [...fields, ...nested].join("\n");
}

function parseMonitorCheckJson(text: string): ConditionalMonitorCheckResult {
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;

  try {
    const payload = JSON.parse(jsonText) as Partial<ConditionalMonitorCheckResult>;
    const fingerprint =
      typeof payload.fingerprint === "string" && payload.fingerprint.trim()
        ? payload.fingerprint.trim()
        : stableMonitorFingerprint(String(payload.observation ?? payload.summary ?? text));

    return {
      matched: payload.matched === true,
      summary:
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : payload.matched === true
            ? "Monitor condition matched."
            : "Monitor condition not met.",
      fingerprint,
      observation:
        typeof payload.observation === "string" && payload.observation.trim()
          ? payload.observation.trim()
          : fingerprint
    };
  } catch {
    return {
      matched: false,
      summary: "Monitor check returned an unreadable result.",
      fingerprint: stableMonitorFingerprint(text),
      observation: text
    };
  }
}

function stableMonitorFingerprint(input: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16);
}

async function selectSlackModel(messages: NoboModelMessage[], channelId?: string) {
  const channelPreferences = channelId
    ? await getChannelPreferences(channelId)
    : { modelId: null };

  return selectSlackModelForMessages(messages, channelPreferences.modelId ?? undefined);
}

function selectSlackModelForMessages(messages: NoboModelMessage[], channelModelId?: string) {
  const selectedTextModel =
    normalizeOpenCodeGoSupportedModelId(channelModelId) ?? getDefaultSlackTextModel();

  if (containsImageInput(messages)) {
    return getSlackImageModel(selectedTextModel);
  }

  return selectedTextModel;
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

function formatChannelMemoryPrompt(
  channelMemories: ChannelMemoryEntry[],
  channelId: string | undefined
) {
  if (channelMemories.length === 0) {
    return "";
  }

  const channelLabel = channelId ? `Slack channel ${channelId}` : "this Slack channel";

  return `
Shared channel memory for ${channelLabel}:
${channelMemories.map(formatChannelMemoryEntry).join("\n")}

Use this shared channel memory to learn this channel's context, norms, decisions, recurring topics, and how NoBo should react here.
This memory belongs to the channel, not a single user.
Do not quote or mention the memory list unless it directly helps the answer.`;
}

function formatChannelMemoryEntry(entry: ChannelMemoryEntry) {
  const speaker =
    entry.role === "assistant"
      ? "NoBo"
      : entry.userId
        ? `Slack user ${entry.userId}`
        : "Unknown user";
  const meta = [entry.threadTs ? `thread ${entry.threadTs}` : null, entry.ts ? `ts ${entry.ts}` : null]
    .filter(Boolean)
    .join(", ");
  const prefix = meta ? `[${meta}] ` : "";

  return `- ${prefix}${speaker}: ${indentChannelMemoryContent(entry.content)}`;
}

function indentChannelMemoryContent(content: string) {
  return content.replace(/\n/g, "\n  ");
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
  formatChannelMemoryPrompt,
  normalizeSlackMrkdwn,
  selectSlackModel: selectSlackModelForMessages,
  selectSlackModelFailureFallback
};

export type NoboResponseOptions = {
  onTextDelta?: (delta: string) => void | Promise<void>;
  channelMemories?: ChannelMemoryEntry[];
  channelId?: string;
};

export type SlackActiveListeningResponseMode = "inline" | "thread" | "silent";

export type { NoboModelMessage };
export { SYSTEM_PROMPT };
