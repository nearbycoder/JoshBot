import type { RecentArtifact } from "./artifacts.js";
import type { ChannelMemoryStatus } from "./memory.js";
import type { MonitorDashboardItem } from "./monitors.js";
import type { UserPreferences } from "./preferences.js";
import type { ScheduleDashboardItem } from "./schedules.js";
import {
  formatOpenCodeGoModelName,
  getDefaultSlackTextModel,
} from "./nobo-models.js";

type Block = Record<string, unknown>;
export type SlackHomeChannelStatus = ChannelMemoryStatus & {
  modelId?: string;
  modelName?: string;
  modelSource?: "default" | "channel";
};
export type SlackHomeDashboardData = {
  userId: string;
  memories: string[];
  schedules: ScheduleDashboardItem[];
  monitors: MonitorDashboardItem[];
  artifacts: RecentArtifact[];
  channelStatuses: SlackHomeChannelStatus[];
  preferences: UserPreferences;
  updatedAt: Date;
  unavailable?: string[];
};
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;
const singleLine = (text: string, max = 180) =>
  clip(text.replace(/\s+/g, " ").trim(), max);
const section = (text: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text },
});
const context = (text: string): Block => ({
  type: "context",
  elements: [plain(text)],
});
const button = (label: string, actionId: string, value?: string): Block => ({
  type: "button",
  text: plain(label),
  action_id: actionId,
  ...(value ? { value } : {}),
});
const open = (label: string, destination: string) =>
  button(label, `nobo_home_open_${destination}`, destination);
const heading = (title: string, label: string, destination: string): Block => ({
  ...section(`*${title}*`),
  accessory: open(label, destination),
});
const divider: Block = { type: "divider" };

export function homeTimezone(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}
export function homeTimestamp(value: string | Date, zone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: homeTimezone(zone),
  }).format(date);
}
function documentLink(artifact: RecentArtifact) {
  const title = escape(
    singleLine(artifact.title || "Untitled document", 90),
  ).replaceAll("|", "¦");
  try {
    const url = new URL(artifact.previewUrl);
    if (url.protocol !== "https:" || url.username || url.password) return title;
    return `<${url.href.replaceAll("|", "%7C").replaceAll("<", "%3C").replaceAll(">", "%3E")}|${title}>`;
  } catch {
    return title;
  }
}
function reminders(
  items: ScheduleDashboardItem[],
  data: SlackHomeDashboardData,
) {
  return [...items]
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
    .slice(0, 3)
    .map((item) => {
      const due =
        Date.parse(item.nextRunAt) <= data.updatedAt.getTime() ? "Due" : "Next";
      return {
        type: "section",
        text: plain(
          `${singleLine(item.summary)}\n${due} · ${homeTimestamp(item.nextRunAt, data.preferences.timeZone)}`,
        ),
      };
    });
}

export function buildSlackAppHomeView(data: SlackHomeDashboardData) {
  const zone = homeTimezone(data.preferences.timeZone);
  const recent = [...data.artifacts]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 3);
  const blocks: Block[] = [
    { type: "header", text: plain("NoBo Home") },
    section("Your notes, plans, and reminders — all in one place."),
    {
      type: "actions",
      elements: [
        { ...open("Open toolbox", "toolbox"), style: "primary" },
        button("New reminder", "nobo_open_modal:reminder"),
      ],
    },
    divider,
    heading("Coming up", "Manage", "reminders"),
    ...(data.unavailable?.includes("schedules")
      ? [section("Reminders couldn’t be loaded. Use Refresh to try again.")]
      : data.schedules.length
        ? reminders(data.schedules, data)
        : [
            section(
              "Nothing scheduled yet.\nSet a reminder above and NoBo will keep track of it.",
            ),
          ]),
    ...(data.schedules.length > 3
      ? [
          context(
            "Showing your next 3 reminders. Manage opens your reminder controls.",
          ),
        ]
      : []),
    divider,
    heading("Recent documents", "Browse", "artifacts"),
    ...(data.unavailable?.includes("artifacts")
      ? [section("Documents couldn’t be loaded. Use Refresh to try again.")]
      : recent.length
        ? recent.map((artifact) =>
            section(
              `${documentLink(artifact)}\n${artifact.kind === "html" ? "Web document" : "Note"} · Updated ${homeTimestamp(artifact.updatedAt, zone)}`,
            ),
          )
        : [
            section(
              "Your saved work will appear here.\nUse Save note on a response, or ask NoBo to create a document.",
            ),
          ]),
  ];
  if (data.unavailable?.includes("monitors")) {
    blocks.push(
      divider,
      heading("Watching for you", "View monitors", "monitors"),
      section("Monitors couldn’t be loaded. Use Refresh to try again."),
    );
  } else if (data.monitors.length) {
    blocks.push(
      divider,
      heading("Watching for you", "View monitors", "monitors"),
      ...data.monitors.slice(0, 2).map((monitor) => ({
        type: "section",
        text: plain(
          `${singleLine(monitor.summary, 150)}\nNext check · ${homeTimestamp(monitor.nextRunAt, zone)}`,
        ),
      })),
    );
    if (data.monitors.length > 2)
      blocks.push(context("More monitors are available in View monitors."));
  }
  blocks.push(
    divider,
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: "nobo_home_tools",
          placeholder: plain("More…"),
          options: [
            ["Personal toolbox", "toolbox"],
            ["My reminders", "reminders"],
            ["Saved documents", "artifacts"],
            ["My monitors", "monitors"],
            ["Remembered about you", "memory"],
            ["Channel activity", "channels"],
            ["Model settings", "models"],
            ["Integrations", "integrations"],
            ["How to use NoBo", "help"],
          ].map(([label, value]) => ({ text: plain(label), value })),
        },
        button("Preferences", "nobo_open_modal:prefs"),
        button("Refresh", "nobo_home_refresh"),
      ],
    },
    context(
      `${zone} · ${data.preferences.verbosity} replies · Updated ${homeTimestamp(data.updatedAt, zone)}`,
    ),
  );
  if (data.unavailable?.length)
    blocks.push(
      context(
        "Some Home data is unavailable. Times use default preferences if your settings couldn’t be loaded.",
      ),
    );
  return { type: "home", blocks };
}

export type HomeDetailsKind = "memory" | "channels" | "monitors" | "help";
export function buildSlackHomeDetailsView(
  data: SlackHomeDashboardData,
  kind: HomeDetailsKind,
) {
  let title: string, blocks: Block[];
  if (kind === "memory") {
    title = "Remembered about you";
    blocks = [
      section(
        "Personal details NoBo uses to tailor replies. Manage them in Messages with `show my memory`, `forget …`, or `clear my memory`.",
      ),
      ...(data.memories.length
        ? data.memories
            .slice(0, 30)
            .map((memory) => ({
              type: "section",
              text: plain(clip(memory, 2800) || "Empty memory"),
            }))
        : [
            section(
              "No personal memories saved yet. Tell NoBo: `remember I prefer concise updates`.",
            ),
          ]),
    ];
    if (data.memories.length > 30)
      blocks.push(
        context(
          "Showing the first 30 memories. Use show my memory in Messages for more.",
        ),
      );
  } else if (kind === "channels") {
    title = "Channel activity";
    blocks = [
      section(
        "Listening and model settings for channels known to NoBo. Use `/nobo-listen` in a channel to change listening.",
      ),
      ...data.channelStatuses.slice(0, 12).map((status) => {
        const channel = /^[CG][A-Z0-9]+$/.test(status.channelId)
          ? `<#${status.channelId}>`
          : escape(singleLine(status.channelId, 80));
        const model = status.modelId ?? getDefaultSlackTextModel();
        return section(
          `${channel} · Listening ${status.activeListening ? "on" : "off"}\n${escape(singleLine(status.modelName ?? formatOpenCodeGoModelName(model), 100))} · ${escape(singleLine(model, 100))} (${status.modelSource === "channel" ? "channel override" : "default"})\n${status.memoryCount} saved context items`,
        );
      }),
    ];
    if (!data.channelStatuses.length)
      blocks.push(section("No channel activity to show yet."));
  } else if (kind === "monitors") {
    title = "My monitors";
    blocks = [
      section(
        "Use `@NoBo monitors` to manage monitors, or ask NoBo to watch for a condition.",
      ),
      ...data.monitors
        .slice(0, 20)
        .map((monitor) => ({
          type: "section",
          text: plain(
            `${singleLine(monitor.summary, 1800)}\nNext check · ${homeTimestamp(monitor.nextRunAt, data.preferences.timeZone)}\nID: ${monitor.id.slice(0, 8)}`,
          ),
        })),
    ];
    if (!data.monitors.length)
      blocks.push(
        section(
          "No active monitors. Ask NoBo to watch for something in a conversation.",
        ),
      );
  } else {
    title = "How to use NoBo";
    blocks = [
      section(
        "*Start a conversation*\nOpen the Messages tab, or mention `@NoBo` in a channel or thread.",
      ),
      section(
        "*Work with a thread*\n`@NoBo summarize-thread`\n`@NoBo meeting-notes artifact`\n`@NoBo follow-ups`\n`@NoBo what needs my attention?`\n`@NoBo issues`",
      ),
      section(
        "*Find and organize*\n`/nobo-search <query>`\n`@NoBo web-search …`\n`/nobo-polls create Q? | A | B`\n`/nobo-polls results`\n`/nobo-channel-digest daily 09:00`\n`/nobo-news`",
      ),
      section(
        "*Make it yours*\nOpen the toolbox for notes, checklists, timers, and planning tools.\n`/nobo-help tools`\n`/nobo-memory`\n`/nobo-channel-model`\n`/nobo-help` for the full command reference.",
      ),
    ];
  }
  const relevant =
    kind === "memory"
      ? ["memories"]
      : kind === "channels"
        ? ["channel status", "channel models"]
        : kind === "monitors"
          ? ["monitors"]
          : [];
  if (relevant.some((key) => data.unavailable?.includes(key)))
    blocks = [
      section(
        "This information couldn’t be loaded. Close this window and refresh Home to try again.",
      ),
    ];
  return { type: "modal", title: plain(title), close: plain("Close"), blocks };
}
