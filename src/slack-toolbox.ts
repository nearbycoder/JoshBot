import type { App } from "@slack/bolt";
import type { ViewsOpenArguments } from "@slack/web-api";
import { randomUUID } from "node:crypto";
import { features, handleToolbox } from "../lib/toolbox/index.js";
import { evaluateNoboAccess } from "../lib/access-controls.js";

export function toolboxView(output = "Choose a tool, enter help to see its commands, then Run. Results stay private. No new services or model calls. Do not store secrets.", selected = "notes"): ViewsOpenArguments["view"] {
  const plain = (text: string) => ({ type: "plain_text" as const, text });
  const options = features.map(f => ({ text: plain(f.title), value: f.id }));
  return { type: "modal", title: plain("Personal toolbox"), close: plain("Close"), submit: plain("Run"), callback_id: "nobo_tools_submit", private_metadata: randomUUID(), blocks: [
    ...Array.from({ length: Math.ceil(output.length / 2900) }, (_, i) => ({ type: "section" as const, text: plain(output.slice(i * 2900, (i + 1) * 2900)) })),
    { type: "input", block_id: "tool", label: plain("Tool"), element: { type: "static_select", action_id: "value", options, initial_option: options.find(o => o.value === selected) ?? options[0] } },
    { type: "input", block_id: "command", label: plain("Command (help shows examples)"), element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, initial_value: "help" } }
  ] };
}
export function registerSlackToolbox(bolt: App) {
  bolt.view("nobo_tools_submit", async ({ ack, body, view, client }) => {
    const selected = view.state.values.tool?.value.selected_option?.value ?? "";
    const command = view.state.values.command?.value.value ?? "help";
    await ack({ response_action: "update", view: { type: "modal", title: { type: "plain_text", text: "Personal toolbox" }, close: { type: "plain_text", text: "Close" }, blocks: [{ type: "section", text: { type: "plain_text", text: "Working…" } }] } });
    const allowed = await evaluateNoboAccess({ userId: body.user.id, teamId: body.team?.id, action: "toolbox", surface: "slack-home" });
    const output = allowed.allowed ? await handleToolbox(`${selected} ${command}`, { userId: body.user.id, teamId: body.team?.id }, `${view.id}:${view.private_metadata}`) : "NoBo access is restricted.";
    await client.views.update({ view_id: view.id, view: toolboxView(output, selected) });
  });
}
