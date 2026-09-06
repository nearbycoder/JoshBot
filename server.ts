import { config as loadEnv } from "dotenv";
import { startNoboServer } from "./src/server.js";
import { requireEnv } from "./lib/env.js";

loadEnv({ path: ".env.local" });
loadEnv();
const service = await startNoboServer({
  signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
  token: requireEnv("SLACK_BOT_TOKEN"),
  port: Number(process.env.PORT ?? 3000)
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  await service.stop();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
