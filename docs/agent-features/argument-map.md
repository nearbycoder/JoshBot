# Argument map

Implemented locally; **unregistered and not deployed**. Parent registration must wire the metadata and lazy implementation. Prefix commands with `/nobo-help agent argument-map`. `help` is static and gives every command.

`create Use a shorter onboarding form` returns a map ID and a separate root claim ID. Add `node MAP add reason | Fewer fields reduce initial effort` and `node MAP add objection | Required information may be missing`. Copy the returned full node IDs into `link MAP REASON | supports | ROOT` and `link MAP OBJECTION | challenges | REASON`. `audit MAP` identifies the unsupported reason and unanswered objection. These flags mean recorded support/response is missing; they do not assess truth or persuasiveness.

Node kinds are `claim`, `reason`, `objection`, `rebuttal` and `evidence`. `node MAP edit NODE | TYPE | text` edits type/text while preserving identity; `position MAP | text` edits the main root position. A root must remain a claim. `label MAP EVIDENCE_NODE | label` adds/changes a user evidence label; the label is not verification. Remove the label explicitly before changing that node away from evidence.

Edges point from the contributing node to its target:

- `supports`: claim/reason/rebuttal → claim/reason/rebuttal.
- `challenges`: objection → any non-objection.
- `rebuts`: rebuttal → objection.
- `evidences`: evidence → any non-evidence.

`link MAP FROM | RELATION | TO` creates an identified edge. `link-edit MAP EDGE | FROM | RELATION | TO` edits every accepted edge field. Full validation rejects missing nodes, wrong types, self-links, duplicate triples and directed cycles without partial mutation. Remove incompatible edges before changing a node's type. A cycle means circular dependence in the recorded graph, not independent support and not proof that a position is false. Accepted maps are acyclic; audits explicitly report this. A rebuttal edge means a response was recorded, not that it defeated an objection.

`remove MAP node|edge|label CHILD confirm` removes the selected kind. Node removal reports how many attached edges were also removed and preserves all other nodes. It cannot remove the root alone; `delete MAP confirm` deletes the entire map. `delete MAP` only displays the confirmation command. No history, automatic expiry or eviction exists.

`view MAP [page N] [rev N]` renders breadth-first adjacency starting at the position, following incoming edges. Every node expands once; shared branches appear as identified references with all connecting edge IDs. Disconnected components are also listed. This is an adjacency view, not an exponential path enumeration. A visited set and bounded queue process at most 32 nodes/64 edges. Cycle checks use bounded indegrees/outgoing adjacency (topological traversal). `audit` lists unsupported claim/reason/rebuttal leaves, unanswered objections and unlabeled evidence. `show` exposes exact complete JSON fields. Both accept the same page/revision suffix; continuation commands fail on a changed revision.

`list [page]` lists up to ten maps, labeled position previews, counts and usage; `show` retains full positions. `export MAP` returns one complete JSON feature/version envelope within 24,576 UTF-8 bytes. Every accepted field/ID is available through show/export. Pipe fields trim outer whitespace and decode `\|`/`\\`; plain slash output is not double escaped.

The sole `state` value has a strict version-1 schema. Limits: ten maps, 32 nodes including root, 64 edges/map, node text at most 600 UTF-8 bytes, evidence labels 200 bytes. Serialized JSON including Unicode/escaping must fit 32,768 new-content bytes, 49,152 total bytes and 24,576 exported bytes per root. Admission projects maximum revision widths and validates all report renderings. Nodes, edges and labels are explicit new content, with no mandatory future generated output or status. Byte quotas can fill before count limits. Quota errors preserve data and point to list/export/delete. Domain validation precedes all writes, including deletion; malformed data is preserved and requires scoped maintainer repair, never a silent reset.

IDs are generated outside synchronous CAS callbacks. Every mutation rechecks the observed revision against freshly validated state on each retry, so a concurrent deletion/edit wins. The real shared runtime supplies owner isolation, deduplication, deadline and cancellation; an already sent CAS cannot be rolled back, so inspect uncertain saves. Metadata exactly declares zero generations/searches/context calls, eight reads and four updates; this module uses one logical read and at most one update per command, no background work or external effects.

Verification: seven substantive tests in `tests/agent-argument-map.test.ts` use the actual runtime/scoped store and throwing services. They cover the catalog, typed edges/cycles, shared diamonds/disconnected branches, every field edit/removal, a 32-node/64-edge DAG with complete Unicode pages/export, quotas, corrupt state/owner isolation and a real CAS deletion conflict. Run `node --import tsx --test tests/agent-argument-map.test.ts`, project `tsc --noEmit`, and `git diff --check`. This is local verification, not live Slack/deployment evidence.
