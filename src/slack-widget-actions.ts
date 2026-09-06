import type { App } from "@slack/bolt";
import { loadWidget, plain, saveWidgetFeedback } from "../lib/slack-widgets.js";
import { recordOpsError, summarizeOpsError } from "../lib/ops-errors.js";

export function registerSlackWidgetActions(bolt: App) {
  bolt.action(/^nobo_widget_/, async ({ ack, body, action, client }) => {
    await ack();
    if (!("action_id" in action) || action.action_id === "nobo_widget_open") return;
    const channelId = "channel" in body ? body.channel?.id : undefined;
    const teamId = body.team?.id;
    if (!channelId || !teamId) return;
    const tell = (text: string) => client.chat.postEphemeral({ channel: channelId, user: body.user.id, text });
    try {
      const raw = "value" in action && typeof action.value === "string" ? action.value : "";
      const [id, rating] = raw.split(":");
      const record = await loadWidget(id ?? "", { channelId, teamId, userId: body.user.id });
      if (action.action_id === "nobo_widget_feedback") {
        if (rating !== "good" && rating !== "bad") throw new Error("Invalid feedback.");
        await saveWidgetFeedback(record, rating);
        await tell("Thanks — your feedback was saved.");
      } else if (action.action_id === "nobo_widget_feedback_detail" && "trigger_id" in body) {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: "modal", callback_id: "nobo_widget_feedback_modal",
            private_metadata: JSON.stringify({ id, channelId }),
            title: plain("Response feedback"), submit: plain("Save"), close: plain("Cancel"),
            blocks: [
              { type: "input", block_id: "rating", label: plain("Was this helpful?"),
                element: { type: "static_select", action_id: "value", options: [
                  { text: plain("Helpful"), value: "good" }, { text: plain("Not helpful"), value: "bad" }
                ] } },
              { type: "input", block_id: "detail", label: plain("What could be better?"), optional: true,
                element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2000 } }
            ]
          }
        });
      } else await tell("This action is not available yet.");
    } catch (error) {
      recordOpsError("widget action", error);
      await tell(summarizeOpsError(error));
    }
  });
  bolt.view("nobo_widget_feedback_modal", async ({ ack, body, view, client }) => {
    const rating = view.state.values.rating?.value?.selected_option?.value;
    if (rating !== "good" && rating !== "bad") {
      await ack({ response_action: "errors", errors: { rating: "Choose a rating." } });
      return;
    }
    await ack();
    try {
      const meta = JSON.parse(view.private_metadata) as { id: string; channelId: string };
      if (!body.team?.id) return;
      const record = await loadWidget(meta.id, { channelId: meta.channelId, teamId: body.team.id, userId: body.user.id });
      await saveWidgetFeedback(record, rating, view.state.values.detail?.value?.value ?? "");
      await client.chat.postEphemeral({ channel: record.target.channelId, user: body.user.id, text: "Feedback saved. Thank you." });
    } catch (error) { recordOpsError("widget feedback", error); }
  });
}
