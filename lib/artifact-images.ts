import { chromium as playwright, type Browser } from "playwright-core";
import chromium from "@sparticuz/chromium";

let pending = Promise.resolve();
let queued = 0;
/** Rasterize local HTML only. No scripts, network, service workers, downloads, or app secrets. */
export async function renderArtifactImage(html: string): Promise<Buffer | undefined> {
  if (process.env.ARTIFACT_IMAGE_PREVIEWS === "off" || process.env.NODE_TEST_CONTEXT) return;
  if (Buffer.byteLength(html) > 256000) return;
  if (queued >= 3) return;
  queued++;
  const result = pending.then(() => render(html));
  pending = result.then(() => {}, () => {});
  return result.catch((error) => { console.warn("Artifact image preview unavailable:", error instanceof Error ? error.name : "render error"); return undefined; }).finally(() => { queued--; });
}
async function render(html: string) {
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const executablePath = await chromium.executablePath();
    browser = await playwright.launch({ executablePath, args: safeChromiumArgs(), headless: true, timeout: 10000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? "",
        FONTCONFIG_PATH: process.env.FONTCONFIG_PATH ?? "/tmp/fonts" } });
    timer = setTimeout(() => { void browser?.close(); }, 10000);
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false,
      viewport: { width: 800, height: 900 }, deviceScaleFactor: 1 });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
    await page.setContent(csp + html, { waitUntil: "domcontentloaded", timeout: 5000 });
    // Clip unusually tall documents; never allocate an unbounded full-page bitmap.
    const height = await page.evaluate(() => Math.min(1600, Math.max(200,
      document.body.scrollHeight, Math.ceil(document.body.getBoundingClientRect().bottom))));
    await page.setViewportSize({ width: 800, height });
    return await page.screenshot({ type: "png", animations: "disabled", timeout: 5000 });
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

// The serverless defaults disable web security and renderer isolation. Neither is
// needed for a local static preview; keep browser security checks enabled.
export function safeChromiumArgs() {
  return chromium.args.filter((arg) => !["--disable-web-security", "--allow-running-insecure-content", "--disable-site-isolation-trials", "--single-process"].includes(arg)
    && !arg.startsWith("--disable-features="));
}
export const __testing = { render };
