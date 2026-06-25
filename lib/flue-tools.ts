import { defineTool } from "@flue/runtime";
import { Exa } from "exa-js";
import {
  createArtifact,
  deleteArtifact,
  deleteExpiredArtifacts,
  diffArtifactVersion,
  listArtifactVersions,
  listArtifacts,
  rollbackArtifact,
  updateArtifact
} from "./artifacts.js";
import { fetchSlackChannelHistory } from "./channel-history.js";
import { formatCurrentTime } from "./nobo-time.js";
import {
  assertSlackTargetChannelAllowed,
  resolveSlackTargetChannel
} from "./slack-targets.js";
import {
  cancelMonitorFromTool,
  createMonitorFromTool,
  listMonitorsFromTool,
  type MonitorToolInput
} from "./monitors.js";
import {
  cancelScheduleFromTool,
  createScheduleFromTool,
  listSchedulesFromTool,
  updateScheduleFromTool,
  type ScheduleToolInput,
  type SlackScheduleContext
} from "./schedules.js";

const jsonSchema = (schema: Record<string, unknown>) => schema as never;

export function createNoboTools(scheduleContext?: SlackScheduleContext, ownerUserId?: string) {
  const artifactOwnerUserId = scheduleContext?.ownerUserId ?? ownerUserId;

  return [
    ...(process.env.EXA_API_KEY ? [createExaSearchTool()] : []),
    createCurrentTimeTool(scheduleContext?.timeZone),
    createArtifactTool(artifactOwnerUserId),
    createListArtifactsTool(artifactOwnerUserId),
    createUpdateArtifactTool(artifactOwnerUserId),
    createListArtifactVersionsTool(artifactOwnerUserId),
    createDiffArtifactVersionTool(artifactOwnerUserId),
    createRollbackArtifactTool(artifactOwnerUserId),
    createDeleteArtifactTool(artifactOwnerUserId),
    createCleanupExpiredArtifactsTool(artifactOwnerUserId),
    ...(scheduleContext ? createSlackContextTools(scheduleContext) : [])
  ];
}

function createCurrentTimeTool(defaultTimeZone = "America/Chicago") {
  return defineTool({
    name: "get_current_time",
    description:
      "Get the current date and time. Use for questions about the current time or for grounding relative dates and schedules.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        timeZone: {
          type: "string",
          description: "IANA timezone name. Defaults to the user's preferred timezone, or America/Chicago."
        }
      },
      additionalProperties: false
    }),
    execute: async (args: { timeZone?: string }) =>
      JSON.stringify(formatCurrentTime(args.timeZone || defaultTimeZone))
  });
}

function createArtifactTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "create_artifact",
    description:
      "Create a browser-previewable artifact file. Use for standalone HTML pages and Markdown documents that should be linked back to the user.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        kind: {
          enum: ["html", "markdown"],
          description: "Use html for complete HTML documents. Use markdown for .md documents."
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Short human-readable title for the artifact."
        },
        filename: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Optional filename. The extension is normalized based on kind."
        },
        content: {
          type: "string",
          minLength: 1,
          description: "The complete file content to write. HTML artifacts should be complete documents."
        },
        expiresInDays: {
          anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", pattern: "^\\d+(\\.\\d+)?$" }],
          description:
            "Optional expiration in days. If omitted, ARTIFACT_TTL_DAYS is used when configured."
        },
        expiresAt: {
          type: "string",
          description: "Optional ISO timestamp or parseable date for expiration. Do not combine with expiresInDays."
        }
      },
      required: ["kind", "title", "content"],
      additionalProperties: false
    }),
    execute: async (args: {
      kind: "html" | "markdown";
      title: string;
      filename?: string;
      content: string;
      expiresInDays?: number | string;
      expiresAt?: string;
    }) => {
      if (!ownerUserId) {
        return JSON.stringify({ error: "Artifact creation needs a Slack user context." });
      }

      const artifact = await createArtifact({ ...args, ownerUserId });

      return JSON.stringify({
        id: artifact.id,
        title: artifact.title,
        filename: artifact.filename,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt ?? artifact.createdAt,
        expiresAt: artifact.expiresAt ?? null,
        previewUrl: artifact.previewUrl,
        rawUrl: artifact.rawUrl
      });
    }
  });
}

function createListArtifactsTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "list_artifacts",
    description: "List generated artifacts, including preview links and expiration metadata.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        includeExpired: {
          type: "boolean",
          description: "Set true to include expired artifacts. Defaults to false."
        },
        limit: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "string", pattern: "^\\d+$" }],
          description: "Maximum artifacts to return. Defaults to 10."
        }
      },
      additionalProperties: false
    }),
    execute: async (args: { includeExpired?: boolean; limit?: number | string }) => {
      if (!ownerUserId) {
        return JSON.stringify({ error: "Artifact listing needs a Slack user context." });
      }

      const limit = parseOptionalPositiveInteger(args.limit, 10);
      const artifacts = await listArtifacts({
        includeExpired: args.includeExpired === true,
        limit,
        ownerUserId
      });

      return JSON.stringify({
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          shortId: artifact.shortId,
          title: artifact.title,
          kind: artifact.kind,
          filename: artifact.filename,
          bytes: artifact.bytes,
          createdAt: artifact.createdAt,
          expiresAt: artifact.expiresAt ?? null,
          expired: artifact.expired,
          previewUrl: artifact.previewUrl,
          rawUrl: artifact.rawUrl
        }))
      });
    }
  });
}

function createUpdateArtifactTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "update_artifact",
    description: "Update an existing generated artifact owned by the current Slack user.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 4,
          description: "Artifact UUID or visible prefix, e.g. abc12345."
        },
        kind: {
          enum: ["html", "markdown"],
          description: "Optional replacement kind. Defaults to the existing artifact kind."
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Optional replacement title."
        },
        filename: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Optional replacement filename."
        },
        content: {
          type: "string",
          minLength: 1,
          description: "The complete replacement file content."
        },
        expiresInDays: {
          anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", pattern: "^\\d+(\\.\\d+)?$" }],
          description: "Optional replacement expiration in days."
        },
        expiresAt: {
          type: "string",
          description: "Optional replacement ISO timestamp or parseable date for expiration."
        }
      },
      required: ["idPrefix", "content"],
      additionalProperties: false
    }),
    execute: async (args: {
      idPrefix: string;
      kind?: "html" | "markdown";
      title?: string;
      filename?: string;
      content: string;
      expiresInDays?: number | string;
      expiresAt?: string;
    }) => {
      const result = await updateArtifact({
        ...args,
        ownerUserId
      });

      return JSON.stringify(result);
    }
  });
}

function createListArtifactVersionsTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "list_artifact_versions",
    description: "List retained prior versions for an artifact owned by the current Slack user.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 4,
          description: "Artifact UUID or visible prefix, e.g. abc12345."
        }
      },
      required: ["idPrefix"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string }) => JSON.stringify(
      await listArtifactVersions(args.idPrefix, { ownerUserId })
    )
  });
}

function createDiffArtifactVersionTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "diff_artifact_version",
    description: "Compare a retained artifact version with the current artifact content.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 4,
          description: "Artifact UUID or visible prefix, e.g. abc12345."
        },
        versionId: {
          type: "string",
          description: "Optional retained version ID, e.g. v1. Defaults to the latest retained version."
        }
      },
      required: ["idPrefix"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string; versionId?: string }) => JSON.stringify(
      await diffArtifactVersion(args.idPrefix, args.versionId, { ownerUserId })
    )
  });
}

function createRollbackArtifactTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "rollback_artifact",
    description: "Restore an artifact to a retained prior version.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 4,
          description: "Artifact UUID or visible prefix, e.g. abc12345."
        },
        versionId: {
          type: "string",
          description: "Optional retained version ID, e.g. v1. Defaults to the latest retained version."
        }
      },
      required: ["idPrefix"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string; versionId?: string }) => JSON.stringify(
      await rollbackArtifact(args.idPrefix, args.versionId, { ownerUserId })
    )
  });
}

function createDeleteArtifactTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "delete_artifact",
    description: "Delete a generated artifact by UUID or visible short ID prefix.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 4,
          description: "Artifact UUID or visible prefix, e.g. abc12345."
        }
      },
      required: ["idPrefix"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string }) => {
      const result = await deleteArtifact(args.idPrefix, { ownerUserId });

      return JSON.stringify(result);
    }
  });
}

function createCleanupExpiredArtifactsTool(ownerUserId: string | undefined) {
  return defineTool({
    name: "cleanup_expired_artifacts",
    description: "Delete generated artifacts whose expiration timestamp is in the past.",
    parameters: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false
    }),
    execute: async () => {
      if (!ownerUserId) {
        return JSON.stringify({ error: "Artifact cleanup needs a Slack user context." });
      }

      const result = await deleteExpiredArtifacts({ ownerUserId });

      return JSON.stringify({
        deleted: result.deleted.map((artifact) => ({
          id: artifact.id,
          shortId: artifact.shortId,
          title: artifact.title
        }))
      });
    }
  });
}

function createSlackContextTools(scheduleContext: SlackScheduleContext) {
  return [
    createScheduleTool(scheduleContext),
    createListSchedulesTool(scheduleContext),
    createCancelScheduleTool(scheduleContext),
    createUpdateScheduleTool(scheduleContext),
    createMonitorTool(scheduleContext),
    createListMonitorsTool(scheduleContext),
    createCancelMonitorTool(scheduleContext),
    createSlackChannelHistoryTool(scheduleContext)
  ];
}

function createSlackChannelHistoryTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "read_slack_channel_history",
    description:
      `Read recent Slack channel messages for summarization or analysis. Use when the user asks about messages/history in a channel. Raw channel mentions available in this request: ${JSON.stringify(scheduleContext.mentionedChannels)}.`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description:
            "Slack channel ID, such as C123ABC. If omitted and exactly one channel was mentioned, that channel is used."
        },
        days: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "string", pattern: "^\\d+$" }],
          description: "How many days back to read. Defaults to 7."
        },
        limit: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "string", pattern: "^\\d+$" }],
          description: "Maximum number of messages to read. Defaults to 150, max 250."
        }
      },
      additionalProperties: false
    }),
    execute: async (args: { channelId?: string; days?: number | string; limit?: number | string }) => {
      const targetChannel = resolveMentionedChannel(scheduleContext, args.channelId);

      if (!targetChannel) {
        return JSON.stringify({
          error:
            "I couldn't determine which channel to read. Ask again with a channel mention, like #ai."
        });
      }

      await assertSlackTargetChannelAllowed({
        userId: scheduleContext.ownerUserId,
        channelId: targetChannel.id,
        action: "read_slack_channel_history",
        surface: "slack-tool"
      });

      const parsedDays = parseOptionalPositiveInteger(args.days, 7);
      const parsedLimit = parseOptionalPositiveInteger(args.limit, 150);
      const messages = await fetchSlackChannelHistory({
        channel: targetChannel.id,
        days: Math.min(parsedDays, 30),
        limit: Math.min(parsedLimit, 250)
      });

      return JSON.stringify({
        channel: targetChannel,
        days: parsedDays,
        messageCount: messages.length,
        messages
      });
    }
  });
}

function createScheduleTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "create_schedule",
    description:
      `Create a proactive Slack reminder or recurring cron-style message for the current Slack user. Use this for natural-language scheduling requests. If the user mentions a channel, set targetChannelId and targetChannelName from these raw Slack channel mentions when available: ${JSON.stringify(scheduleContext.mentionedChannels)}.`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        schedule: scheduleInputSchema()
      },
      required: ["schedule"],
      additionalProperties: false
    }),
    execute: async (args: { schedule: ScheduleToolInput }) => {
      const schedule = await createScheduleFromTool(scheduleContext, args.schedule);

      return JSON.stringify({
        id: schedule.id.slice(0, 8),
        fullId: schedule.id,
        summary: schedule.summary,
        nextRunAt: schedule.nextRunAt
      });
    }
  });
}

function createListSchedulesTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "list_schedules",
    description: "List active reminders and cron-style schedules owned by the current Slack user.",
    parameters: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false
    }),
    execute: async () =>
      JSON.stringify({
        result: await listSchedulesFromTool(scheduleContext)
      })
  });
}

function createCancelScheduleTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "cancel_schedule",
    description: "Cancel or delete an active reminder or cron-style schedule owned by the current Slack user.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 1,
          description: "The schedule ID or visible prefix, e.g. abc12345."
        }
      },
      required: ["idPrefix"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string }) =>
      JSON.stringify({
        result: await cancelScheduleFromTool(scheduleContext, args.idPrefix)
      })
  });
}

function createUpdateScheduleTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "update_schedule",
    description:
      "Update an existing reminder or cron-style schedule owned by the current Slack user. Provide the schedule ID prefix and the replacement schedule details.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 1,
          description: "The existing schedule ID or visible prefix, e.g. abc12345."
        },
        schedule: scheduleInputSchema()
      },
      required: ["idPrefix", "schedule"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string; schedule: ScheduleToolInput }) =>
      JSON.stringify({
        result: await updateScheduleFromTool(scheduleContext, args.idPrefix, args.schedule)
      })
  });
}

function createMonitorTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "create_monitor",
    description:
      `Create a recurring conditional monitor that posts only when its alert condition is met. Use for requests like "alert if X appears/changes/fails". If the user mentions a channel, set targetChannelId and targetChannelName from these raw Slack channel mentions when available: ${JSON.stringify(scheduleContext.mentionedChannels)}.`,
    parameters: jsonSchema({
      type: "object",
      properties: {
        monitor: monitorInputSchema()
      },
      required: ["monitor"],
      additionalProperties: false
    }),
    execute: async (args: { monitor: MonitorToolInput }) => {
      const monitor = await createMonitorFromTool(scheduleContext, args.monitor);

      return JSON.stringify({
        id: monitor.id.slice(0, 8),
        fullId: monitor.id,
        summary: monitor.summary,
        nextRunAt: monitor.nextRunAt
      });
    }
  });
}

function createListMonitorsTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "list_monitors",
    description: "List active conditional monitors owned by the current Slack user.",
    parameters: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false
    }),
    execute: async () =>
      JSON.stringify({
        result: await listMonitorsFromTool(scheduleContext)
      })
  });
}

function createCancelMonitorTool(scheduleContext: SlackScheduleContext) {
  return defineTool({
    name: "cancel_monitor",
    description: "Cancel or delete an active conditional monitor owned by the current Slack user.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        idPrefix: {
          type: "string",
          minLength: 1,
          description: "The monitor ID or visible prefix, e.g. abc12345."
        }
      },
      required: ["idPrefix"],
      additionalProperties: false
    }),
    execute: async (args: { idPrefix: string }) =>
      JSON.stringify({
        result: await cancelMonitorFromTool(scheduleContext, args.idPrefix)
      })
  });
}

function createExaSearchTool() {
  const apiKey = process.env.EXA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing required environment variable: EXA_API_KEY");
  }

  const exa = new Exa(apiKey);

  return defineTool({
    name: "web_search",
    description:
      "Search the web with Exa for recent or hard-to-recall facts. Prefer type='auto'. Use livecrawl only when you need the freshest content.",
    parameters: jsonSchema({
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "The web search query."
        },
        type: {
          enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"],
          description: "Exa search type. Default to auto unless latency or depth is important."
        },
        includeDomains: {
          type: "array",
          maxItems: 10,
          items: { type: "string" },
          description: "Optional domains to include, e.g. ['arxiv.org', 'github.com']."
        },
        excludeDomains: {
          type: "array",
          maxItems: 10,
          items: { type: "string" },
          description: "Optional domains to exclude."
        },
        livecrawl: {
          type: "boolean",
          description: "Set true only when you need the freshest page content."
        }
      },
      required: ["query"],
      additionalProperties: false
    }),
    execute: async (args: {
      query: string;
      type?: "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
      includeDomains?: string[];
      excludeDomains?: string[];
      livecrawl?: boolean;
    }) => {
      const response = await exa.search(args.query, {
        type: args.type ?? "auto",
        numResults: 5,
        includeDomains: args.includeDomains,
        excludeDomains: args.excludeDomains,
        contents: {
          highlights: true,
          ...(args.livecrawl ? { maxAgeHours: 0 } : {})
        }
      });

      return JSON.stringify({
        results: response.results.map((result) => ({
          title: result.title,
          url: result.url,
          publishedDate: result.publishedDate ?? null,
          author: result.author ?? null,
          highlights: (result.highlights ?? []).slice(0, 3)
        }))
      });
    }
  });
}

function scheduleInputSchema() {
  const responseMode = {
    enum: ["reminder", "prompt"],
    description:
      "Use reminder to send the task text later. Use prompt when NoBo should answer/research/do the task at run time, e.g. 'post what is trending on Hacker News'."
  };
  const targetChannelId = {
    type: "string",
    description: "Optional Slack channel ID to post into, such as C123ABC. Use only when the user mentions a channel."
  };
  const targetChannelName = {
    type: "string",
    description: "Optional visible channel name, without #."
  };
  const wholeNumber = {
    anyOf: [{ type: "integer" }, { type: "string", pattern: "^\\d+$" }],
    description: "A whole number. Numeric strings are accepted."
  };
  const baseProperties = {
    task: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description: "The reminder or prompt text to send later."
    },
    responseMode,
    targetChannelId,
    targetChannelName
  };

  return {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { const: "at", description: "A one-time reminder at a specific future ISO date/time." },
          ...baseProperties,
          runAt: {
            type: "string",
            minLength: 1,
            description: "Future ISO date/time for the reminder, e.g. 2026-06-25T18:00:00-05:00."
          }
        },
        required: ["kind", "task", "runAt"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          kind: { const: "once", description: "A one-time reminder after a delay." },
          ...baseProperties,
          amount: wholeNumber,
          unit: { enum: ["minutes", "hours", "days"], description: "Delay unit." }
        },
        required: ["kind", "task", "amount", "unit"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          kind: { const: "interval", description: "A recurring reminder every N minutes, hours, or days." },
          ...baseProperties,
          amount: wholeNumber,
          unit: { enum: ["minutes", "hours", "days"], description: "Repeat interval unit." }
        },
        required: ["kind", "task", "amount", "unit"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          kind: { const: "daily", description: "A recurring daily reminder in the user's preferred timezone." },
          ...baseProperties,
          hour: { ...wholeNumber, description: "24-hour clock hour in the user's preferred timezone, 0-23." },
          minute: { ...wholeNumber, description: "Minute in the user's preferred timezone, 0-59." }
        },
        required: ["kind", "task", "hour", "minute"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          kind: { const: "weekly", description: "A recurring weekly reminder in the user's preferred timezone." },
          ...baseProperties,
          weekday: {
            enum: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
          },
          hour: { ...wholeNumber, description: "24-hour clock hour in the user's preferred timezone, 0-23." },
          minute: { ...wholeNumber, description: "Minute in the user's preferred timezone, 0-59." }
        },
        required: ["kind", "task", "weekday", "hour", "minute"],
        additionalProperties: false
      }
    ]
  };
}

function monitorInputSchema() {
  const source = {
    enum: ["channel_history", "web_search", "prompt"],
    description:
      "Use channel_history for Slack channel appearances, web_search for public web changes, prompt for current checks such as status/failure conditions."
  };
  const conditionType = {
    enum: ["appears", "changes", "fails"],
    description: "The alert condition. Appears checks for a term, changes alerts after a changed baseline, fails checks failure/status conditions."
  };
  const targetChannelId = {
    type: "string",
    description: "Optional Slack channel ID to post into, such as C123ABC. Use only when the user mentions a channel."
  };
  const targetChannelName = {
    type: "string",
    description: "Optional visible channel name, without #."
  };
  const wholeNumber = {
    anyOf: [{ type: "integer" }, { type: "string", pattern: "^\\d+$" }],
    description: "A whole number. Numeric strings are accepted."
  };
  const baseProperties = {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description: "The thing to monitor, such as an error phrase, product name, URL, status page, or search query."
    },
    conditionType,
    source,
    targetChannelId,
    targetChannelName
  };

  return {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { const: "interval", description: "A recurring monitor every N minutes, hours, or days." },
          ...baseProperties,
          amount: wholeNumber,
          unit: { enum: ["minutes", "hours", "days"], description: "Repeat interval unit." }
        },
        required: ["kind", "query", "conditionType", "amount", "unit"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          kind: { const: "daily", description: "A recurring daily monitor in the user's preferred timezone." },
          ...baseProperties,
          hour: { ...wholeNumber, description: "24-hour clock hour in the user's preferred timezone, 0-23." },
          minute: { ...wholeNumber, description: "Minute in the user's preferred timezone, 0-59." }
        },
        required: ["kind", "query", "conditionType", "hour", "minute"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          kind: { const: "weekly", description: "A recurring weekly monitor in the user's preferred timezone." },
          ...baseProperties,
          weekday: {
            enum: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
          },
          hour: { ...wholeNumber, description: "24-hour clock hour in the user's preferred timezone, 0-23." },
          minute: { ...wholeNumber, description: "Minute in the user's preferred timezone, 0-59." }
        },
        required: ["kind", "query", "conditionType", "weekday", "hour", "minute"],
        additionalProperties: false
      }
    ]
  };
}

function resolveMentionedChannel(scheduleContext: SlackScheduleContext, channelId: string | undefined) {
  const resolution = resolveSlackTargetChannel(scheduleContext, { targetChannelId: channelId });

  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }

  return resolution.channel;
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
