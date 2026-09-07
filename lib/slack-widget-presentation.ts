import { refreshWidgetBlocks, type WidgetOrigin, type WidgetRecord } from "./slack-widgets.js";
import type { ChatUpdateArguments, WebClient } from "@slack/web-api";

export function validSlackResponseUrl(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname)
      && !url.username && !url.password && url.pathname.startsWith("/actions/");
  } catch { return false; }
}
export async function refreshWidgetMessage(client: WebClient, record: WidgetRecord, origin: WidgetOrigin | null) {
  if (!origin) return;
  const blocks = refreshWidgetBlocks(record, origin.blocks);
  if (origin.ephemeral) {
    if (!validSlackResponseUrl(origin.responseUrl)) return;
    const response = await fetch(origin.responseUrl!, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace_original: true, text: record.text, blocks }), signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Unable to refresh the private card.");
  } else if (origin.ts) {
    await client.chat.update({ channel: record.target.channelId, ts: origin.ts, text: record.text, blocks } as unknown as ChatUpdateArguments);
  }
}
