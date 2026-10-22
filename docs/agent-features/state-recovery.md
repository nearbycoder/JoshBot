# Unreadable personal-agent state

`AgentFeatureStore.read<T>()` returns `null` only when the scoped key is absent. Present JSON `null` (including whitespace around it) and invalid JSON raise `AgentStateCorruptionError`. The error carries only validated workspace/user/feature/key identifiers and a `stored-null` or `invalid-json` reason, never the raw value or parser error. Valid nonnull JSON still goes through the existing domain validators; this boundary does not validate feature schemas or migrate versions.

The runtime retains the first store diagnosis for that invocation, even if a feature catches it and returns a generic failure or an empty list. It returns a private operator-recovery message. Subsequent store/service calls are refused; a pending store read is checked again before its result can be transformed. There is no diagnostic preflight read, scan, global cache, automatic initialization, or provider call. Existing budgets, physical admission tracking, cancellation and request receipts remain in force. Cancellation takes precedence; already dispatched writes cannot be rolled back. Receipts may still be finalized and suppress replay without storing the diagnosis or raw data.

Ordinary commands cannot recover unreadable data. Do not tell the owner to export or delete records that cannot be read. Static `help` remains available. The owner should contact the app operator, identify the affected feature and workspace, and wait for operator confirmation before retrying with a fresh request. An error describes what this invocation observed; another invocation or operator may since have changed the value.

## Operator procedure for the known literal-null case

This is a manual incident procedure, **not an installed helper, public command, generic reset, or migration**. No live repair was performed for this change. The independent report seeded the value directly; ordinary feature commands did not produce it, and no data loss was observed. Replacing literal null creates an empty feature state; it cannot reconstruct previously lost records. If restoration from a known good backup is needed, stop and obtain a separate restoration plan.

This exact empty-state procedure is verified only for these feature IDs at schema version 1:

`task-breakdown`, `deadline-backplan`, `capacity-forecast`, `context-batch`, `scope-slicer`, `blocker-lab`, `premortem`, `assumption-tests`, `decision-journal`, `estimate-calibration`.

The shared diagnosis also applies to other features, including later batches. Do not assume they use the same key, version or empty state; review their contracts separately before any repair.

1. Verify the affected workspace and user through trusted app identity records and the owner's incident request. Establish operator authorization for that exact scope and the owner's intent to restore an empty namespace after backup. Do not infer identity from free-form message text. Ask the owner to pause commands for this feature during repair.
2. Validate both IDs with `validateAgentIdentity(owner)` and validate the feature with `agentStorePrefix(owner, featureId)`. Additionally require an exact match to the ten-feature allowlist above and the literal local key `state`. Construct the one full key as `agentStorePrefix(owner, featureId) + "state"`. Do not accept arbitrary full keys, prefixes, wildcard scans, alternate keys, other users, or request-receipt keys.
3. Read that one key using the existing backend. Require the **exact observed raw string** to equal `"null"` (four UTF-8 bytes). Absence (`null` from `backend.get`), whitespace-padded null, invalid JSON, valid JSON and all other values are outside this procedure: stop without writing. Do not trim, parse-and-reserialize, or replace a failed read with an empty state.
4. Before any CAS, back up those exact bytes to an approved durable, access-controlled location. Use a unique, exclusively created backup (for example `wx` with mode `0600` in a restricted directory), flush it to durable storage, and read it back to verify exact bytes. Record the verified workspace, user, feature, local key, observed bytes/checksum, schema version, operator, incident and time in a protected manifest. Do not put raw state in chat or general logs. A failed or unverified backup means **no repair**.
5. Confirm the reviewed feature still accepts exactly `{"version":1,"records":[]}` as its empty state. Make **one** call through the existing backend, with no TTL argument:

   ```ts
   // Only after the allowlist, exact scope/value checks and durable backup above.
   const repaired = await backend.compareSet(fullKey, observedRaw, '{"version":1,"records":[]}');
   ```

   `observedRaw` must be the exact `"null"` string from step 3, never JavaScript `null`. The backend compares bytes atomically; no separate `SET`, `DEL`, store `update`, transform that ignores current state, or automatic retry is permitted. Any changed value, including a valid replacement, causes refusal and must remain untouched.
6. If CAS returns false or throws, stop. Preserve the backup; investigate the current value separately. Do not reread and retry under the old approval, force an overwrite, or guess that the repair succeeded. A transport failure may have happened after dispatch. Exact-value CAS does not detect a value changed away from and then back to the same four bytes; it is not a revision/history guarantee.
7. After confirmed CAS success, perform one scoped read to verify the replacement. If the value changed again, preserve it and investigate; do not restore the backup over new work. Confirm with the owner that a fresh `list` now reads an empty namespace and normal creation works. Keep the backup and incident record according to the operator's existing retention policy. A retry using an old request receipt remains suppressed, so use a fresh command invocation.

No other malformed-state repair is authorized by this runbook. Valid JSON with an unsupported domain schema remains the feature validator's responsibility; the runtime cannot reliably identify arbitrary domain errors by their message. Oversized state retains its existing storage-limit error. Unreadable exports and normal deletion are not substitutes for operator backup/recovery.

## Local verification and limits

`tests/agent-runtime.test.ts` uses the real runtime and scoped store with an isolated memory backend. It covers all ten features' absent/null/invalid-JSON reads and mutations; unchanged raw bytes; workspace/user isolation; static help; caught errors; blocked subsequent services/writes; pending reads; CAS retries; cancellation; and receipt replay. Its operator-protocol test writes a temporary restricted backup, verifies it, and exercises exact-value CAS success/refusal only against the fake backend, including a racing valid replacement. This checks the underlying CAS contract, not a deployed recovery tool or operator authorization system.

`tests/agent-feature-kit.test.ts` retains malformed/version/schema preservation checks and expects an actionable private runtime reply for store-level corruption. No production Redis, Slack, provider, model, backup system or live repair is exercised. The store still relies on feature validators to produce nonnull valid next states; the generic types and backend interface are unchanged.
