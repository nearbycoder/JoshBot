import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { __testing, renderArtifactImage } from "../lib/artifact-images.js";

test("HTML preview renderer produces a bounded PNG without network requests or scripts", { timeout: 30000 }, async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("do not fetch"); }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const png = await __testing.render(`<style>body{background:#1b1b1b;color:white;font:40px sans-serif} .long{height:99999px}</style><h1>Preview</h1><img src="http://127.0.0.1:${port}/secret"><iframe src="http://127.0.0.1:${port}/frame"></iframe><script>location.href="http://127.0.0.1:${port}/script"</script><div class="long">No scripts or external assets</div>`);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 800); assert.ok(png.readUInt32BE(20) <= 1600);
    assert.equal(requests, 0);
  } finally { server.close(); server.closeAllConnections(); }
});
test("normal tests skip expensive previews and the kill switch returns no preview", async () => {
  assert.equal(await renderArtifactImage("<h1>Test</h1>"), undefined);
});
