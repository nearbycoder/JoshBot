import type { App } from "@slack/bolt";
import type { ChatPostMessageArguments, ChatPostEphemeralArguments } from "@slack/web-api";
import { loadWidget, plain, saveWidgetFeedback } from "../lib/slack-widgets.js";
import { recordOpsError, summarizeOpsError } from "../lib/ops-errors.js";
import { performWidgetAction, submitWidgetWorkflow, validateWidgetSubmission, type WidgetSubmission } from "../lib/slack-widget-workflows.js";

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
      } else await performWidgetAction(record, action.action_id.replace("nobo_widget_", ""), {
        tell,
        reply: (text, blocks) => client.chat.postMessage({ channel: channelId, thread_ts: record.target.threadTs || undefined, text,
          blocks } as unknown as ChatPostMessageArguments),
        privateCard: (text, blocks) => client.chat.postEphemeral({ channel: channelId, user: body.user.id, text, blocks } as unknown as ChatPostEphemeralArguments),
        postElsewhere: (destination, text) => client.chat.postMessage({ channel: destination, text }),
        open: (view) => {
          if (!("trigger_id" in body)) throw new Error("Reopen this action to continue.");
          return client.views.open({ trigger_id: body.trigger_id, view });
        }
      });
    } catch (error) {
      recordOpsError("widget action", error);
      await tell(summarizeOpsError(error));
    }
  });
  bolt.view("nobo_widget_workflow", async ({ ack, body, view, client }) => {
    let meta: { id: string; channelId: string; action: string };
    try { meta = JSON.parse(view.private_metadata); }
    catch { await ack(); return; }
    const submission: WidgetSubmission = {
      action: meta.action, text: view.state.values.text?.value?.value ?? "",
      channelId: view.state.values.channel?.value?.selected_conversation ?? undefined,
      target: view.state.values.target?.value?.selected_option?.value,
      when: (view.state.values.when?.value as { selected_date_time?: number } | undefined)?.selected_date_time
    };
    const errors = validateWidgetSubmission(submission);
    if (Object.keys(errors).length) { await ack({ response_action: "errors", errors }); return; }
    await ack();
    if (!body.team?.id) return;
    try {
      const record = await loadWidget(meta.id, { channelId: meta.channelId, teamId: body.team.id, userId: body.user.id });
      await submitWidgetWorkflow(record, submission, {
        tell: (text) => client.chat.postEphemeral({ channel: record.target.channelId, user: body.user.id, text }),
        reply: (text, blocks) => client.chat.postMessage({ channel: record.target.channelId,
          thread_ts: record.target.threadTs || undefined, text, blocks } as unknown as ChatPostMessageArguments),
        privateCard: (text, blocks) => client.chat.postEphemeral({ channel: record.target.channelId, user: body.user.id, text, blocks } as unknown as ChatPostEphemeralArguments),
        open: async () => { throw new Error("Reopen the card to continue."); }
      });
    } catch (error) {
      recordOpsError("widget workflow", error);
      await client.chat.postEphemeral({ channel: meta.channelId, user: body.user.id,
        text: summarizeOpsError(error) + " If an action was already submitted, check its destination before trying again." });
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
