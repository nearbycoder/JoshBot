import { App, HTTPReceiver, type AppOptions } from "@slack/bolt";
import type { ViewsOpenArguments } from "@slack/web-api";
import { getSlackRequestMaxBytes } from "../lib/request-body.js";
import { recordOpsError } from "../lib/ops-errors.js";
import {
  handleSlackInteractionRequest, handleSlackSlashCommandPayload,
  type SlackInteractionPayload, type SlackSlashCommandPayload
} from "../lib/slack-commands.js";
import { handleSlackEventCallbackPayload, type SlackEventCallbackPayload } from "../lib/slack-events.js";
import { formatSlackSlashCommandMemory, recordSlackSlashCommandExchange, runSlackSlashCommandTask } from "./slack-tasks.js";
import { registerSlackAgentEvents, buildSlackActiveContextHint } from "./slack-agent-events.js";
import { withSlackAgentRun, SlackAgentStoppedError } from "../lib/slack-agent-runs.js";

export const SLACK_ENDPOINTS = ["/api/slack/events", "/api/slack/commands", "/api/slack/interactions", "/slack/events"];
const defaultHandlers = {
  event: handleSlackEventCallbackPayload,
  command: handleSlackSlashCommandPayload,
  interaction: handleSlackInteractionRequest,
  task: runSlackSlashCommandTask,
  memory: recordSlackSlashCommandExchange
};

/** HTTPReceiver owns verification and parsing. Domain handlers own NoBo policy. */
export function createSlackBolt(options: {
  signingSecret: string;
  token?: string;
  authorize?: AppOptions["authorize"];
  bodyLimit?: number;
  handlers?: Partial<typeof defaultHandlers>;
}) {
  const handlers = { ...defaultHandlers, ...options.handlers };
  const receiver = new HTTPReceiver({
    signingSecret: options.signingSecret,
    endpoints: SLACK_ENDPOINTS,
    processBeforeResponse: false,
    bodyLimit: options.bodyLimit ?? getSlackRequestMaxBytes()
  });
  const bolt = new App({
    receiver, deferInitialization: true,
    ...(options.authorize ? { authorize: options.authorize } : { token: options.token })
  });
  bolt.error(async (error) => {
    recordOpsError("slack bolt", error);
    console.error("Slack Bolt handler failed:", error.message);
  });
  // Preserve the existing no-replay policy. Ack retries so Slack stops delivering them.
  bolt.use(async ({ context, ack, next }) => {
    if (context.retryNum !== undefined) {
      if (ack) await ack();
      return;
    }
    await next();
  });
  for (const type of ["app_mention", "message", "app_home_opened", "reaction_added"] as const) {
    bolt.event(type, async ({ body }) => {
      const payload = body as unknown as SlackEventCallbackPayload;
      const { event } = payload;
      if ((event.type === "app_mention" || event.type === "message") && payload.team_id &&
          typeof event.channel === "string" && typeof event.user === "string" && typeof event.ts === "string") {
        const hint = event.channel_type === "im"
          ? await buildSlackActiveContextHint(event.app_context, payload.team_id, event.user) : undefined;
        try {
          await withSlackAgentRun({
            teamId: payload.team_id, channelId: event.channel, userId: event.user,
            threadTs: typeof event.thread_ts === "string" ? event.thread_ts : event.ts
          }, () => handlers.event(payload), hint);
        } catch (error) {
          if (!(error instanceof SlackAgentStoppedError)) throw error;
        }
      } else await handlers.event(payload);
    });
  }
  registerSlackAgentEvents(bolt);
  bolt.command(/^\/nobo(?:-|$)/, async ({ command, ack, respond, client }) => {
    // Slow model lists/background jobs must not hold Slack's three-second acknowledgement.
    await ack();
    try {
      const payload = command as SlackSlashCommandPayload;
      const result = await handlers.command(payload);
      if (result.modal) {
        await client.views.open({ trigger_id: result.modal.triggerId, view: toBoltView(result.modal.view) });
      }
      await respond(result.response);
      if (result.task) {
        await handlers.task(result.task, formatSlackSlashCommandMemory(payload));
      } else if (result.response.response_type === "in_channel") {
        await handlers.memory(payload, result.response.text);
      }
    } catch (error) {
      recordOpsError("slack slash command", error);
      await respond({ response_type: "ephemeral", text: "NoBo could not complete that command. Please try again." });
    }
  });
  bolt.action(/.*/, async ({ body, ack, respond, client }) => {
    await ack();
    const result = await handlers.interaction(body as SlackInteractionPayload);
    if (result.modal) {
      await client.views.open({ trigger_id: result.modal.triggerId, view: toBoltView(result.modal.view) });
    }
    if ("text" in result.response) await respond(result.response);
  });
  bolt.shortcut(/.*/, async ({ body, ack, client, respond }) => {
    await ack();
    const result = await handlers.interaction(body as SlackInteractionPayload);
    if (result.modal) {
      await client.views.open({ trigger_id: result.modal.triggerId, view: toBoltView(result.modal.view) });
    } else if ("text" in result.response && "response_url" in body && body.response_url) {
      await respond(result.response);
    }
  });
  bolt.view({ callback_id: /.*/, type: "view_submission" }, async ({ body, ack }) => {
    // Validation errors and views.update must be returned in the acknowledgement itself.
    const result = await handlers.interaction(body as SlackInteractionPayload);
    if ("response_action" in result.response && result.response.response_action === "update") await ack({
      response_action: "update",
      view: toBoltView(result.response.view)
    });
    else await ack();
  });
  bolt.view({ callback_id: /.*/, type: "view_closed" }, async ({ ack }) => { await ack(); });
  return { bolt, receiver };
}

function toBoltView(view: Record<string, unknown>): ViewsOpenArguments["view"] {
  if (view.type !== "modal" || !view.title || !Array.isArray(view.blocks)) {
    throw new Error("Invalid NoBo modal view");
  }
  return view as unknown as ViewsOpenArguments["view"];
}
