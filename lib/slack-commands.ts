import {
  getChannelMemorySettings,
  setChannelActiveListening,
  toggleChannelActiveListening
} from "./memory.js";
import { handleChannelDigestCommand } from "./channel-digests.js";
import { handleChannelMemorySlashCommandText } from "./channel-memory-controls.js";
import { formatNoboOpsStatus } from "./ops-status.js";
import { summarizeOpsError } from "./ops-errors.js";
import { formatSlackSkillHelp } from "./skills.js";

const DAD_JOKES = [
  "I only know 25 letters of the alphabet. I don't know y.",
  "I used to hate facial hair, but then it grew on me.",
  "Why did the scarecrow win an award? Because he was outstanding in his field.",
  "I'm reading a book about anti-gravity. It's impossible to put down.",
  "I asked my dog what's two minus two. He said nothing.",
  "Why don't skeletons fight each other? They don't have the guts.",
  "I would avoid the sushi if I were you. It's a little fishy.",
  "What do you call fake spaghetti? An impasta."
];

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

export type SlackSlashCommandTask = {
  type: "ai-news" | "hacker-news" | "news";
  channelId: string;
  userId?: string;
  focus: string;
};

export type SlackSlashCommandResult = {
  response: SlackSlashCommandResponse;
  task?: SlackSlashCommandTask;
};

export type SlackSlashCommandOptions = {
  formatOpsStatus?: () => Promise<string>;
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

export async function handleSlackSlashCommandPayload(
  payload: SlackSlashCommandPayload,
  options: SlackSlashCommandOptions = {}
): Promise<SlackSlashCommandResult> {
  const command = payload.command.trim().toLowerCase();
  const text = payload.text.trim().toLowerCase();

  if (command === "/nobo-dad-joke") {
    return handleNoboDadJokeSlashCommand();
  }

  if (command === "/nobo-news") {
    return handleNoboNewsSlashCommand(payload);
  }

  if (command === "/nobo-hacker-news") {
    return handleNoboHackerNewsSlashCommand(payload);
  }

  if (command === "/nobo-ai-news") {
    return handleNoboAiNewsSlashCommand(payload);
  }

  if (command === "/nobo-channel-digest") {
    return handleNoboChannelDigestSlashCommand(payload);
  }

  if (command === "/nobo-listen") {
    return handleListenSlashCommand(payload);
  }

  if (command === "/nobo-status") {
    return handleStatusSlashCommand(options);
  }

  if (command === "/nobo-memory") {
    return immediate(ephemeral(await handleChannelMemorySlashCommandText({
      text: payload.text,
      channelId: payload.channel_id
    })));
  }

  if (command !== "/nobo-help") {
    return immediate(
      ephemeral(
        "This endpoint is configured for `/nobo-help`, `/nobo-status`, `/nobo-listen`, `/nobo-memory`, `/nobo-news`, `/nobo-hacker-news`, `/nobo-ai-news`, `/nobo-channel-digest`, and `/nobo-dad-joke`. Try `/nobo-help`."
      )
    );
  }

  if (!text || text === "help") {
    return immediate(ephemeral(formatNoboSlashCommandHelp()));
  }

  return immediate(
    ephemeral(
      `I don't recognize \`/nobo-help ${payload.text.trim()}\` yet.\n\n${formatNoboSlashCommandHelp()}`
    )
  );
}

export function formatNoboSlashCommandHelp() {
  return [
    `*NoBo slash commands*`,
    "`/nobo-help`: show this help",
    "`/nobo-status`: show ops health",
    "`/nobo-listen [on|off|status]`: toggle active listening for this channel",
    "`/nobo-memory [show|forget <number|text>|clear confirm]`: manage shared channel memory",
    "`/nobo-news [focus]`: post this week's news digest",
    "`/nobo-hacker-news [focus]`: post top trending Hacker News stories",
    "`/nobo-ai-news [focus]`: post this week's AI news digest",
    "`/nobo-channel-digest daily|weekly ...`: subscribe this channel to digests",
    "`/nobo-dad-joke`: post a dad joke",
    "",
    formatSlackSkillHelp()
  ].join("\n");
}

async function handleStatusSlashCommand(
  options: SlackSlashCommandOptions
): Promise<SlackSlashCommandResult> {
  try {
    return immediate(ephemeral(await (options.formatOpsStatus ?? formatNoboOpsStatus)()));
  } catch (error) {
    return immediate(ephemeral(`NoBo status check failed: ${summarizeOpsError(error)}`));
  }
}

async function handleListenSlashCommand(
  payload: SlackSlashCommandPayload
): Promise<SlackSlashCommandResult> {
  const text = payload.text.trim().toLowerCase();

  if (text === "help") {
    return immediate(
      ephemeral(
        [
          "*NoBo active listening*",
          "`/nobo-listen`: toggle active listening in this channel",
          "`/nobo-listen on`: turn it on",
          "`/nobo-listen off`: turn it off",
          "`/nobo-listen status`: show current state"
        ].join("\n")
      )
    );
  }

  if (!payload.channel_id) {
    return immediate(ephemeral("Slack did not send a channel for this command. Try again in a channel."));
  }

  if (text === "status") {
    const settings = await getChannelMemorySettings(payload.channel_id);
    return immediate(ephemeral(formatListenStatus(settings.activeListening)));
  }

  const result =
    text === "on" || text === "enable"
      ? await setChannelActiveListening(payload.channel_id, true)
      : text === "off" || text === "disable"
        ? await setChannelActiveListening(payload.channel_id, false)
        : text
          ? null
          : await toggleChannelActiveListening(payload.channel_id);

  if (!result) {
    return immediate(ephemeral("Usage: `/nobo-listen [on|off|status]`"));
  }

  if (!result.ok) {
    return immediate(ephemeral(`Couldn't update active listening: ${result.reason}`));
  }

  return immediate(ephemeral(formatListenStatus(result.settings.activeListening)));
}

function formatListenStatus(activeListening: boolean) {
  return activeListening
    ? "Active listening is on for this channel. NoBo may reply without an @mention when it thinks it should."
    : "Active listening is off for this channel. Use `@NoBo` or `/nobo-listen` to wake it up.";
}

async function handleNoboChannelDigestSlashCommand(
  payload: SlackSlashCommandPayload
): Promise<SlackSlashCommandResult> {
  return immediate(
    ephemeral(
      await handleChannelDigestCommand({
        text: payload.text,
        channelId: payload.channel_id,
        ownerUserId: payload.user_id
      })
    )
  );
}

function handleNoboAiNewsSlashCommand(
  payload: SlackSlashCommandPayload
): SlackSlashCommandResult {
  const text = payload.text.trim();

  if (text.toLowerCase() === "help") {
    return immediate(
      ephemeral(
        [
          "*NoBo AI news*",
          "`/nobo-ai-news`: post this week's AI news digest",
          "`/nobo-ai-news open source models`: focus the digest"
        ].join("\n")
      )
    );
  }

  if (!payload.channel_id) {
    return immediate(ephemeral("Slack did not send a channel for this command. Try again in a channel."));
  }

  return {
    response: ephemeral(
      text
        ? `Pulling this week's AI news with a focus on "${text}". I'll post it here shortly.`
        : "Pulling this week's AI news. I'll post it here shortly."
    ),
    task: {
      type: "ai-news",
      channelId: payload.channel_id,
      userId: payload.user_id,
      focus: text
    }
  };
}

function handleNoboHackerNewsSlashCommand(
  payload: SlackSlashCommandPayload
): SlackSlashCommandResult {
  const text = payload.text.trim();

  if (text.toLowerCase() === "help") {
    return immediate(
      ephemeral(
        [
          "*NoBo Hacker News*",
          "`/nobo-hacker-news`: post top trending Hacker News stories",
          "`/nobo-hacker-news rust`: filter top trending Hacker News stories by focus"
        ].join("\n")
      )
    );
  }

  if (!payload.channel_id) {
    return immediate(ephemeral("Slack did not send a channel for this command. Try again in a channel."));
  }

  return {
    response: ephemeral(
      text
        ? `Pulling top trending Hacker News stories matching "${text}". I'll post them here shortly.`
        : "Pulling top trending Hacker News stories. I'll post them here shortly."
    ),
    task: {
      type: "hacker-news",
      channelId: payload.channel_id,
      userId: payload.user_id,
      focus: text
    }
  };
}

function handleNoboNewsSlashCommand(payload: SlackSlashCommandPayload): SlackSlashCommandResult {
  const text = payload.text.trim();

  if (text.toLowerCase() === "help") {
    return immediate(
      ephemeral(
        [
          "*NoBo news*",
          "`/nobo-news`: post this week's news digest",
          "`/nobo-news markets`: focus the digest"
        ].join("\n")
      )
    );
  }

  if (!payload.channel_id) {
    return immediate(ephemeral("Slack did not send a channel for this command. Try again in a channel."));
  }

  return {
    response: ephemeral(
      text
        ? `Pulling this week's news with a focus on "${text}". I'll post it here shortly.`
        : "Pulling this week's news. I'll post it here shortly."
    ),
    task: {
      type: "news",
      channelId: payload.channel_id,
      userId: payload.user_id,
      focus: text
    }
  };
}

function handleNoboDadJokeSlashCommand(): SlackSlashCommandResult {
  return immediate(inChannel(`*Dad joke:* ${pickDadJoke()}`));
}

function pickDadJoke() {
  return DAD_JOKES[Math.floor(Math.random() * DAD_JOKES.length)] ?? DAD_JOKES[0];
}

function immediate(response: SlackSlashCommandResponse): SlackSlashCommandResult {
  return { response };
}

function ephemeral(text: string): SlackSlashCommandResponse {
  return {
    response_type: "ephemeral",
    text,
    mrkdwn: true
  };
}

function inChannel(text: string): SlackSlashCommandResponse {
  return {
    response_type: "in_channel",
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
