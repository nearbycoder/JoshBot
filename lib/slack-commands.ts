import { formatSlackSkillHelp } from "./skills.js";

export type SlackSlashCommandPayload = {
  command: string;
  text: string;
  user_id?: string;
  channel_id?: string;
  team_id?: string;
  response_url?: string;
  trigger_id?: string;
};

export type SlackSlashCommandResponse = {
  response_type: "ephemeral" | "in_channel";
  text: string;
  mrkdwn: boolean;
};

export function parseSlackSlashCommandPayload(rawBody: string): SlackSlashCommandPayload {
  const params = new URLSearchParams(rawBody);

  return {
    command: getRequiredParam(params, "command"),
    text: params.get("text") ?? "",
    user_id: params.get("user_id") ?? undefined,
    channel_id: params.get("channel_id") ?? undefined,
    team_id: params.get("team_id") ?? undefined,
    response_url: params.get("response_url") ?? undefined,
    trigger_id: params.get("trigger_id") ?? undefined
  };
}

export function handleSlackSlashCommandPayload(
  payload: SlackSlashCommandPayload
): SlackSlashCommandResponse {
  const command = payload.command.trim().toLowerCase();
  const text = payload.text.trim().toLowerCase();

  if (command !== "/nobo") {
    return ephemeral("This endpoint is configured for `/nobo`. Try `/nobo help`.");
  }

  if (!text || text === "help") {
    return ephemeral(formatNoboSlashCommandHelp());
  }

  return ephemeral(`I don't recognize \`/nobo ${payload.text.trim()}\` yet.\n\n${formatNoboSlashCommandHelp()}`);
}

export function formatNoboSlashCommandHelp() {
  return [`*NoBo slash commands*`, "`/nobo help`: show this help", "", formatSlackSkillHelp()].join(
    "\n"
  );
}

function ephemeral(text: string): SlackSlashCommandResponse {
  return {
    response_type: "ephemeral",
    text,
    mrkdwn: true
  };
}

function getRequiredParam(params: URLSearchParams, key: string) {
  const value = params.get(key);

  if (!value) {
    throw new Error(`Missing required Slack slash command field: ${key}`);
  }

  return value;
}
