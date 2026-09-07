import { randomUUID } from "node:crypto";
import { getRedisClient } from "../redis.js";

export type Entry = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
};
export type Feature = {
  id: string;
  title: string;
  description: string;
  help: string;
  render?: (entry: Entry, now: Date) => string;
  validateRename?: (entries: Entry[], entry: Entry, title: string) => void;
  run: (
    entries: Entry[],
    verb: string,
    args: string,
    now: Date,
  ) => string | undefined;
};
export class InputError extends Error {}
export function requireText(text: string, label = "Text", max = 2000) {
  if (!text.trim() || text.length > max)
    throw new InputError(`${label} must contain 1–${max} characters.`);
  return text.trim();
}
export function splitFields(args: string) {
  const values: string[] = [];
  let field = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "\\" && ["|", "\\"].includes(args[i + 1]))
      field += args[++i];
    else if (args[i] === "|") {
      values.push(field.trim());
      field = "";
    } else field += args[i];
  }
  values.push(field.trim());
  return values;
}
export function parts(args: string, count: number) {
  const values = splitFields(args);
  if (values.length !== count || values.some((v) => !v))
    throw new InputError(
      `Expected ${count} nonempty fields separated by |. Run help for examples.`,
    );
  return values;
}
export function number(text: string, min = 0, max = 1000000) {
  if (!text.trim()) throw new InputError("Enter a number.");
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new InputError(`Enter a number from ${min} to ${max}.`);
  return value;
}
export function date(text: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(text).toISOString().slice(0, 10) !== text
  )
    throw new InputError("Use a real date in YYYY-MM-DD format.");
  return text;
}
export function find(entries: Entry[], id: string) {
  if (!/^[a-f0-9-]{8,36}$/i.test(id.trim()))
    throw new InputError(
      "Use the entry ID shown by list (at least 8 characters).",
    );
  const matches = entries.filter((e) => e.id.startsWith(id.trim()));
  if (matches.length !== 1)
    throw new InputError(
      matches.length
        ? "That ID is ambiguous; use the full ID."
        : "Entry not found in your toolbox.",
    );
  return matches[0];
}
export function add(
  entries: Entry[],
  title: string,
  body: string,
  now: Date,
  data: Record<string, unknown> = {},
) {
  if (entries.length >= 100)
    throw new InputError(
      "This tool holds 100 entries. Export and delete older entries first.",
    );
  const entry: Entry = {
    id: randomUUID(),
    title: requireText(title, "Title", 120),
    body,
    data,
    tags: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  entries.push(entry);
  return entry;
}
export function touch(entry: Entry, now: Date) {
  entry.updatedAt = now.toISOString();
}
export function label(entry: Entry) {
  return `${entry.id.slice(0, 8)} · ${entry.title}`;
}
export function detail(entry: Entry) {
  return `${label(entry)}\n${entry.body}\n${entry.tags.length ? `Tags: ${entry.tags.join(", ")}\n` : ""}${Object.keys(entry.data).length ? JSON.stringify(entry.data, null, 2) + "\n" : ""}Updated: ${entry.updatedAt}`;
}
export const commonHelp =
  "list [search] · page <number> · show <id> · rename <id> | <title> · tag <id> | <comma-separated tags or -> · export <id> · delete <id> confirm";
export function execute(
  feature: Feature,
  entries: Entry[],
  command: string,
  now = new Date(),
) {
  const [, verb = "help", args = ""] =
    command.trim().match(/^(\S+)?(?:\s+([\s\S]*))?$/) ?? [];
  if (verb === "help")
    return `${feature.title}\n${feature.description}\n\n${feature.help}\n\nShared commands: ${commonHelp}`;
  if (verb === "list" || verb === "page") {
    const offset = verb === "page" ? (number(args, 1, 5) - 1) * 20 : 0;
    if (!Number.isInteger(offset / 20))
      throw new InputError("Page must be a whole number.");
    const filtered = entries
      .filter(
        (e) =>
          verb === "page" ||
          `${e.title} ${e.body} ${e.tags.join(" ")}`
            .toLowerCase()
            .includes(args.toLowerCase()),
      )
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (offset >= filtered.length && offset > 0)
      return "That page has no entries. Use page 1 or list <search>.";
    return filtered.length
      ? `${feature.title}: ${filtered.length} entries\n${filtered
          .slice(offset, offset + 20)
          .map(label)
          .join(
            "\n",
          )}\nShowing ${Math.min(offset + 1, filtered.length)}–${Math.min(offset + 20, filtered.length)}. Use page 2–5 for the full unfiltered list, or show <id>.`
      : "No entries yet. Run help to get started.";
  }
  const render = (entry: Entry) =>
    (feature.render?.(entry, now) ?? detail(entry)) +
    (feature.render && entry.tags.length
      ? `\nTags: ${entry.tags.join(", ")}`
      : "");
  if (["show", "export"].includes(verb))
    return verb === "export"
      ? JSON.stringify(find(entries, args), null, 2)
      : render(find(entries, args));
  if (verb === "delete") {
    const match = args.match(/^(\S+) confirm$/);
    if (!match)
      throw new InputError(
        "Delete is permanent. Use delete <id> confirm; export <id> first to keep a copy.",
      );
    const entry = find(entries, match[1]);
    entries.splice(entries.indexOf(entry), 1);
    return `Deleted ${label(entry)}. No undo; an exported copy can be retained.`;
  }
  if (verb === "rename" || verb === "tag") {
    const [id, value] = parts(args, 2);
    const entry = find(entries, id);
    if (verb === "rename") {
      const title = requireText(value, "Title", 120);
      feature.validateRename?.(entries, entry, title);
      entry.title = title;
    } else {
      const tags =
        value === "-"
          ? []
          : [
              ...new Set(
                value
                  .split(",")
                  .map((t) => requireText(t, "Tag", 30).toLowerCase()),
              ),
            ];
      if (tags.length > 10) throw new InputError("Use at most 10 tags.");
      entry.tags = tags;
    }
    touch(entry, now);
    return render(entry);
  }
  const result = feature.run(entries, verb, args, now);
  if (result === undefined)
    throw new InputError("Unknown command. Run help for this tool's commands.");
  return result;
}

type State = { entries: Entry[]; receipts: { id: string; result: string }[] };
export type Store = {
  get(key: string): Promise<string | null>;
  compareSet(
    key: string,
    previous: string | null,
    next: string,
  ): Promise<boolean>;
};
const cas =
  "local old=redis.call('GET',KEYS[1]); if (old or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
export async function runFeature(
  feature: Feature,
  command: string,
  owner: { userId?: string; teamId?: string },
  requestId?: string,
  store?: Store,
  now = new Date(),
) {
  if (
    !owner.userId ||
    !owner.teamId ||
    !/^[A-Z0-9]+$/.test(owner.userId + owner.teamId)
  )
    return "This tool needs a signed Slack workspace and user context.";
  if (command.length > 3000)
    return "Commands may contain at most 3000 characters.";
  try {
    // Help works even when Redis is unavailable. Other operations fail closed.
    if (!command.trim() || command.trim() === "help")
      return execute(feature, [], "help", now);
    if (!store) {
      const redis = await getRedisClient();
      if (!redis)
        return "The existing Redis connection is unavailable. Nothing was changed.";
      store = {
        get: (key) => redis.get(key),
        compareSet: async (key, previous, next) =>
          (await redis.eval(cas, {
            keys: [key],
            arguments: [previous ?? "", next],
          })) === 1,
      };
    }
    const key = `nobo:toolbox:v1:${owner.teamId}:${owner.userId}:${feature.id}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await store.get(key);
      const state: State = previous
        ? JSON.parse(previous)
        : { entries: [], receipts: [] };
      const receipt =
        requestId && state.receipts.find((r) => r.id === requestId);
      if (receipt) return receipt.result;
      const before = JSON.stringify(state.entries);
      const beforeCount = state.entries.length;
      const result = execute(feature, state.entries, command, now);
      if (result.length > 28000)
        throw new InputError(
          "Result is too large. Use show/export on a single entry.",
        );
      if (JSON.stringify(state.entries) === before) return result;
      if (
        state.entries.some((e) => Buffer.byteLength(JSON.stringify(e)) > 16000)
      )
        throw new InputError(
          "Entry limit reached (16 KB). Split it into separate entries; nothing changed.",
        );
      const deleted = state.entries.length < beforeCount;
      if (deleted) {
        // Preserve retry identities without retaining deleted content in cached replies.
        state.receipts = state.receipts.map((receipt) => ({
          id: receipt.id,
          result:
            "This earlier request already completed. Its cached output was cleared after a deletion; use list to see current entries.",
        }));
      }
      if (requestId)
        state.receipts = [
          ...state.receipts,
          {
            id: requestId,
            result: deleted
              ? "Deletion completed. Use list to see current entries."
              : result,
          },
        ].slice(-40);
      const next = JSON.stringify(state);
      if (Buffer.byteLength(next) > 512000)
        throw new InputError(
          "Tool storage is full (500 KB). Export and delete older entries first.",
        );
      if (await store.compareSet(key, previous, next)) return result;
    }
    return "Another change happened at the same time. Nothing from this request was saved; please retry.";
  } catch (error) {
    if (error instanceof InputError) return error.message;
    return "The toolbox could not complete this request. Please retry; if saving was interrupted, list entries before repeating it.";
  }
}
