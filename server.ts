import { config as loadEnv } from "dotenv";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { start } from "@flue/runtime/node";
import app from "./src/app.js";
import Nobo from "./src/agents/nobo.js";
import { registerNoboProvider } from "./src/nobo-provider.js";
import { createSlackBolt, SLACK_ENDPOINTS } from "./src/slack-bolt.js";
import { startBackgroundRunners } from "./src/slack-tasks.js";
import { requireEnv } from "./lib/env.js";

loadEnv({ path: ".env.local" });
loadEnv();
registerNoboProvider();
const runtime = await start({ agents: [Nobo], providers: [] });
const { bolt, receiver } = createSlackBolt({
  signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
  token: requireEnv("SLACK_BOT_TOKEN")
});
await bolt.init();
const handleHttp = getRequestListener(app.fetch);
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (SLACK_ENDPOINTS.includes(path)) {
    receiver.requestListener(request, response);
  } else {
    handleHttp(request, response);
  }
});
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => {
  console.log("NoBo listening with Slack Bolt");
  startBackgroundRunners();
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  server.close();
  await runtime.stop();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
