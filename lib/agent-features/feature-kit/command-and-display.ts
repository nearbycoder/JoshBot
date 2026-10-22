/** Small command parsers and lossless reply pagination. No feature/runtime imports. */
export const NORMAL_REPLY_UNITS = 3_500;
export type TextLimit = { label: string; maxBytes: number; maxUnits?: number; trim?: boolean; allowEmpty?: boolean };

export function boundedText(value: unknown, limit: TextLimit): string {
  if (!Number.isSafeInteger(limit.maxBytes) || limit.maxBytes < 0 ||
      (limit.maxUnits !== undefined && (!Number.isSafeInteger(limit.maxUnits) || limit.maxUnits < 0))) {
    throw new Error("Invalid text limit.");
  }
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${limit.label} must be valid text without unsupported control characters.`);
  }
  // Bound the supplied input as well as the retained text; whitespace is not a bypass.
  if (Buffer.byteLength(value, "utf8") > limit.maxBytes || value.length > (limit.maxUnits ?? limit.maxBytes)) {
    throw new Error(`${limit.label} is too long (maximum ${limit.maxBytes} UTF-8 bytes${limit.maxUnits === undefined ? "" : `, ${limit.maxUnits} string units`}).`);
  }
  const result = limit.trim === false ? value : value.trim();
  if (!limit.allowEmpty && !result.trim()) throw new Error(`${limit.label} is required.`);
  return result;
}

/** Decode only \| and \\ escapes. Every unescaped pipe separates a field. */
export function pipeFields(input: string, limits: readonly TextLimit[]): string[] {
  if (typeof input !== "string" || limits.length < 1 || limits.length > 32 || input.length > 48_000) {
    throw new Error("Invalid or oversized pipe input.");
  }
  const fields = [""];
  for (let index = 0; index < input.length; index++) {
    let char = input[index];
    if (char === "\\") {
      char = input[++index];
      if (char !== "|" && char !== "\\") throw new Error("Only \\| (literal pipe) and \\\\ (literal backslash) escapes are supported; no trailing backslash.");
    } else if (char === "|") { fields.push(""); continue; }
    fields[fields.length - 1] += char;
  }
  if (fields.length !== limits.length) throw new Error(`Use exactly ${limits.length} pipe-separated fields; escape a literal pipe as \\|. Extra unescaped delimiters are not supported.`);
  return fields.map((value, index) => boundedText(value, limits[index]));
}

export type NumberLimit = { min: number; max: number; label?: string };
function numeric(input: string, limit: NumberLimit, integer: boolean): number {
  const pattern = integer ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
  if (!Number.isFinite(limit.min) || !Number.isFinite(limit.max) || limit.min > limit.max) throw new Error("Invalid numeric limits.");
  const value = typeof input === "string" && input.length <= 64 && pattern.test(input) ? Number(input) : NaN;
  if (!Number.isFinite(value) || Object.is(value, -0) || (integer && !Number.isSafeInteger(value)) || value < limit.min || value > limit.max) {
    throw new Error(`${limit.label ?? "Value"} must be ${integer ? "an integer" : "a decimal number"} from ${limit.min} to ${limit.max}; use no spaces, exponent, sign prefix, or extra text.`);
  }
  return value;
}
export const parseInteger = (input: string, limit: NumberLimit): number => numeric(input, limit, true);
export const parseDecimal = (input: string, limit: NumberLimit): number => numeric(input, limit, false);
export const parsePage = (input: string = "1"): number => parseInteger(input, { min: 1, max: 10_000, label: "Page" });

export type DisplayMode = "plain" | "mrkdwn";
/** Existing slash replies use plain. Entity escaping is ONLY for mrkdwn surfaces. */
export function renderText(text: string, mode: DisplayMode): string {
  if (!text.isWellFormed()) throw new Error("Display text contains an unpaired Unicode surrogate.");
  if (mode === "plain") return text;
  if (mode !== "mrkdwn") throw new Error("Choose plain or mrkdwn display explicitly.");
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Mark every known identifier, URL, and complete command atomic. No clipping occurs. */
export type DisplayPart = { text: string; atomic?: boolean };
export type DisplayPage = { text: string; body: string; page: number; total: number; nextCommand?: string };
export type PaginationOptions = { mode: DisplayMode; command: (page: number) => string; title?: string; maxUnits?: number };

/**
 * Returns bounded pages whose raw bodies concatenate to the exact supplied text.
 * Prose can split by code point; URLs and /nobo-help command lines are also protected.
 * Callbacks must be pure and produce the exact implemented continuation syntax.
 */
export function paginateParts(parts: readonly DisplayPart[], options: PaginationOptions): DisplayPage[] {
  const max = options.maxUnits ?? NORMAL_REPLY_UNITS;
  if (!Number.isSafeInteger(max) || max < 32 || max > NORMAL_REPLY_UNITS || parts.length > 4_096) {
    throw new Error("Use a reply budget of 32–3500 string units and at most 4096 parts.");
  }
  const title = options.title ?? "";
  const escapedTitle = renderText(title, options.mode);
  const units: DisplayPart[] = [];
  let inputUnits = 0;
  for (const part of parts) {
    if (typeof part.text !== "string" || !part.text.isWellFormed()) throw new Error("Display text must have valid Unicode boundaries.");
    inputUnits += part.text.length;
    if (inputUnits > 262_144) throw new Error("Too much detail for one pagination operation; select one record or a smaller evidence scope.");
    if (part.atomic) units.push(part);
    else {
      // Exact text survives; do not alter URL query strings or split a copied command.
      for (const match of part.text.matchAll(/https?:\/\/[^\s]+|\/nobo-help[^\r\n]*|[\s\S]/gu)) {
        units.push({ text: match[0], atomic: match[0].length > 2 });
      }
    }
  }
  const encoded = units.map(part => renderText(part.text, options.mode));
  let remaining = encoded.reduce((sum, value) => sum + value.length, 0);
  // At least one code point per nonempty page. This upper bound reserves total digits
  // without repeatedly repaginating as the actual page count changes.
  const totalBound = Math.min(10_000, Math.max(1, units.length));
  const header = (page: number, total: number) => `${escapedTitle ? `${escapedTitle}\n` : ""}Page ${page}/${total}\n`;
  const bodies: { body: string; nextCommand?: string }[] = [];
  let cursor = 0;
  do {
    const page = bodies.length + 1;
    if (page > 10_000) throw new Error("Too many detail pages; use a larger reply budget or select a smaller scope.");
    const reservedHeader = header(page, totalBound).length;
    if (remaining <= max - reservedHeader) {
      bodies.push({ body: units.slice(cursor).map(part => part.text).join("") });
      break;
    }
    const nextCommand = boundedText(options.command(page + 1), { label: "Next command", maxBytes: 12_000, trim: false });
    if (/[\r\n]/u.test(nextCommand)) throw new Error("Next command must be one complete line.");
    const capacity = max - reservedHeader - renderText(`\nNext: ${nextCommand}`, options.mode).length;
    if (capacity < 2) throw new Error("Reply budget leaves no detail space after the title and next command; shorten the title/command or increase maxUnits.");
    const start = cursor;
    let used = 0;
    while (cursor < units.length && used + encoded[cursor].length <= capacity) used += encoded[cursor++].length;
    if (start === cursor) throw new Error("An atomic URL, identifier, command, or Unicode character cannot fit this page. Shorten the title/command, increase maxUnits up to 3500, or reject the value before saving; it was not split or dropped.");
    bodies.push({ body: units.slice(start, cursor).map(part => part.text).join(""), nextCommand });
    remaining -= used;
  } while (cursor < units.length);
  return bodies.map(({ body, nextCommand }, index) => ({
    body, page: index + 1, total: bodies.length, ...(nextCommand === undefined ? {} : { nextCommand }),
    text: header(index + 1, bodies.length) + renderText(body, options.mode) +
      (nextCommand === undefined ? "" : renderText(`\nNext: ${nextCommand}`, options.mode)),
  }));
}

export function pageAt(pages: readonly DisplayPage[], page: number): DisplayPage {
  if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) throw new Error(`This view has ${pages.length} page(s); reopen page 1.`);
  return pages[page - 1];
}
