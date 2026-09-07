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
type Topic = {
  number: number;
  title: string;
  owner: string;
  minutes: number;
  outcome: string;
};
const topics = (e: Entry) => e.data.topics as Topic[];
function timeline(e: Entry) {
  let elapsed = 0;
  const lines = topics(e).map((t) => {
    const start = elapsed;
    elapsed += t.minutes;
    return `${start}–${elapsed} min · #${t.number} ${t.title} · ${t.owner}\nDesired outcome: ${t.outcome}`;
  });
  return `${label(e)}\n${elapsed}/${e.data.budget} minutes planned · ${elapsed > Number(e.data.budget) ? "OVER BUDGET by " + (elapsed - Number(e.data.budget)) + " minutes" : Number(e.data.budget) - elapsed + " minutes spare"}\n\n${lines.join("\n\n")}\nPrivate agenda; no calendar invites sent.`;
}
export const agendas: Feature = {
  render: timeline,
  id: "agendas",
  title: "Timeboxed meeting agendas",
  description:
    "Plan owner-led topics with desired outcomes, ordering and a meeting time budget.",
  help: "create Planning | 45\ntopic <id> | Scope review | Josh | 15 | Agree on scope\ntimeline <id>\nmove <id> | 1 | 2\nminutes <id> | 1 | 10\nremove <id> | 1 | confirm",
  run(entries, verb, args, now) {
    if (verb === "create") {
      const [title, budget] = parts(args, 2);
      return label(
        add(entries, title, "", now, {
          budget: number(budget, 5, 480),
          topics: [],
          next: 1,
        }),
      );
    }
    if (verb === "timeline") return timeline(find(entries, args));
    if (["topic", "move", "minutes", "remove"].includes(verb)) {
      const fields = parts(args, verb === "topic" ? 5 : 3),
        e = find(entries, fields[0]),
        list = topics(e);
      if (verb === "topic") {
        if (list.length >= 30) throw new InputError("Use at most 30 topics.");
        list.push({
          number: Number(e.data.next),
          title: fields[1],
          owner: fields[2],
          minutes: number(fields[3], 1, 240),
          outcome: fields[4],
        });
        e.data.next = Number(e.data.next) + 1;
      } else {
        const topic = list.find((t) => t.number === number(fields[1], 1));
        if (!topic) throw new InputError("Topic number not found.");
        if (verb === "minutes") topic.minutes = number(fields[2], 1, 240);
        else if (verb === "remove") {
          if (fields[2] !== "confirm")
            throw new InputError("Use remove <id> | <number> | confirm.");
          list.splice(list.indexOf(topic), 1);
        } else {
          const position = number(fields[2], 1, list.length);
          if (!Number.isInteger(position))
            throw new InputError("Position must be a whole number.");
          list.splice(list.indexOf(topic), 1);
          list.splice(position - 1, 0, topic);
        }
      }
      e.body = list
        .map((t) => t.title + " " + t.owner + " " + t.outcome)
        .join("\n");
      touch(e, now);
      return timeline(e);
    }
  },
};
