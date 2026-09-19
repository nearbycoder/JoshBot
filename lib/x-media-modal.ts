import type { ViewsOpenArguments } from "@slack/web-api";
import { parseXPostId, type XMediaRequest, XMediaError } from "./x-media.js";

export const X_MEDIA_MODAL = "nobo_x_media";
type Target = Omit<XMediaRequest, "postId">;
type ModalView = Extract<ViewsOpenArguments["view"], { type: "modal" }>;

export function buildXMediaModal(target: Target): ModalView {
  return {
    type: "modal",
    callback_id: X_MEDIA_MODAL,
    private_metadata: JSON.stringify(target),
    title: { type: "plain_text", text: "Share media from X" },
    submit: { type: "plain_text", text: "Upload media" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Send a post’s photos or videos directly to <#${target.channelId}>, with a short summary when the post has text. No post card or source link.` } },
      { type: "input", block_id: "link", label: { type: "plain_text", text: "X post link" },
        element: { type: "plain_text_input", action_id: "url", focus_on_load: true, max_length: 2048,
          placeholder: { type: "plain_text", text: "https://x.com/user/status/…" } },
        hint: { type: "plain_text", text: "Paste a public X or Twitter post containing photos or videos." } },
      { type: "context", elements: [{ type: "plain_text", text: "Up to 4 files · 50 MiB each · 100 MiB total. Only share media you have permission to share." }] }
    ]
  };
}

/** Only accept context from this signed modal, bound to its originating user and workspace. */
export function parseXMediaSubmission(body: {
  user: { id: string }; team: { id: string } | null;
  view: { private_metadata: string; state: { values: Record<string, Record<string, { value?: string | null }>> } };
}): XMediaRequest {
  let target: Partial<Target> | null;
  try { target = JSON.parse(body.view.private_metadata); }
  catch { target = null; }
  if (!target || typeof target.channelId !== "string" || !/^[CGD][A-Z0-9]+$/.test(target.channelId) ||
      !target.userId || target.userId !== body.user.id || !target.teamId || target.teamId !== body.team?.id) {
    throw new XMediaError("This form’s channel or session is no longer valid. Close it and run /nobo-x again in the destination channel.");
  }
  return { channelId: target.channelId, userId: body.user.id, teamId: target.teamId,
    postId: parseXPostId(body.view.state.values.link?.url?.value ?? "") };
}

export function buildXMediaStatusModal(channelId: string, text: string, uploading = false): ModalView {
  return {
    type: "modal", callback_id: `${X_MEDIA_MODAL}_status`,
    title: { type: "plain_text", text: uploading ? "Uploading media…" : "X media upload" },
    close: { type: "plain_text", text: uploading ? "Close" : "Done" },
    blocks: [
      { type: "section", text: { type: "plain_text", text } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Destination: <#${channelId}>` }] },
      ...(uploading ? [{ type: "context" as const, elements: [{ type: "plain_text" as const,
        text: "You can close this window. The upload will continue in the background." }] }] : [])
    ]
  };
}
