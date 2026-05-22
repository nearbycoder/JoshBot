import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Exa } from "exa-js";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { createArtifact } from "./artifacts.js";
import { fetchSlackChannelHistory } from "./channel-history.js";
import {
  cancelScheduleFromTool,
  createScheduleFromTool,
  listSchedulesFromTool,
  updateScheduleFromTool,
  type ScheduleToolInput,
  type SlackScheduleContext
} from "./schedules.js";

const SYSTEM_PROMPT = `You are NoBo, a concise and pragmatic assistant.

You are replying inside Slack.

Rules:
- Be direct and helpful.
- Prefer short paragraphs or short flat lists.
- When the user asks for code, provide code that can be pasted directly.
- Do not claim to have done actions in Slack unless the app actually did them.
- If context is missing, make the smallest reasonable assumption and say so briefly.
- Use web search when the request depends on recent, fast-changing, or hard-to-recall facts.
- When web search is used, ground the answer in the retrieved sources instead of guessing.
- Use current time context for relative dates and schedule requests. Default timezone is America/Chicago unless the user specifies another timezone.
- When the user asks you to create a standalone HTML page, Markdown document, report, note, draft, or other file-like artifact, use the createArtifact tool and include its preview link in your Slack reply.
- NoBo can send proactive Slack reminders and recurring cron-style messages. When the user asks for a reminder, cron, recurring task, or scheduled proactive message, use the createSchedule tool. When the user asks to view, update, edit, delete, remove, or cancel schedules, use the schedule management tools. Do not say NoBo cannot read, update, or delete schedules.
- NoBo can summarize recent Slack channel history when the Slack app has channel history access. Use the readSlackChannelHistory tool when the user asks about messages in a channel.`;

function getModel(modelId: string) {
  const apiKey = process.env.OPENCODE_GO_API_KEY;

  if (!apiKey) {
    throw new Error("Missing required environment variable: OPENCODE_GO_API_KEY");
  }

  const provider = createOpenAICompatible({
    name: "opencode-go",
    apiKey,
    baseURL: "https://opencode.ai/zen/go/v1"
  });

  return provider(modelId);
}

export async function createSlackReply(messages: ModelMessage[]) {
  return createSlackReplyWithMemory(messages, [], undefined);
}

export async function createSlackReplyWithMemory(
  messages: ModelMessage[],
  memories: string[],
  currentUserId: string | undefined,
  scheduleContext?: SlackScheduleContext
) {
  return generateSlackResponse({
    messages,
    memories,
    currentUserId,
    scheduleContext
  });
}

export async function createSlackSkillReply({
  messages,
  memories,
  currentUserId,
  skillName,
  instructions
}: {
  messages: ModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  skillName: string;
  instructions: string;
}) {
  return generateSlackResponse({
    messages,
    memories,
    currentUserId,
    extraSystem: `You are executing the Slack skill '${skillName}'.

${instructions}`
  });
}

export async function shouldReplyToSlackThread({
  messages,
  currentUserId
}: {
  messages: ModelMessage[];
  currentUserId: string | undefined;
}) {
  const modelId = selectSlackModel(messages);
  const result = await generateText({
    model: getModel(modelId),
    system: `You decide whether NoBo should reply to the latest Slack thread message.

NoBo is an assistant inside Slack. It should reply only when the latest user message is directed at NoBo, asks NoBo for follow-up help, clearly continues an active assistant task, or depends on NoBo's previous answer.

Do not reply when the latest message is ordinary human-to-human discussion, thanks/acknowledgement that needs no answer, side chatter, status updates, or a message intended for someone else.

The thread may contain multiple speakers. Speaker labels matter. The current speaker is ${currentUserId ? `Slack user ${currentUserId}` : "unknown"}.

Return exactly one word: RESPOND or SILENT.`,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Should NoBo reply to the latest user message in this Slack thread? Return exactly RESPOND or SILENT."
      }
    ],
    stopWhen: stepCountIs(1)
  });

  return /\bRESPOND\b/i.test(result.text) && !/\bSILENT\b/i.test(result.text);
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
  scheduleContext
}: {
  messages: ModelMessage[];
  memories: string[];
  currentUserId: string | undefined;
  extraSystem?: string;
  scheduleContext?: SlackScheduleContext;
}) {
  const modelId = selectSlackModel(messages);
  const result = await generateText({
    model: getModel(modelId),
    system: `${SYSTEM_PROMPT}

${formatMemoryPrompt(memories, currentUserId)}

${formatCurrentTimePrompt()}

${extraSystem ? `\n\n${extraSystem}` : ""}

Extra Slack rules:
- Reply in plain text only.
- Keep formatting light.
- Aim for a response that fits naturally in a Slack thread.
- If the request is ambiguous, answer the likeliest interpretation instead of stalling.
- Use Slack mrkdwn, not standard Markdown.
- For bold, use *bold* and never **bold**.
- For links, use <https://example.com|label> and never [label](https://example.com).
- If you create a schedule, confirm the schedule briefly and include the schedule ID returned by the tool.
- If you use web search, end with a short 'Sources:' list using the URLs you relied on.`,
    messages,
    tools: createSlackTools(scheduleContext),
    stopWhen: stepCountIs(5)
  });

  return normalizeSlackMrkdwn(result.text.trim());
}

function createSlackTools(scheduleContext?: SlackScheduleContext) {
  return {
    ...(process.env.EXA_API_KEY ? { webSearch: createExaSearchTool() } : {}),
    ...(scheduleContext ? createSlackContextTools(scheduleContext) : {}),
    getCurrentTime: createCurrentTimeTool(),
    createArtifact: createArtifactTool()
  };
}

function createCurrentTimeTool() {
  return tool({
    description:
      "Get the current date and time. Use for questions about the current time or for grounding relative dates and schedules.",
    inputSchema: z.object({
      timeZone: z
        .string()
        .optional()
        .describe("IANA timezone name. Defaults to America/Chicago.")
    }),
    execute: async ({ timeZone }) => formatCurrentTime(timeZone || "America/Chicago")
  });
}

function createSlackContextTools(scheduleContext: SlackScheduleContext) {
  return {
    ...createScheduleTools(scheduleContext),
    readSlackChannelHistory: createSlackChannelHistoryTool(scheduleContext)
  };
}

function createSlackChannelHistoryTool(scheduleContext: SlackScheduleContext) {
  return tool({
    description:
      `Read recent Slack channel messages for summarization or analysis. Use when the user asks about messages/history in a channel. Raw channel mentions available in this request: ${JSON.stringify(scheduleContext.mentionedChannels)}.`,
    inputSchema: z.object({
      channelId: z
        .string()
        .optional()
        .describe("Slack channel ID, such as C123ABC. If omitted and exactly one channel was mentioned, that channel is used."),
      days: z
        .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
        .optional()
        .describe("How many days back to read. Defaults to 7."),
      limit: z
        .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
        .optional()
        .describe("Maximum number of messages to read. Defaults to 150, max 250.")
    }),
    execute: async ({ channelId, days, limit }) => {
      const targetChannel = resolveMentionedChannel(scheduleContext, channelId);

      if (!targetChannel) {
        return {
          error:
            "I couldn't determine which channel to read. Ask again with a channel mention, like #ai."
        };
      }

      const parsedDays = parseOptionalPositiveInteger(days, 7);
      const parsedLimit = parseOptionalPositiveInteger(limit, 150);
      const messages = await fetchSlackChannelHistory({
        channel: targetChannel.id,
        days: Math.min(parsedDays, 30),
        limit: Math.min(parsedLimit, 250)
      });

      return {
        channel: targetChannel,
        days: parsedDays,
        messageCount: messages.length,
        messages
      };
    }
  });
}

function createScheduleTools(scheduleContext: SlackScheduleContext) {
  const wholeNumber = z
    .union([z.number().int(), z.string().regex(/^\d+$/)])
    .describe("A whole number. Numeric strings are accepted.");
  const responseMode = z
    .enum(["reminder", "prompt"])
    .optional()
    .describe(
      "Use reminder to send the task text later. Use prompt when NoBo should answer/research/do the task at run time, e.g. 'post what is trending on Hacker News'."
    );
  const targetChannelId = z
    .string()
    .optional()
    .describe("Optional Slack channel ID to post into, such as C123ABC. Use only when the user mentions a channel.");
  const targetChannelName = z.string().optional().describe("Optional visible channel name, without #.");
  const scheduleInputSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("once").describe("A one-time reminder after a delay."),
      task: z.string().min(1).max(1000).describe("The reminder text to send later."),
      amount: wholeNumber.describe("Delay amount."),
      unit: z.enum(["minutes", "hours", "days"]).describe("Delay unit."),
      responseMode,
      targetChannelId,
      targetChannelName
    }),
    z.object({
      kind: z.literal("interval").describe("A recurring reminder every N minutes, hours, or days."),
      task: z.string().min(1).max(1000).describe("The message to send each time."),
      amount: wholeNumber.describe("Repeat interval amount."),
      unit: z.enum(["minutes", "hours", "days"]).describe("Repeat interval unit."),
      responseMode,
      targetChannelId,
      targetChannelName
    }),
    z.object({
      kind: z.literal("daily").describe("A recurring daily reminder in America/Chicago time."),
      task: z.string().min(1).max(1000).describe("The message to send each day."),
      hour: wholeNumber.describe("24-hour clock hour in America/Chicago time, 0-23."),
      minute: wholeNumber.describe("Minute in America/Chicago time, 0-59."),
      responseMode,
      targetChannelId,
      targetChannelName
    }),
    z.object({
      kind: z.literal("weekly").describe("A recurring weekly reminder in America/Chicago time."),
      task: z.string().min(1).max(1000).describe("The message to send each week."),
      weekday: z.enum([
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday"
      ]),
      hour: wholeNumber.describe("24-hour clock hour in America/Chicago time, 0-23."),
      minute: wholeNumber.describe("Minute in America/Chicago time, 0-59."),
      responseMode,
      targetChannelId,
      targetChannelName
    })
  ]);

  return {
    createSchedule: tool({
      description:
        `Create a proactive Slack reminder or recurring cron-style message for the current Slack user. Use this for natural-language scheduling requests. If the user mentions a channel, set targetChannelId and targetChannelName from these raw Slack channel mentions when available: ${JSON.stringify(scheduleContext.mentionedChannels)}.`,
      inputSchema: scheduleInputSchema,
      execute: async (input) => {
        const schedule = await createScheduleFromTool(scheduleContext, input as ScheduleToolInput);

        return {
          id: schedule.id.slice(0, 8),
          fullId: schedule.id,
          summary: schedule.summary,
          nextRunAt: schedule.nextRunAt
        };
      }
    }),
    listSchedules: tool({
      description: "List active reminders and cron-style schedules owned by the current Slack user.",
      inputSchema: z.object({}),
      execute: async () => ({
        result: await listSchedulesFromTool(scheduleContext)
      })
    }),
    cancelSchedule: tool({
      description: "Cancel or delete an active reminder or cron-style schedule owned by the current Slack user.",
      inputSchema: z.object({
        idPrefix: z.string().min(1).describe("The schedule ID or visible prefix, e.g. abc12345.")
      }),
      execute: async ({ idPrefix }) => ({
        result: await cancelScheduleFromTool(scheduleContext, idPrefix)
      })
    }),
    updateSchedule: tool({
      description:
        "Update an existing reminder or cron-style schedule owned by the current Slack user. Provide the schedule ID prefix and the replacement schedule details.",
      inputSchema: z.object({
        idPrefix: z.string().min(1).describe("The existing schedule ID or visible prefix, e.g. abc12345."),
        schedule: scheduleInputSchema
      }),
      execute: async ({ idPrefix, schedule }) => ({
        result: await updateScheduleFromTool(scheduleContext, idPrefix, schedule as ScheduleToolInput)
      })
    })
  };
}

function createArtifactTool() {
  return tool({
    description:
      "Create a browser-previewable artifact file. Use for standalone HTML pages and Markdown documents that should be linked back to the user.",
    inputSchema: z.object({
      kind: z
        .enum(["html", "markdown"])
        .describe("Use html for complete HTML documents. Use markdown for .md documents."),
      title: z.string().min(1).max(120).describe("Short human-readable title for the artifact."),
      filename: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Optional filename. The extension is normalized based on kind."),
      content: z
        .string()
        .min(1)
        .describe("The complete file content to write. HTML artifacts should be complete documents.")
    }),
    execute: async ({ kind, title, filename, content }) => {
      const artifact = await createArtifact({ kind, title, filename, content });

      return {
        id: artifact.id,
        title: artifact.title,
        filename: artifact.filename,
        previewUrl: artifact.previewUrl,
        rawUrl: artifact.rawUrl
      };
    }
  });
}

function resolveMentionedChannel(scheduleContext: SlackScheduleContext, channelId: string | undefined) {
  const normalizedChannelId = normalizeSlackChannelId(channelId);

  if (normalizedChannelId) {
    const mentionedChannel = scheduleContext.mentionedChannels.find(
      (channel) => channel.id === normalizedChannelId
    );
    return {
      id: normalizedChannelId,
      name: mentionedChannel?.name
    };
  }

  if (scheduleContext.mentionedChannels.length === 1) {
    return scheduleContext.mentionedChannels[0] ?? null;
  }

  return null;
}

function normalizeSlackChannelId(input: string | undefined) {
  if (!input) {
    return null;
  }

  const match = input.trim().match(/#?([CGD][A-Z0-9]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function parseOptionalPositiveInteger(input: number | string | undefined, fallback: number) {
  if (input === undefined) {
    return fallback;
  }

  const value = typeof input === "string" ? Number(input.trim()) : input;

  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function formatCurrentTimePrompt() {
  const currentTime = formatCurrentTime("America/Chicago");

  return `Current time:
- UTC: ${currentTime.utc}
- America/Chicago: ${currentTime.local}
- Timezone: ${currentTime.timeZone}

Use this for relative phrases like now, today, tomorrow, yesterday, in 5 minutes, next Monday, and over the past week.`;
}

function formatCurrentTime(timeZone: string) {
  const now = new Date();

  try {
    return {
      iso: now.toISOString(),
      utc: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC"
      }).format(now),
      local: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone
      }).format(now),
      timeZone
    };
  } catch {
    return {
      iso: now.toISOString(),
      utc: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC"
      }).format(now),
      local: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "America/Chicago"
      }).format(now),
      timeZone: "America/Chicago"
    };
  }
}

function selectSlackModel(messages: ModelMessage[]) {
  if (containsImageInput(messages)) {
    return process.env.OPENCODE_GO_VISION_MODEL ?? "kimi-k2.6";
  }

  return process.env.OPENCODE_GO_MODEL ?? "kimi-k2.6";
}

function containsImageInput(messages: ModelMessage[]) {
  return messages.some((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return false;
    }

    return message.content.some(
      (part) => typeof part === "object" && part !== null && "type" in part && part.type === "image"
    );
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

function createExaSearchTool() {
  const apiKey = process.env.EXA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing required environment variable: EXA_API_KEY");
  }

  const exa = new Exa(apiKey);

  return tool({
    description:
      "Search the web with Exa for recent or hard-to-recall facts. Prefer type='auto'. Use livecrawl only when you need the freshest content.",
    inputSchema: z.object({
      query: z.string().min(1).describe("The web search query."),
      type: z
        .enum(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"])
        .optional()
        .describe("Exa search type. Default to auto unless latency or depth is important."),
      includeDomains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Optional domains to include, e.g. ['arxiv.org', 'github.com']."),
      excludeDomains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Optional domains to exclude."),
      livecrawl: z
        .boolean()
        .optional()
        .describe("Set true only when you need the freshest page content.")
    }),
    execute: async ({ query, type, includeDomains, excludeDomains, livecrawl }) => {
      const response = await exa.search(query, {
        type: type ?? "auto",
        numResults: 5,
        includeDomains,
        excludeDomains,
        contents: {
          highlights: true,
          ...(livecrawl ? { maxAgeHours: 0 } : {})
        }
      });

      return {
        results: response.results.map((result) => ({
          title: result.title,
          url: result.url,
          publishedDate: result.publishedDate ?? null,
          author: result.author ?? null,
          highlights: (result.highlights ?? []).slice(0, 3)
        }))
      };
    }
  });
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
  normalizeSlackMrkdwn
};
