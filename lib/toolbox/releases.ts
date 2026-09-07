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
type Gate = {
  number: number;
  name: string;
  owner: string;
  status: "pending" | "pass" | "blocked";
  evidence: string;
  at: string | null;
};
const gates = (e: Entry) => e.data.gates as Gate[];
export function readiness(e: Entry) {
  const rows = gates(e),
    passed = rows.filter((g) => g.status === "pass").length;
  return `${label(e)}\n${rows.length && passed === rows.length ? "READY according to your recorded evidence" : "NOT READY"} · ${passed}/${rows.length} gates passed\n${rows.map((g) => `#${g.number} ${g.name} · ${g.owner} · ${g.status}\nEvidence: ${g.evidence || "not recorded"}`).join("\n")}\nManual readiness record — NoBo has not run CI, verified evidence or deployed anything.`;
}
export const releases: Feature = {
  render: readiness,
  id: "releases",
  title: "Release readiness",
  description:
    "Record named release gates, owners, evidence and blockers before a manual go/no-go decision.",
  help: "create v1.2\ngate <id> | Tests | Josh\nrecord <id> | 1 | pass | CI run URL or verification details\nrecord <id> | 1 | blocked | Failure details\nreadiness <id>\nreset <id> confirm",
  run(entries, verb, args, now) {
    if (verb === "create")
      return readiness(add(entries, args, "", now, { gates: [], next: 1 }));
    if (verb === "readiness") return readiness(find(entries, args));
    if (verb === "reset") {
      const match = args.match(/^(\S+) confirm$/);
      if (!match)
        throw new InputError(
          "Use reset <id> confirm to clear all recorded gate evidence.",
        );
      const e = find(entries, match[1]);
      gates(e).forEach((g) => {
        g.status = "pending";
        g.evidence = "";
        g.at = null;
      });
      e.body = gates(e)
        .map((g) => g.name + " " + g.owner)
        .join("\n");
      touch(e, now);
      return readiness(e);
    }
    if (verb === "gate" || verb === "record") {
      const fields = parts(args, verb === "gate" ? 3 : 4),
        e = find(entries, fields[0]);
      if (verb === "gate") {
        if (gates(e).length >= 30)
          throw new InputError("Use at most 30 release gates.");
        if (
          gates(e).some((g) => g.name.toLowerCase() === fields[1].toLowerCase())
        )
          throw new InputError("Gate already exists.");
        gates(e).push({
          number: Number(e.data.next),
          name: fields[1],
          owner: fields[2],
          status: "pending",
          evidence: "",
          at: null,
        });
        e.data.next = Number(e.data.next) + 1;
      } else {
        const g = gates(e).find((g) => g.number === number(fields[1], 1));
        if (!g) throw new InputError("Gate number not found.");
        if (!["pass", "blocked"].includes(fields[2]))
          throw new InputError("Record pass or blocked with evidence.");
        if (fields[3].length < 5 || fields[3].length > 500)
          throw new InputError(
            "Provide 5–500 characters of evidence or blocker details.",
          );
        g.status = fields[2] as Gate["status"];
        g.evidence = fields[3];
        g.at = now.toISOString();
      }
      e.body = gates(e)
        .map((g) => g.name + " " + g.owner + " " + g.evidence)
        .join("\n");
      touch(e, now);
      return readiness(e);
    }
  },
};
