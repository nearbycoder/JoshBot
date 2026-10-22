# Change impact map

Locally implemented, unregistered and not deployed. Parent integration owns registration/release. This is a private local dependency map with zero model/search/context/live calls. A disposition records what the user reports; it never edits external documents, routines or commitments.

```
create Launch dependencies
item MAP add Launch date | assumption | Me
item MAP add Announcement draft | document | Me
depends MAP ANNOUNCEMENT | DATE | Draft contains the launch date
change MAP DATE | Launch moved by one week
impact MAP CHANGE
resolve MAP CHANGE ANNOUNCEMENT | reviewed | Updated the date in my draft
close MAP CHANGE
```

Use actual full IDs returned by commands. The announcement is downstream because its saved directed edge says it depends on the launch date. Impact shows this exact edge/path; resolution is user-reported. The source item is the changed input and excluded from its own review queue, even when a cycle returns to it. A source with no downstream items has an empty queue, not a certification of external readiness.

Reverse breadth-first search visits each item once across at most 40 items/80 edges, computes shortest paths and deduplicates impacts. Neighbor ties sort by dependent ID then edge ID. Cycles and self-links are allowed; duplicate directed edges are rejected. Every current affected item includes its real node/edge path and an emitted `path MAP CHANGE ITEM [PAGE]` command with complete saved reasons. No edge is inferred. An independent repeated-relaxation oracle verifies distances in tests; each displayed edge is checked against saved endpoints.

Items have label, type (assumption/document/routine/commitment/other), and inert owner label. Maintain with `item MAP edit ITEM | label|type|ownerLabel | VALUE`, `item MAP clear ITEM label|ownerLabel confirm` (choose one), or `item MAP remove ITEM confirm`. Removal explicitly also erases incident edges and changes sourced at the removed item; other historical dispositions retain their item IDs until refresh/removal. `edge-edit MAP EDGE | DEPENDENT | PREREQUISITE | REASON` edits all edge fields; `edge-remove MAP EDGE confirm` erases them. Map title uses `edit MAP | title | TEXT` / `clear MAP title confirm`.

Graph/item/title changes issue a fresh graph UUID, leaving previous change queues/dispositions/status clearly historical. A previously closed change does not certify a changed graph, even if edits later restore the same content. Resolve/close/reopen refuse stale scope. `refresh MAP CHANGE confirm` captures the current source/graph/queue, explicitly erases old dispositions and reopens. Historical records retain source snapshot, queue IDs, fingerprint and dispositions, not the old graph; historical paths are unavailable after edits. The report states this instead of presenting current edges as historical evidence.

`change-edit MAP CHANGE confirm | SOURCE_ITEM | DESCRIPTION` replaces all change inputs and scope, clearing prior dispositions after confirmation. `change-remove MAP CHANGE confirm` removes the complete change and its retained snapshots. Current open changes accept `resolve MAP CHANGE ITEM | reviewed|not-affected | REASON` (choose one); using it again edits the disposition. `close MAP CHANGE` requires a reasoned disposition for every affected item. `reopen MAP CHANGE` permits amendments. `resolve-remove MAP CHANGE ITEM confirm` erases one disposition and reopens; historical graphs still require refresh. Required item/edge/change fields can be erased with their owning record.

`list [PAGE]`, `show MAP [PAGE]`, `export MAP` and `delete MAP confirm` retrieve/delete complete owned data. Show/export include graph items/edges/reasons, all source snapshots, queues, revisions/fingerprints, dispositions and status. All emitted pages bind full-content hash and revision; known IDs/hashes/URLs are atomic. Normal replies ≤3,500 JavaScript units; full JSON export including envelope ≤24,576 serialized UTF-8 bytes. Static metadata help is the full parser grammar. Pipe fields trim outer whitespace and support `\|` / `\\` escapes.

Limits: eight maps, 40 items, 80 edges, five changes/map. Title/item label/edge reason 160, owner/disposition reason 96, change description 400 UTF-8 bytes. Command ≤16,000 bytes; state/content limits 49,152/32,768 serialized bytes. Count and byte caps both apply. Before admitting changes or graph edits, dynamic projection reserves maximal escaped disposition reasons/status/revision growth for every affected item, and the larger of retained historic scope versus a current-graph refresh. Required close/refresh remains possible for admitted records; optional new content may be refused. No eviction, global cache or background work.

Mutations bind the complete intended root before retryable CAS. Concurrent child/graph edits and deletion defeat stale resolve/close; unrelated roots can retry. Every non-erasure write refuses at record revision 999,999,999. Graph identities use fresh UUIDs; no collection/assessment counter resets or recycled IDs. Retrieval and explicit erasure remain available. Only strictly reducing confirmed whole-root deletion bypasses feature quota for fully valid individually exportable legacy aggregates, leaving retained records identical. Current/historical enums and queue completeness are validated; unknown fields, malformed JSON and invalid versions remain byte-identical. Backend exceptions are sanitized; uncertain save wording asks inspection before retry.

Verification: Node 24, 1 GiB heap, `node --import tsx --test --test-concurrency=1 tests/agent-change-impact.test.ts`; 11 focused tests, zero skips, plus project typecheck/diff. Tests cover the catalog workflow, all edits/cleanup, independent graph distances/ties/cycles, actual path provenance, maximum counts and complete emitted retrieval, lifecycle completion at escaping saturation, stale scope/ABA/real CAS, historical schema corruption, legacy aggregate recovery, tenant isolation, cancellation and diagnostic privacy. No live Redis/Slack, deployment or performance claim.
