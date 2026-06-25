import { config as loadEnv } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleArtifactRequest } from "./lib/artifacts.js";
import { createConditionalMonitorCheck, createScheduledSlackMessage } from "./lib/ai.js";
import { readLimitedNodeRequestBody, RequestBodyTooLargeError } from "./lib/request-body.js";
import {
  postGeneratedSlackMessage,
  postSlackMessage,
  verifySlackRequest
} from "./lib/slack.js";
import { handleSlackEventCallbackPayload, parseSlackPayload } from "./lib/slack-events.js";
import { startScheduleRunner } from "./lib/schedules.js";
import { startMonitorRunner } from "./lib/monitors.js";
import { startChannelDigestSubscriptionRunner } from "./lib/channel-digests.js";

loadEnv({ path: ".env.local" });
loadEnv();

const port = Number(process.env.PORT ?? "3000");

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname.startsWith("/artifacts/")) {
    const handled = await handleArtifactRequest(request, response, url);

    if (handled) {
      return;
    }
  }

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    sendJson(response, 200, {
      ok: true,
      service: "nobo",
      status: "running"
    });
    return;
  }

  if (
    method === "POST" &&
    (url.pathname === "/api/slack/events" || url.pathname === "/slack/events")
  ) {
    const rawBody = await readBody(request, response);

    if (rawBody === null) {
      return;
    }

    if (!verifySlackRequest(rawBody, request.headers)) {
      sendText(response, 401, "Invalid Slack signature");
      return;
    }

    const payload = parseSlackPayload(rawBody);

    if (payload.type === "url_verification") {
      sendText(response, 200, payload.challenge);
      return;
    }

    sendJson(response, 200, { ok: true });

    if (request.headers["x-slack-retry-num"]) {
      return;
    }

    if (payload.type === "event_callback") {
      void handleSlackEventCallbackPayload(payload).catch((error) => {
        console.error(`Slack event handling failed: ${summarizeError(error)}`);
      });
    }

    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
});

server.listen(port, () => {
  console.log(`NoBo listening on http://localhost:${port}`);
});

startScheduleRunner({
  postSlackMessage,
  runScheduledTask: createScheduledSlackMessage
});
startMonitorRunner({
  postSlackMessage,
  runMonitorCheck: createConditionalMonitorCheck
});
startChannelDigestSubscriptionRunner({
  postGeneratedSlackMessage
});

async function readBody(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>
) {
  try {
    return await readLimitedNodeRequestBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendText(response, 413, "Slack request body is too large.");
      return null;
    }

    throw error;
  }
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendText(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: string
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
