import { evaluateNoboAccess, formatNoboAccessDenied } from "./access-controls.js";

export type SlackMentionedChannel = {
  id: string;
  name?: string;
};

export type SlackTargetContext = {
  ownerUserId?: string;
  channel: string;
  mentionedChannels: SlackMentionedChannel[];
};

export type SlackTargetChannel = {
  id: string;
  name?: string;
};

export type SlackTargetResolution =
  | { ok: true; channel: SlackTargetChannel | null }
  | { ok: false; reason: string };

export function resolveSlackTargetChannel(
  context: SlackTargetContext,
  input: {
    targetChannelId?: string;
    targetChannelName?: string;
  }
): SlackTargetResolution {
  const targetChannelId = normalizeSlackChannelId(input.targetChannelId);

  if (targetChannelId) {
    if (targetChannelId === context.channel) {
      const mentionedChannel = context.mentionedChannels.find((channel) => channel.id === targetChannelId);
      return {
        ok: true,
        channel: {
          id: targetChannelId,
          name: input.targetChannelName?.trim() || mentionedChannel?.name
        }
      };
    }

    const mentionedChannel = context.mentionedChannels.find((channel) => channel.id === targetChannelId);
    if (mentionedChannel) {
      return { ok: true, channel: mentionedChannel };
    }

    return {
      ok: false,
      reason: "Target channel must be the current channel or a channel mentioned in this request."
    };
  }

  const targetChannelName = input.targetChannelName?.trim().replace(/^#/, "").toLowerCase();
  if (targetChannelName) {
    const mentionedChannel = context.mentionedChannels.find(
      (channel) => channel.name?.toLowerCase() === targetChannelName
    );

    if (mentionedChannel) {
      return { ok: true, channel: mentionedChannel };
    }

    return {
      ok: false,
      reason: "Target channel name must match a channel mentioned in this request."
    };
  }

  if (context.mentionedChannels.length === 1) {
    return { ok: true, channel: context.mentionedChannels[0] ?? null };
  }

  return { ok: true, channel: null };
}

export async function assertSlackTargetChannelAllowed({
  userId,
  channelId,
  action,
  surface
}: {
  userId?: string;
  channelId: string;
  action: string;
  surface: string;
}) {
  const access = await evaluateNoboAccess({
    userId,
    channelId,
    action,
    surface
  });

  if (!access.allowed) {
    throw new Error(formatNoboAccessDenied(access));
  }
}

export function normalizeSlackChannelId(input: string | undefined) {
  const trimmed = input?.trim();

  if (!trimmed) {
    return null;
  }

  const mentionMatch = trimmed.match(/^<#([CGD][A-Z0-9]+)(?:\|[^>]+)?>$/i);
  if (mentionMatch?.[1]) {
    return mentionMatch[1].toUpperCase();
  }

  const rawMatch = trimmed.match(/^#?([CGD][A-Z0-9]+)$/i);
  return rawMatch?.[1]?.toUpperCase() ?? null;
}
