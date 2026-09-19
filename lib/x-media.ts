import { WebClient, type FilesUploadV2Arguments } from "@slack/web-api";
import { summarizeXPost } from "./x-media-summary.js";
import {
  evaluateNoboAccess,
  type NoboAccessSubject,
} from "./access-controls.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const USER_AGENT = "NoBo/0.1 (https://github.com/nearbycoder/JoshBot)";
export const X_MEDIA_HELP =
  "Use `/nobo-x` to open the upload form, or `/nobo-x https://x.com/user/status/123` to upload a public post’s images or videos with a short summary when the post has text (no post card or source link). Also available as `/nobo-help x [link]`. Up to 4 files, 50 MiB each / 100 MiB total. Only share media you have permission to share.";
export class XMediaError extends Error {}
export type XMediaRequest = {
  postId: string;
  channelId: string;
  userId: string;
  teamId: string;
};
type Media = { url: string; type: "photo" | "video" | "gif"; altText?: string };
type UploadClient = Pick<WebClient, "filesUploadV2">;
type Dependencies = {
  fetch: typeof fetch;
  access: (subject: NoboAccessSubject) => Promise<{ allowed: boolean }>;
  summarize: typeof summarizeXPost;
};
const defaults: Dependencies = {
  fetch: (...args) => fetch(...args),
  access: evaluateNoboAccess,
  summarize: summarizeXPost,
};
// One bounded transfer per process; production currently runs one replica. Never retain a queue of buffers.
let transferring = false;

export function parseXPostId(input: string): string {
  const raw = input.trim().replace(/^<([^<>|]+)(?:\|[^<>]*)?>$/, "$1");
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:(?:www|mobile|m)\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)
    )
      throw new Error();
    const match = url.pathname.match(
      /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/([1-9]\d{0,24})(?:\/(?:photo|video)\/[1-4])?\/?$/,
    );
    if (!match) throw new Error();
    return match[1];
  } catch {
    throw new XMediaError(
      "Paste one full HTTPS X/Twitter post link, not a profile, shortened link, or search URL.",
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function mediaUrl(value: unknown, type: Media["type"]) {
  if (typeof value !== "string" || value.length > 4096)
    throw new XMediaError("The post contains an unsupported media URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XMediaError("The post contains an invalid media URL.");
  }
  const allowed =
    type === "photo"
      ? url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")
      : url.hostname === "video.twimg.com" && url.pathname.endsWith(".mp4");
  if (
    !allowed ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new XMediaError(
      "Only images and MP4 media hosted by X are supported; external players and live streams are not.",
    );
  }
  return url.href;
}

export function extractXMedia(value: unknown, postId: string): Media[] {
  const body = record(value),
    post = record(body.status);
  if ([401, 403, 404].includes(Number(body.code)))
    throw new XMediaError(
      "That post is private, deleted, restricted, or unavailable. Try a public post.",
    );
  if (body.code === 429)
    throw new XMediaError(
      "The X media lookup is rate-limited. Please try again later.",
    );
  if (body.code !== 200 || post.id !== postId || post.type === "tombstone")
    throw new XMediaError(
      "The X media lookup could not retrieve this post. Please try again later.",
    );
  const media = record(post.media);
  const items =
    Array.isArray(media.all) && media.all.length
      ? media.all
      : [
          ...(Array.isArray(media.photos) ? media.photos : []),
          ...(Array.isArray(media.videos) ? media.videos : []),
        ];
  if (!items.length)
    throw new XMediaError(
      "This post has no directly attached images or videos. For a quoted post, use the original post’s link. External players and live streams are not supported.",
    );
  if (items.length > 4)
    throw new XMediaError("This post exceeds the limit of 4 media files.");
  return items.map((item) => {
    const entry = record(item);
    if (
      entry.type !== "photo" &&
      entry.type !== "video" &&
      entry.type !== "gif"
    )
      throw new XMediaError("This post contains an unsupported media type.");
    // The API's primary URL is its ready-to-download rendition; do not fetch thumbnails or external embeds.
    return {
      type: entry.type,
      url: mediaUrl(entry.url, entry.type),
      ...(typeof entry.altText === "string" && entry.altText.trim()
        ? { altText: entry.altText.slice(0, 1000) }
        : {}),
    };
  });
}

async function readBounded(response: Response, max: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) {
    await response.body?.cancel();
    throw new XMediaError(
      "Media exceeds the 50 MiB per-file or 100 MiB per-post limit. Nothing was posted.",
    );
  }
  if (!response.body)
    throw new XMediaError("The media download was empty. Nothing was posted.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max)
        throw new XMediaError(
          "Media exceeds the download size limit. Nothing was posted.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!length)
    throw new XMediaError("The media download was empty. Nothing was posted.");
  return Buffer.concat(chunks, length);
}

function extension(bytes: Buffer, contentType: string, kind: Media["type"]) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (
    kind !== "photo" &&
    type === "video/mp4" &&
    bytes.subarray(4, 8).toString() === "ftyp"
  )
    return "mp4";
  if (kind === "photo") {
    if (
      type === "image/jpeg" &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    )
      return "jpg";
    if (
      type === "image/png" &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return "png";
    if (
      type === "image/gif" &&
      /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
    )
      return "gif";
    if (
      type === "image/webp" &&
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    )
      return "webp";
  }
  throw new XMediaError(
    "X returned an unsupported or invalid media file. Nothing was posted.",
  );
}

/** No Slack credentials, cookies, or private message content are sent to the public lookup/CDN. */
export async function uploadXMedia(
  request: XMediaRequest,
  client: UploadClient,
  dependencies: Partial<Dependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  if (
    !/^[1-9]\d{0,24}$/.test(request.postId) ||
    !/^[CGD][A-Z0-9]+$/.test(request.channelId) ||
    !request.userId ||
    !request.teamId
  )
    throw new XMediaError(
      "Run this command from a Slack channel with NoBo in it.",
    );
  if (transferring)
    throw new XMediaError(
      "NoBo is already transferring media. Please try again when that upload finishes.",
    );
  transferring = true;
  let uploading = false;
  try {
    const subject = {
      userId: request.userId,
      teamId: request.teamId,
      channelId: request.channelId,
      action: "x-media",
      surface: "slash-command",
    };
    if (!(await deps.access(subject)).allowed)
      throw new XMediaError(
        "NoBo access is restricted for this user or channel.",
      );
    const signal = AbortSignal.timeout(120_000);
    const options = {
      redirect: "error" as const,
      signal,
      headers: { "User-Agent": USER_AGENT },
    };
    const lookup = await deps.fetch(
      `https://api.fxtwitter.com/2/status/${request.postId}`,
      {
        ...options,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
    );
    if ([401, 403, 404, 429].includes(lookup.status)) {
      await lookup.body?.cancel();
      extractXMedia({ code: lookup.status }, request.postId);
    }
    if (!lookup.ok) {
      await lookup.body?.cancel();
      throw new XMediaError(
        "The X media lookup is temporarily unavailable. Please try again later.",
      );
    }
    const postData: unknown = JSON.parse((await readBounded(lookup, 1024 * 1024)).toString("utf8"));
    const items = extractXMedia(postData, request.postId);
    const files: {
      file: Buffer;
      filename: string;
      title: string;
      alt_text?: string;
    }[] = [];
    let total = 0;
    for (const [index, item] of items.entries()) {
      const response = await deps.fetch(item.url, options);
      if (!response.ok) {
        await response.body?.cancel();
        throw new XMediaError(
          "X could not serve one of the media files. Nothing was posted.",
        );
      }
      const file = await readBounded(
        response,
        Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total),
      );
      total += file.length;
      const ext = extension(
        file,
        response.headers.get("content-type") ?? "",
        item.type,
      );
      files.push({
        file,
        filename: `x-${request.postId}-${index + 1}.${ext}`,
        title: `X media ${index + 1}`,
        ...(item.altText ? { alt_text: item.altText } : {}),
      });
    }
    const summary = await deps.summarize(record(record(postData).status).text, request.channelId, signal).catch(() => undefined);
    signal.throwIfAborted();
    // Recheck after downloads and summarization in case policy changed; share files and summary together.
    if (!(await deps.access(subject)).allowed)
      throw new XMediaError(
        "NoBo access changed during the download. Nothing was posted.",
      );
    uploading = true;
    const result = await client.filesUploadV2({
      channel_id: request.channelId,
      file_uploads: files,
      ...(summary ? { blocks: [{ type: "section", text: { type: "plain_text", text: `Post summary (AI)\n${summary}` } }] } : {}),
    } satisfies FilesUploadV2Arguments);
    if (!result.ok) throw new Error("Upload not confirmed");
    return files.length;
  } catch (error) {
    if (error instanceof XMediaError) throw error;
    const code = record(record(error).data).error;
    if (code === "missing_scope")
      throw new XMediaError(
        "NoBo needs the files:write bot scope. Add it in Slack OAuth & Permissions, then reinstall the app.",
      );
    if (
      ["not_in_channel", "channel_not_found", "no_permission"].includes(
        String(code),
      )
    )
      throw new XMediaError(
        "Invite NoBo to this channel and make sure it is allowed to upload files here.",
      );
    if (uploading)
      throw new XMediaError(
        "Slack could not confirm the upload. Check the channel before retrying to avoid duplicates.",
      );
    throw new XMediaError(
      "The media lookup or download failed or timed out. Nothing was posted. Try again later.",
    );
  } finally {
    transferring = false;
  }
}

/** Uploads need a longer timeout than ordinary bot messages; never retry uncertain shared-file writes. */
export function xMediaUploadClient(token: string | undefined) {
  if (!token) throw new XMediaError("NoBo’s Slack bot token is unavailable.");
  return new WebClient(token, {
    timeout: 60_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  });
}
