import {
  add,
  find,
  InputError,
  label,
  parts,
  touch,
  type Feature,
} from "./core.js";
export function formatText(mode: string, text: string) {
  const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    unmarked = lines.map((s) => s.replace(/^(?:[-*•]|\d+[.)])\s+/, ""));
  switch (mode) {
    case "trim":
      return text.trim();
    case "bullets":
      return unmarked.map((s) => "- " + s).join("\n");
    case "numbered":
      return unmarked.map((s, i) => i + 1 + ". " + s).join("\n");
    case "dedupe":
      return [...new Set(lines)].join("\n");
    case "sort":
      return [...lines].sort((a, b) => a.localeCompare(b, "en")).join("\n");
    case "slug":
      return text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    case "json":
      try {
        return JSON.stringify(
          JSON.parse(text, (_key, value: unknown) => {
            if (
              typeof value === "number" &&
              (!Number.isFinite(value) ||
                (Number.isInteger(value) && !Number.isSafeInteger(value)))
            )
              throw new Error("unsafe number");
            return value;
          }),
          null,
          2,
        );
      } catch {
        throw new InputError(
          "Use valid JSON with finite numbers and safe integers (quote large IDs).",
        );
      }
    default:
      throw new InputError(
        "Format must be trim, bullets, numbered, dedupe, sort, slug or json.",
      );
  }
}
export const textkit: Feature = {
  render: (e) =>
    `${label(e)}\n${e.body}\n${typeof e.data.previous === "string" ? "One-step undo available." : "No previous edit to undo."}`,
  id: "textkit",
  title: "Text formatting workbench",
  description:
    "Preview deterministic formatting, apply changes with one-step undo and inspect text statistics.",
  help: "save Draft | First line\nSecond line\npreview <id> | bullets\napply <id> | numbered\nundo <id>\nstats <id>\nedit <id> | New text\nFormats: trim, bullets, numbered, dedupe, sort, slug, json.",
  run(entries, verb, args, now) {
    if (verb === "save") {
      const [title, text] = parts(args, 2);
      return label(add(entries, title, text, now, { previous: null }));
    }
    if (verb === "stats") {
      const e = find(entries, args),
        words = [
          ...new Intl.Segmenter("en", { granularity: "word" }).segment(e.body),
        ].filter((s) => s.isWordLike).length,
        characters = [
          ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
            e.body,
          ),
        ].length;
      return `${label(e)}\n${words} words · ${characters} visible characters · ${e.body.split(/\r?\n/).length} lines · ${Buffer.byteLength(e.body)} UTF-8 bytes`;
    }
    if (verb === "undo") {
      const e = find(entries, args);
      if (typeof e.data.previous !== "string")
        throw new InputError("No previous edit to undo.");
      e.body = e.data.previous;
      e.data.previous = null;
      touch(e, now);
      return e.body;
    }
    if (["preview", "apply", "edit"].includes(verb)) {
      const [id, value] = parts(args, 2),
        e = find(entries, id),
        result = verb === "edit" ? value : formatText(value, e.body);
      if (!result.trim())
        throw new InputError(
          "That transformation produces empty text; nothing changed.",
        );
      if (result.length > 6000)
        throw new InputError("Formatted text exceeds 6000 characters.");
      if (verb !== "preview") {
        e.data.previous = e.body;
        e.body = result;
        touch(e, now);
      }
      return (
        result +
        (verb === "preview"
          ? "\n\nPreview only; use apply to save this format."
          : "")
      );
    }
  },
};
