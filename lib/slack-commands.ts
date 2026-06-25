import {
  addChannelDecision,
  formatChannelDecisionList,
  formatDecisionAdded,
  formatDecisionHelp,
  listChannelDecisions,
  parseDecisionIntent
} from "./decisions.js";
import {
  getChannelMemorySettings,
  setChannelActiveListening,
  toggleChannelActiveListening
} from "./memory.js";
import { handleArtifactCommandText } from "./artifact-commands.js";
import { handleChannelDigestCommand } from "./channel-digests.js";
import { handleChannelMemorySlashCommandText } from "./channel-memory-controls.js";
import { formatNoboOpsStatus } from "./ops-status.js";
import { summarizeOpsError } from "./ops-errors.js";
import {
  clearChannelModelPreference,
  getChannelPreferences,
  handleUserPreferencesCommand,
  setChannelModelPreference
} from "./preferences.js";
import { formatSlackSkillHelp } from "./skills.js";
import {
  formatOpenCodeGoModelName,
  getDefaultSlackTextModel,
  getDefaultSlackVisionModel,
  listOpenCodeGoModels,
  normalizeOpenCodeGoOaCompatibleModelId
} from "./nobo-models.js";
import {
  evaluateNoboAccess,
  formatNoboAccessConfig,
  formatNoboAccessDenied,
  formatNoboAdminHelp,
  formatNoboAuditLog,
  isNoboAdmin,
  listNoboAuditEvents,
  recordNoboAuditEvent,
  updateAccessControl,
  type NoboAccessSubject
} from "./access-controls.js";

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

type SlackBlock = Record<string, unknown>;

const CHANNEL_MODEL_ACTION_ID = "nobo_channel_model_select";
const SLACK_SELECT_MAX_OPTIONS = 100;

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
  blocks?: SlackBlock[];
  replace_original?: boolean;
};

export type SlackInteractionPayload = {
  type?: string;
  user?: {
    id?: string;
  };
  channel?: {
    id?: string;
  };
  actions?: SlackInteractionAction[];
};

type SlackInteractionAction = {
  action_id?: string;
  selected_option?: {
    value?: string;
  };
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
  evaluateAccess?: (subject: NoboAccessSubject) => Promise<{ allowed: boolean; reason?: string }>;
};

export type SlackInteractionOptions = {
  setChannelModelPreference?: typeof setChannelModelPreference;
  evaluateAccess?: (subject: NoboAccessSubject) => Promise<{ allowed: boolean; reason?: string }>;
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

export function parseSlackInteractionPayload(rawBody: string): SlackInteractionPayload {
  const params = new URLSearchParams(rawBody);
  const payload = params.get("payload");

  if (!payload) {
    throw new Error("Missing required Slack interaction field: payload");
  }

  return JSON.parse(payload) as SlackInteractionPayload;
}

export async function handleSlackSlashCommandPayload(
  payload: SlackSlashCommandPayload,
  options: SlackSlashCommandOptions = {}
): Promise<SlackSlashCommandResult> {
  const command = payload.command.trim().toLowerCase();
  const text = payload.text.trim().toLowerCase();

  if (command === "/nobo-status") {
    return handleStatusSlashCommand(options);
  }

  if (command === "/nobo-admin") {
    return handleAdminSlashCommand(payload);
  }

  const access = await (options.evaluateAccess ?? evaluateNoboAccess)({
    userId: payload.user_id,
    channelId: payload.channel_id,
    teamId: payload.team_id,
    action: command,
    surface: "slash-command"
  });

  if (!access.allowed) {
    return immediate(ephemeral(formatNoboAccessDenied(access)));
  }

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

  if (command === "/nobo-channel-model") {
    return handleNoboChannelModelSlashCommand(payload);
  }

  if (command === "/nobo-listen") {
    return handleListenSlashCommand(payload);
  }

  if (command === "/nobo-prefs") {
    return handlePrefsSlashCommand(payload);
  }

  if (command === "/nobo-memory") {
    return immediate(ephemeral(await handleChannelMemorySlashCommandText({
      text: payload.text,
      channelId: payload.channel_id
    })));
  }

  if (command === "/nobo-artifacts") {
    return immediate(ephemeral(await handleArtifactCommandText(payload.text, {
      ownerUserId: payload.user_id
    })));
  }

  if (command === "/nobo-decisions" || command === "/nobo-decision") {
    return handleDecisionsSlashCommand(payload);
  }

  if (command !== "/nobo-help") {
    return immediate(
      ephemeral(
        "This endpoint is configured for `/nobo-help`, `/nobo-status`, `/nobo-admin`, `/nobo-listen`, `/nobo-prefs`, `/nobo-memory`, `/nobo-artifacts`, `/nobo-decisions`, `/nobo-news`, `/nobo-hacker-news`, `/nobo-ai-news`, `/nobo-channel-digest`, `/nobo-channel-model`, and `/nobo-dad-joke`. Try `/nobo-help`."
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
    "`/nobo-admin`: manage NoBo access controls",
    "`/nobo-listen [on|off|status]`: toggle active listening for this channel",
    "`/nobo-prefs [setting]`: show or update personal preferences",
    "`/nobo-memory [show|forget <number|text>|clear confirm]`: manage shared channel memory",
    "`/nobo-artifacts [list|update <id> <content>|delete <id>|cleanup]`: manage your generated artifacts",
    "`/nobo-decisions [add <decision>|list]`: capture or list channel decisions",
    "`/nobo-news [focus]`: post this week's news digest",
    "`/nobo-hacker-news [focus]`: post top trending Hacker News stories",
    "`/nobo-ai-news [focus]`: post this week's AI news digest",
    "`/nobo-channel-digest daily|weekly ...`: subscribe this channel to digests",
    "`/nobo-channel-model`: choose this channel's text model",
    "`/nobo-dad-joke`: post a dad joke",
    "",
    formatSlackSkillHelp()
  ].join("\n");
}

async function handleAdminSlashCommand(
  payload: SlackSlashCommandPayload
): Promise<SlackSlashCommandResult> {
  if (!(await isNoboAdmin(payload.user_id))) {
    await recordNoboAuditEvent({
      actorUserId: payload.user_id,
      action: "admin_denied",
      surface: "slash-command",
      ok: false
    });
    return immediate(ephemeral("NoBo admin access denied. Configure `NOBO_ADMIN_USER_IDS` first."));
  }

  const intent = parseAdminCommandText(payload.text);
  if (!intent || intent.action === "help") {
    return immediate(ephemeral(formatNoboAdminHelp()));
  }

  if (intent.action === "list") {
    return immediate(ephemeral(await formatNoboAccessConfig()));
  }

  if (intent.action === "audit") {
    return immediate(ephemeral(formatNoboAuditLog(await listNoboAuditEvents(intent.limit))));
  }

  const result = await updateAccessControl({
    actorUserId: payload.user_id,
    mode: intent.mode,
    kind: intent.kind,
    targetId: intent.targetId,
    remove: intent.remove
  });

  if (!result.ok) {
    return immediate(ephemeral(`Couldn't update NoBo access controls: ${result.reason}`));
  }

  const verb = intent.remove ? `Removed ${intent.mode}` : `Set ${intent.mode}`;
  return immediate(ephemeral(`${verb} ${intent.kind.slice(0, -1)} rule for \`${result.targetId}\`.`));
}

function parseAdminCommandText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /^help$/i.test(trimmed)) {
    return { action: "help" as const };
  }

  if (/^(?:list|status|show)$/i.test(trimmed)) {
    return { action: "list" as const };
  }

  const auditMatch = trimmed.match(/^audit(?:\s+(\d+))?$/i);
  if (auditMatch) {
    return {
      action: "audit" as const,
      limit: auditMatch[1] ? Number(auditMatch[1]) : 10
    };
  }

  const updateMatch = trimmed.match(/^(?:(remove)\s+)?(allow|deny)\s+(channel|user)\s+(\S+)$/i);
  if (!updateMatch) {
    return null;
  }

  return {
    action: "update" as const,
    remove: Boolean(updateMatch[1]),
    mode: updateMatch[2].toLowerCase() as "allow" | "deny",
    kind: `${updateMatch[3].toLowerCase()}s` as "channels" | "users",
    targetId: updateMatch[4]
  };
}

async function handlePrefsSlashCommand(
  payload: SlackSlashCommandPayload
): Promise<SlackSlashCommandResult> {
  if (!payload.user_id) {
    return immediate(ephemeral("Slack did not send a user for this command. Try again."));
  }

  return immediate(ephemeral(await handleUserPreferencesCommand(payload.user_id, payload.text)));
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

async function handleDecisionsSlashCommand(
  payload: SlackSlashCommandPayload
): Promise<SlackSlashCommandResult> {
  if (!payload.channel_id) {
    return immediate(ephemeral("Slack did not send a channel for this command. Try again in a channel."));
  }

  const text = payload.text.trim();
  const intent = parseDecisionsSlashCommandText(text);

  if (!intent || intent.action === "help") {
    return immediate(ephemeral(formatDecisionHelp()));
  }

  if (intent.action === "list") {
    const result = await listChannelDecisions(payload.channel_id);

    if (!result.ok) {
      return immediate(ephemeral(`Couldn't load decision log: ${result.reason}`));
    }

    return immediate(ephemeral(formatChannelDecisionList(result.decisions)));
  }

  const result = await addChannelDecision({
    channelId: payload.channel_id,
    text: intent.text,
    userId: payload.user_id,
    source: "slash-command"
  });

  if (!result.ok) {
    return immediate(ephemeral(`Couldn't save decision: ${result.reason}`));
  }

  return immediate(inChannel(formatDecisionAdded(result.decision)));
}

function parseDecisionsSlashCommandText(text: string) {
  if (!text) {
    return { action: "list" as const };
  }

  if (/^help$/i.test(text)) {
    return { action: "help" as const };
  }

  if (/^(?:list|show)$/i.test(text)) {
    return { action: "list" as const };
  }

  const addMatch = text.match(/^(?:add|record|log|capture)\s+(.+)$/i);
  if (addMatch) {
    return parseDecisionIntent(`decision add ${addMatch[1] ?? ""}`);
  }

  return parseDecisionIntent(text);
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

export async function handleSlackInteractionPayload(
  payload: SlackInteractionPayload,
  options: SlackInteractionOptions = {}
): Promise<SlackSlashCommandResponse> {
  if (payload.type !== "block_actions") {
    return ephemeral("Unsupported Slack interaction.");
  }

  const action = payload.actions?.find(
    (candidate) => candidate.action_id === CHANNEL_MODEL_ACTION_ID
  );

  if (!action) {
    return ephemeral("Unsupported Slack action.");
  }

  const channelId = payload.channel?.id;
  if (!channelId) {
    return ephemeral("Slack did not send a channel for this selection.");
  }

  const access = await (options.evaluateAccess ?? evaluateNoboAccess)({
    userId: payload.user?.id,
    channelId,
    action: "slack-interaction",
    surface: "slack-interaction"
  });
  if (!access.allowed) {
    return ephemeral(formatNoboAccessDenied(access));
  }

  const modelId = normalizeOpenCodeGoOaCompatibleModelId(action.selected_option?.value);
  if (!modelId) {
    return ephemeral("Slack did not send a valid model selection.");
  }

  const setModelPreference = options.setChannelModelPreference ?? setChannelModelPreference;
  const result = await setModelPreference(channelId, modelId);
  if (!result.ok) {
    return ephemeral(`Couldn't update channel model: ${result.reason}`);
  }

  const response = await buildChannelModelSelectorResponse(
    channelId,
    result.preferences.modelId ?? modelId
  );

  return {
    ...response,
    text: formatChannelModelUpdated(modelId),
    replace_original: true
  };
}

async function handleNoboChannelModelSlashCommand(
  payload: SlackSlashCommandPayload
): Promise<SlackSlashCommandResult> {
  if (!payload.channel_id) {
    return immediate(ephemeral("Slack did not send a channel for this command. Try again in a channel."));
  }

  const text = payload.text.trim();

  if (/^help$/i.test(text)) {
    return immediate(ephemeral(formatChannelModelHelp()));
  }

  if (/^(status|show|list)$/i.test(text)) {
    return immediate(ephemeral(await formatChannelModelStatus(payload.channel_id)));
  }

  if (/^(clear|reset|default)$/i.test(text)) {
    const result = await clearChannelModelPreference(payload.channel_id);
    return immediate(
      ephemeral(
        result.ok
          ? `Reset this channel to the default text model: \`${getDefaultSlackTextModel()}\`.`
          : `Couldn't reset channel model: ${result.reason}`
      )
    );
  }

  if (text) {
    const modelId = await resolveOpenCodeGoModelId(text);

    if (!modelId) {
      return immediate(ephemeral(`I don't recognize \`${text}\` as an OpenCode Go model.`));
    }

    const result = await setChannelModelPreference(payload.channel_id, modelId);
    return immediate(
      ephemeral(
        result.ok
          ? formatChannelModelUpdated(modelId)
          : `Couldn't update channel model: ${result.reason}`
      )
    );
  }

  return immediate(await buildChannelModelSelectorResponse(payload.channel_id));
}

async function buildChannelModelSelectorResponse(
  channelId: string,
  selectedModelIdOverride?: string
): Promise<SlackSlashCommandResponse> {
  const [models, channelPreferences] = await Promise.all([
    listOpenCodeGoModels(),
    selectedModelIdOverride ? Promise.resolve(null) : getChannelPreferences(channelId)
  ]);
  const selectedModelId =
    selectedModelIdOverride ?? channelPreferences?.modelId ?? getDefaultSlackTextModel();
  const options = models.slice(0, SLACK_SELECT_MAX_OPTIONS).map(createModelSelectOption);
  const selectedOption =
    options.find((option) => option.value === selectedModelId) ??
    createModelSelectOption({
      id: selectedModelId,
      name: formatOpenCodeGoModelName(selectedModelId)
    });

  if (!options.some((option) => option.value === selectedOption.value)) {
    if (options.length >= SLACK_SELECT_MAX_OPTIONS) {
      options.pop();
    }
    options.unshift(selectedOption);
  }

  return {
    ...ephemeral(`Choose this channel's NoBo text model. Current: \`${selectedModelId}\`.`),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Channel model*\nCurrent text model: \`${selectedModelId}\`\nImage messages still use \`${getDefaultSlackVisionModel()}\`.`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "static_select",
            action_id: CHANNEL_MODEL_ACTION_ID,
            placeholder: {
              type: "plain_text",
              text: "Select model"
            },
            initial_option: selectedOption,
            options
          }
        ]
      }
    ]
  };
}

async function formatChannelModelStatus(channelId: string) {
  const preferences = await getChannelPreferences(channelId);
  const modelId = preferences.modelId ?? getDefaultSlackTextModel();
  const source = preferences.modelId ? "channel override" : "default";

  return [
    "*NoBo channel model*",
    `Text model: \`${modelId}\` (${source})`,
    `Image model: \`${getDefaultSlackVisionModel()}\``
  ].join("\n");
}

function formatChannelModelHelp() {
  return [
    "*NoBo channel model*",
    "`/nobo-channel-model`: pick with a selector",
    "`/nobo-channel-model status`: show current model",
    "`/nobo-channel-model <model-id>`: set directly",
    "`/nobo-channel-model reset`: use the default text model"
  ].join("\n");
}

function formatChannelModelUpdated(modelId: string) {
  return `Updated this channel's text model to \`${modelId}\`. Image messages still use \`${getDefaultSlackVisionModel()}\`.`;
}

async function resolveOpenCodeGoModelId(input: string) {
  const requested = normalizeOpenCodeGoOaCompatibleModelId(input);

  if (!requested) {
    return null;
  }

  const models = await listOpenCodeGoModels();
  return models.some((model) => model.id === requested) ? requested : null;
}

function createModelSelectOption(model: { id: string; name: string }) {
  return {
    text: {
      type: "plain_text",
      text: truncateSlackPlainText(model.name, 75)
    },
    value: model.id,
    description: {
      type: "plain_text",
      text: truncateSlackPlainText(model.id, 75)
    }
  };
}

function truncateSlackPlainText(input: string, maxLength: number) {
  return input.length <= maxLength ? input : input.slice(0, Math.max(0, maxLength - 3)) + "...";
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
