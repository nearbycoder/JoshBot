import { Hono } from "hono";
import { handleArtifactFetchRequest } from "../lib/artifacts.js";

const app = new Hono();
for (const path of ["/", "/healthz"]) {
  app.get(path, (c) => c.json({ ok: true, service: "nobo", status: "running", slack: "bolt" }));
}
app.all("/artifacts/*", async (c) => {
  const response = await handleArtifactFetchRequest(c.req.raw);
  return response ?? c.notFound();
});
export default app;
