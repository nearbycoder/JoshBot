import { WebClient, type ChatPostEphemeralArguments } from "@slack/web-api";
import { saveWidget, renderWidget, type WidgetApproval, type WidgetTarget, type WidgetStore, type WidgetBlock } from "./slack-widgets.js";

export async function queueWidgetApproval(target: WidgetTarget, approval: WidgetApproval, title: string, text: string,
  options: { store?: WidgetStore | null; publish?: (text: string, blocks: WidgetBlock[]) => Promise<unknown> } = {}) {
  if (text.length > 18000) throw new Error("This approval is too large. Split it into smaller requests.");
  const record = await saveWidget({ target, kind: "approval", title, text, approval }, options.store);
  if (!record) throw new Error("Approval storage is unavailable. Nothing was executed; please try again when Redis is available.");
  const publish = options.publish ?? ((text, blocks) => new WebClient(process.env.SLACK_BOT_TOKEN).chat.postEphemeral({
    channel: target.channelId, user: target.userId, thread_ts: target.threadTs || undefined, text, blocks
  } as unknown as ChatPostEphemeralArguments));
  await publish(title + "\n" + text, renderWidget(record));
  return record;
}
