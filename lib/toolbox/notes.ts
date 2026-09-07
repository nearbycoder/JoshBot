import { add, detail, find, parts, requireText, touch, type Feature } from "./core.js";
export const notes: Feature = {
  id: "notes", title: "Private notebook", description: "Keep searchable, tagged personal notes. Only you in this workspace can read them through NoBo.",
  help: "add Launch ideas | Start with a small beta\nedit <id> | Replacement body\nappend <id> | Another thought\nSearch with list beta; tag <id> | work, launch",
  run(entries, verb, args, now) {
    if (verb === "add") { const [title, body] = parts(args, 2); return detail(add(entries, title, requireText(body), now)); }
    if (verb === "edit" || verb === "append") { const [id, body] = parts(args, 2); const entry = find(entries, id); entry.body = requireText(verb === "append" ? `${entry.body}\n${body}` : body, "Note", 10000); touch(entry, now); return detail(entry); }
  }
};
