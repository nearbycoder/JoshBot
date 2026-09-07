import {
  add,
  find,
  InputError,
  label,
  number,
  parts,
  touch,
  type Entry,
  type Feature,
} from "./core.js";
type Item = { number: number; text: string; done: boolean };
const items = (entry: Entry) => entry.data.items as Item[];
const render = (entry: Entry) =>
  `${label(entry)}\n${items(entry).filter((i) => i.done).length}/${items(entry).length} complete\n${items(
    entry,
  )
    .map((i) => `${i.done ? "☑" : "☐"} ${i.number}. ${i.text}`)
    .join("\n")}`;
export const checklists: Feature = {
  render: render,
  id: "checklists",
  title: "Project checklists",
  description:
    "Private checklists with stable item numbers, progress and reusable resets.",
  help: "create Release checklist\nitem <id> | Run tests\ndone <id> | 1 · undo <id> | 1\nprogress <id>\nremove <id> | 1 | confirm\nreset <id> confirm",
  run(entries, verb, args, now) {
    if (verb === "create")
      return render(add(entries, args, "", now, { items: [], next: 1 }));
    if (verb === "progress") return render(find(entries, args));
    if (verb === "reset") {
      const match = args.match(/^(\S+) confirm$/);
      if (!match)
        throw new InputError("Use reset <id> confirm to uncheck all items.");
      const entry = find(entries, match[1]);
      items(entry).forEach((i) => (i.done = false));
      touch(entry, now);
      return render(entry);
    }
    if (["item", "done", "undo", "remove"].includes(verb)) {
      const [id, value, confirm] = parts(args, verb === "remove" ? 3 : 2);
      const entry = find(entries, id),
        list = items(entry);
      if (verb === "item") {
        if (list.length >= 50)
          throw new InputError("Use at most 50 items per checklist.");
        list.push({
          number: entry.data.next as number,
          text: value,
          done: false,
        });
        entry.data.next = (entry.data.next as number) + 1;
      } else {
        const item = list.find((i) => i.number === number(value, 1));
        if (!item) throw new InputError("Item number not found.");
        if (verb === "remove") {
          if (confirm !== "confirm")
            throw new InputError("Use remove <id> | <number> | confirm.");
          list.splice(list.indexOf(item), 1);
        } else item.done = verb === "done";
      }
      entry.body = list.map((i) => i.text).join("\n");
      touch(entry, now);
      return render(entry);
    }
  },
};
