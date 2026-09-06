import assert from "node:assert/strict";
import test from "node:test";
import { assessSlackAgentScopes } from "../lib/slack-readiness.js";

test("Agent readiness distinguishes missing grants from unchecked feature settings", () => {
  const missing = assessSlackAgentScopes(["chat:write"], "auto");
  assert.equal(missing.state, "missing-scopes");
  assert.deepEqual(missing.missingScopes, ["assistant:write"]);
  assert.match(missing.detail, /reinstall/);
  const grants = assessSlackAgentScopes(["assistant:write", "chat:write"], "auto");
  assert.equal(grants.state, "scopes-present");
  assert.match(grants.detail, /still require verification/);
  assert.equal(assessSlackAgentScopes(undefined, "auto").state, "unchecked");
  assert.equal(assessSlackAgentScopes([], "off").state, "disabled");
});
