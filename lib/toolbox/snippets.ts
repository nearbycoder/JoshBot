import {
  add,
  find,
  InputError,
  label,
  parts,
  touch,
  type Entry,
  type Feature,
} from "./core.js";
type Version = { revision: number; code: string; at: string };
const versions = (e: Entry) => e.data.versions as Version[];
function save(e: Entry, code: string, now: Date) {
  if (code.length > 2000)
    throw new InputError("Code is limited to 2000 characters per revision.");
  e.body = code;
  e.data.revision = (e.data.revision as number) + 1;
  e.data.versions = [
    ...versions(e),
    { revision: e.data.revision, code, at: now.toISOString() },
  ].slice(-5);
  touch(e, now);
}
export const snippets: Feature = {
  render: (e) =>
    `${label(e)} · ${e.data.language} · revision ${e.data.revision}\n${e.body}\nUse history <id> for retained versions. Code is never executed.`,
  id: "snippets",
  title: "Versioned code snippets",
  description:
    "Store code with language labels, five retained revisions and explicit rollback. Never executes code.",
  help: "add Query | sql | SELECT 1;\nedit <id> | SELECT 2;\ncopy <id>\nhistory <id>\nrestore <id> | 1 | confirm",
  run(entries, verb, args, now) {
    if (verb === "add") {
      const [title, language, code] = parts(args, 3);
      if (!/^[a-z0-9+#.-]{1,24}$/i.test(language))
        throw new InputError(
          "Use a short language label such as sql, typescript or c++.",
        );
      if (code.length > 2000)
        throw new InputError("Code is limited to 2000 characters.");
      return label(
        add(entries, title, code, now, {
          language,
          revision: 1,
          versions: [{ revision: 1, code, at: now.toISOString() }],
        }),
      );
    }
    if (verb === "copy") {
      const e = find(entries, args);
      return `${e.title} (${e.data.language}, revision ${e.data.revision})\n\n${e.body}\n\nCopy only — code was not executed.`;
    }
    if (verb === "history") {
      const e = find(entries, args);
      return versions(e)
        .map((v) => `Revision ${v.revision} · ${v.at}\n${v.code}`)
        .join("\n\n");
    }
    if (verb === "edit" || verb === "restore") {
      const [id, value, confirm] = parts(args, verb === "restore" ? 3 : 2),
        e = find(entries, id);
      if (verb === "restore") {
        if (confirm !== "confirm")
          throw new InputError("Use restore <id> | <revision> | confirm.");
        const version = versions(e).find((v) => String(v.revision) === value);
        if (!version)
          throw new InputError(
            "Revision not retained; history shows the last five.",
          );
        save(e, version.code, now);
      } else save(e, value, now);
      return `${label(e)}\nSaved revision ${e.data.revision}; last five revisions retained.`;
    }
  },
};
