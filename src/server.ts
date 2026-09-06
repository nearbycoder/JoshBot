import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { start } from "@flue/runtime/node";
import app from "./app.js";
import Nobo from "./agents/nobo.js";
import { registerNoboProvider } from "./nobo-provider.js";
import { createSlackBolt, SLACK_ENDPOINTS } from "./slack-bolt.js";
import { startBackgroundRunners } from "./slack-tasks.js";
import { checkSlackAgentReadiness } from "../lib/slack-readiness.js";

export async function startNoboServer(options: {
  signingSecret: string;
  token: string;
  port: number;
  host?: string;
  backgroundRunners?: boolean;
  clientOptions?: Parameters<typeof createSlackBolt>[0]["clientOptions"];
}) {
  registerNoboProvider();
  const runtime = await start({ agents: [Nobo], providers: [] });
  try {
    const { bolt, receiver } = createSlackBolt(options);
    await bolt.init();
    const readiness = await checkSlackAgentReadiness(bolt.client);
    console.log(`Slack Agent readiness: ${readiness.state}. ${readiness.detail}`);
    const handleHttp = getRequestListener(app.fetch);
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (SLACK_ENDPOINTS.includes(path)) {
        receiver.requestListener(request, response);
      } else {
        handleHttp(request, response);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    console.log("NoBo listening with Slack Bolt");
    if (options.backgroundRunners !== false) startBackgroundRunners();
    return {
      server,
      async stop() {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        await runtime.stop();
        await closed;
      }
    };
  } catch (error) {
    await runtime.stop();
    throw error;
  }
}
