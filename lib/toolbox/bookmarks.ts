import { add, detail, find, InputError, parts, touch, type Feature } from "./core.js";
function safeUrl(value: string) {
  let url: URL; try { url = new URL(value.replace(/^<([^|>]+)(?:\|[^>]+)?>$/, "$1")); } catch { throw new InputError("Enter a complete https:// URL."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new InputError("Bookmarks require HTTPS URLs without embedded credentials.");
  return url.href;
}
export const bookmarks: Feature = {
  id: "bookmarks", title: "Bookmark library", description: "Keep links with notes, tags and read/unread status. Links are never fetched automatically.",
  help: "add Slack docs | https://docs.slack.dev | Useful reference\nread <id> · unread <id> · queue\nurl <id> | https://example.com\nannotate <id> | New note",
  run(entries, verb, args, now) {
    args = args.replace(/<(https:\/\/[^|>]+)\|[^>]+>/g, "$1");
    if (verb === "add") { const [title, raw, note] = parts(args, 3), url = safeUrl(raw); if (entries.some(e => e.data.url === url)) throw new InputError("That URL is already saved. Use list or annotate to update it."); return detail(add(entries, title, `${url}\n${note}`, now, { url, note, read: false })); }
    if (verb === "queue") return entries.filter(e => !e.data.read).map(e => `${e.id.slice(0,8)} · ${e.title}\n${e.data.url}`).join("\n") || "Your reading queue is clear.";
    if (["read", "unread", "url", "annotate"].includes(verb)) {
      const [id, value] = verb === "url" || verb === "annotate" ? parts(args, 2) : [args, ""];
      const entry = find(entries, id);
      if (verb === "url") { const url = safeUrl(value); if (entries.some(e => e.id !== entry.id && e.data.url === url)) throw new InputError("That URL is already saved."); entry.data.url = url; }
      else if (verb === "annotate") entry.data.note = value;
      else entry.data.read = verb === "read";
      entry.body = `${entry.data.url}\n${entry.data.note}`; touch(entry, now); return detail(entry);
    }
  }
};
