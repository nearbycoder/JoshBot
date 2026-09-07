import type { App } from "@slack/bolt";
import type { ViewsOpenArguments } from "@slack/web-api";
import { plain, textBlocks, escapeSlack, widgetButton, type WidgetBlock } from "../lib/slack-widgets.js";
import { getUserScheduleDashboardItems, getOwnedSchedule, cancelScheduleById, editOwnedSchedule } from "../lib/schedules.js";
import { listRecentArtifacts } from "../lib/artifacts.js";
import { getDefaultSlackTextModel, getDefaultSlackVisionModel, listOpenCodeGoModelDefinitions, normalizeOpenCodeGoSupportedModelId, supportsOpenCodeGoImageInput, requiresOpenCodeGoDataTrainingOptIn } from "../lib/nobo-models.js";
import { setChannelModelPreference, clearChannelModelPreference } from "../lib/preferences.js";
import { evaluateNoboAccess } from "../lib/access-controls.js";
import { assertSlackTargetChannelAllowed } from "../lib/slack-targets.js";
import { publishSlackAppHome } from "../lib/slack.js";
import { recordOpsError, summarizeOpsError } from "../lib/ops-errors.js";

const modal = (title: string, blocks: WidgetBlock[], extra: Record<string, unknown> = {}) =>
  ({ type: "modal", title: plain(title), close: plain("Close"), blocks, ...extra }) as unknown as ViewsOpenArguments["view"];
export function integrationStatus(env: NodeJS.ProcessEnv = process.env) {
  return [
    `GitHub issues: ${(env.NOBO_GITHUB_TOKEN ?? env.GITHUB_TOKEN) && (env.NOBO_GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY) ? "configured" : "needs API token and repository"}`,
    `Linear issues: ${(env.NOBO_LINEAR_API_KEY ?? env.LINEAR_API_KEY) && (env.NOBO_LINEAR_TEAM_ID ?? env.LINEAR_TEAM_ID) ? "configured" : "needs API key and team"}`,
    `Research: ${env.EXA_API_KEY ? "configured" : "needs Exa API key"}`,
    `Reminders and controls: ${env.REDIS_URL ? "configured" : "needs Redis"}`,
    "Configure integrations in Railway environment variables, not by pasting secrets into Slack."
  ].join("\n\n");
}
export function registerSlackHomeActions(bolt: App) {
  bolt.action(/^nobo_home_/, async ({ ack, action, body, client }) => {
    await ack();
    if (!("trigger_id" in body) || !("action_id" in action)) return;
    const access = await evaluateNoboAccess({ userId: body.user.id, teamId: body.team?.id, action: "home_tools", surface: "slack-home" });
    if (!access.allowed) return;
    // Open immediately; hydrate potentially slower sections after Slack has accepted the trigger.
    const opening = { trigger_id: body.trigger_id, view: modal("NoBo tools", textBlocks("Loading…")) };
    const opened = "view" in body && body.view?.type === "modal"
      ? await client.views.push(opening) : await client.views.open(opening);
    if (!opened.view?.id) return;
    const show = (view: ViewsOpenArguments["view"]) => client.views.update({ view_id: opened.view!.id!, view });
    try {
      const selected = "selected_option" in action ? action.selected_option?.value : undefined;
      const id = "value" in action ? action.value ?? "" : "";
      if (action.action_id === "nobo_home_cancel") {
        const schedule = await getOwnedSchedule(id, body.user.id);
        await assertSlackTargetChannelAllowed({ userId: body.user.id, channelId: schedule.channel, action: "cancel_schedule", surface: "slack-home" });
        await cancelScheduleById(id, body.user.id);
        await show(modal("Reminder cancelled", textBlocks("Future occurrences stopped. A delivery already in progress may still finish.")));
        await publishSlackAppHome(body.user.id);
      } else if (action.action_id === "nobo_home_edit") {
        const schedule = await getOwnedSchedule(id, body.user.id);
        await show(modal("Edit reminder", [
          { type: "input", block_id: "text", label: plain("Reminder text"), element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 1000, initial_value: schedule.task } },
          { type: "input", block_id: "when", label: plain("Next occurrence"), element: { type: "datetimepicker", action_id: "value", initial_date_time: Math.floor(new Date(schedule.nextRunAt).getTime() / 1000) } },
          ...textBlocks(`Timezone: ${escapeSlack(schedule.timezone)}. Cadence and destination stay unchanged.`)
        ], { callback_id: "nobo_home_edit_submit", private_metadata: id, submit: plain("Save") }));
      } else if (selected === "reminders") {
        const items = await getUserScheduleDashboardItems(body.user.id, 10);
        const blocks = items.flatMap((item) => [
          ...textBlocks(escapeSlack(item.summary) + "\nNext: " + escapeSlack(item.nextRunAt)),
          { type: "actions", elements: [
            { ...widgetButton("Edit", "unused", item.id), action_id: "nobo_home_edit" },
            { ...widgetButton("Cancel", "unused", item.id, "Cancel this reminder?"), action_id: "nobo_home_cancel" }
          ] }
        ]);
        await show(modal("My reminders", blocks.length ? blocks : textBlocks("No active reminders. Use New reminder on NoBo Home to create one.")));
      } else if (selected === "artifacts") {
        const items = await listRecentArtifacts(15, { ownerUserId: body.user.id });
        await show(modal("Saved documents", items.length ? items.flatMap((a) => textBlocks(`<${a.previewUrl}|${escapeSlack(a.title).replace(/\|/g, " ")}>\n${a.kind} · Updated ${a.updatedAt}\nID: ${a.id.slice(0, 8)}`)) : textBlocks("No saved documents yet. Use Save note on a response.")));
      } else if (selected === "models") {
        const definitions = listOpenCodeGoModelDefinitions();
        await show(modal("Model settings", [
          ...textBlocks(escapeSlack(`Default text: ${getDefaultSlackTextModel()}\nImage fallback: ${getDefaultSlackVisionModel()}\nSelect a channel to set its override. Model provider consent still applies.`)),
          { type: "input", block_id: "channel", label: plain("Channel"), element: { type: "conversations_select", action_id: "value", filter: { include: ["public", "private"] } } },
          { type: "input", block_id: "model", label: plain("Model override"), element: { type: "static_select", action_id: "value", options: [
            { text: plain("Use workspace default"), value: "default" }, ...definitions.map((model) => ({ text: plain(model.id + (supportsOpenCodeGoImageInput(model.id) ? " · images" : "") + (requiresOpenCodeGoDataTrainingOptIn(model.id) ? " · training opt-in" : "")), value: model.id }))
          ] } }
        ], { callback_id: "nobo_home_model_submit", submit: plain("Save") }));
      } else await show(modal("Integrations", textBlocks(integrationStatus())));
    } catch (error) {
      recordOpsError("home tools", error);
      await show(modal("Unable to complete", textBlocks(escapeSlack(summarizeOpsError(error)))));
    }
  });
  bolt.view(/^nobo_home_.*_submit$/, async ({ ack, body, view, client }) => {
    const values = view.state.values;
    const edit = view.callback_id === "nobo_home_edit_submit";
    const text = values.text?.value?.value ?? "";
    const when = (values.when?.value as { selected_date_time?: number } | undefined)?.selected_date_time;
    const channel = values.channel?.value?.selected_conversation;
    const model = values.model?.value?.selected_option?.value;
    const errors: Record<string, string> = {};
    if (edit) {
      if (!text.trim() || text.length > 1000) errors.text = "Enter 1–1000 characters.";
      if (!when || !Number.isFinite(when) || when * 1000 <= Date.now()) errors.when = "Choose a future time.";
    } else {
      if (!channel || !/^[CG][A-Z0-9]+$/.test(channel)) errors.channel = "Choose a channel.";
      if (model !== "default" && !normalizeOpenCodeGoSupportedModelId(model)) errors.model = "Choose a supported model.";
    }
    if (Object.keys(errors).length) { await ack({ response_action: "errors", errors }); return; }
    await ack({ response_action: "update", view: modal("Saving", textBlocks("Saving your change…")) });
    try {
      const access = await evaluateNoboAccess({ userId: body.user.id, teamId: body.team?.id, action: "home_save", surface: "slack-home" });
      if (!access.allowed) throw new Error("NoBo access is restricted.");
      if (edit) await editOwnedSchedule(view.private_metadata, body.user.id, text, new Date(when! * 1000).toISOString());
      else {
        await assertSlackTargetChannelAllowed({ userId: body.user.id, channelId: channel!, action: "set_channel_model", surface: "slack-home" });
        const result = model === "default" ? await clearChannelModelPreference(channel!) : await setChannelModelPreference(channel!, model!);
        if (!result.ok) throw new Error(result.reason);
      }
      await client.views.update({ view_id: view.id, view: modal("Saved", textBlocks(edit ? "Reminder updated." : "Channel model updated.")) });
      await publishSlackAppHome(body.user.id);
    } catch (error) {
      recordOpsError("home save", error);
      await client.views.update({ view_id: view.id, view: modal("Unable to save", textBlocks(escapeSlack(summarizeOpsError(error)))) });
    }
  });
}
