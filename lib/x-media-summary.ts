const MAX_SOURCE_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 600;
export const X_SUMMARY_TIMEOUT_MS = 20_000;

/** Strip links so media-only posts are not turned into invented descriptions. */
export function cleanXPostText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.slice(0, MAX_SOURCE_CHARS)
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

type Generate = (text: string, channelId: string, signal: AbortSignal) => Promise<string>;
const generate: Generate = async (...args) => (await import("./ai.js")).createXPostSummary(...args);

/** Best effort: generation has a hard deadline and never prevents the media upload. */
export async function summarizeXPost(
  value: unknown, channelId: string, parentSignal: AbortSignal,
  options: { generate?: Generate; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const text = cleanXPostText(value);
  if (!text || parentSignal.aborted) return undefined;
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let onAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error("X summary timed out")), options.timeoutMs ?? X_SUMMARY_TIMEOUT_MS);
  try {
    const result = await Promise.race([(options.generate ?? generate)(text, channelId, signal), stopped]);
    if (typeof result !== "string") return undefined;
    // Plain-text output only; don't publish generated links, Slack pings, or model markup.
    const summary = cleanXPostText(result)
      .replace(/<[^>]*>/g, "").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
    if (!summary || summary.length > MAX_SUMMARY_CHARS) return undefined;
    return summary;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
