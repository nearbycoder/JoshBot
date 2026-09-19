import assert from "node:assert/strict";
import test from "node:test";
import { handleSlackSlashCommandPayload } from "../lib/slack-commands.js";
import { buildXMediaModal, buildXMediaStatusModal, parseXMediaSubmission, X_MEDIA_MODAL } from "../lib/x-media-modal.js";
import { XMediaError } from "../lib/x-media.js";

const target = { channelId: "C123", userId: "U123", teamId: "T123" };
const link = "https://x.com/NASA/status/1546621144358391808";
const submission = (value = link, metadata = JSON.stringify(target)) => ({
  user: { id: target.userId }, team: { id: target.teamId },
  view: { private_metadata: metadata, state: { values: { link: { url: { value } } } } }
});

test("bare X commands open a channel-bound form without scheduling any upload", async () => {
  for (const [command, text] of [["/nobo-x", "  "], ["/nobo-help", "x"]]) {
    const result = await handleSlackSlashCommandPayload({ command, text, trigger_id: "trigger",
      channel_id: target.channelId, user_id: target.userId, team_id: target.teamId },
    { evaluateAccess: async () => ({ allowed: true }) });
    assert.equal(result.modal?.triggerId, "trigger");
    assert.deepEqual(result.modal?.view, buildXMediaModal(target));
    assert.equal(result.media, undefined);
    assert.equal(result.response.response_type, "ephemeral");
  }
});

test("form has one required focused input, clear destination and explicit upload action", () => {
  const modal = buildXMediaModal(target);
  assert.equal(modal.callback_id, X_MEDIA_MODAL);
  assert.equal(modal.submit?.text, "Upload media");
  assert.deepEqual(JSON.parse(modal.private_metadata!), target);
  const input = modal.blocks.filter(block => block.type === "input");
  assert.equal(input.length, 1);
  assert.match(JSON.stringify(modal.blocks), /C123/);
  assert.match(JSON.stringify(input), /focus_on_load/);
  assert.ok(!JSON.stringify(modal).includes("response_url"));
});

test("missing trigger/context or denied access never opens a form", async () => {
  const command = { command: "/nobo-x", text: "", trigger_id: "trigger", channel_id: "C123", user_id: "U123", team_id: "T123" };
  for (const payload of [{ ...command, trigger_id: undefined }, { ...command, channel_id: undefined },
    { ...command, user_id: undefined }, { ...command, team_id: undefined }]) {
    const result = await handleSlackSlashCommandPayload(payload, { evaluateAccess: async () => ({ allowed: true }) });
    assert.equal(result.modal, undefined);
    assert.equal(result.media, undefined);
  }
  assert.equal((await handleSlackSlashCommandPayload(command, { evaluateAccess: async () => ({ allowed: false }) })).modal, undefined);
  assert.equal((await handleSlackSlashCommandPayload({ ...command, text: "help" }, { evaluateAccess: async () => ({ allowed: true }) })).modal, undefined);
});

test("submission validates URL and binds channel, user and workspace", () => {
  assert.deepEqual(parseXMediaSubmission(submission()), { ...target, postId: "1546621144358391808" });
  for (const value of ["", "https://example.com", "https://x.com/NASA", "https://127.0.0.1/status/1"])
    assert.throws(() => parseXMediaSubmission(submission(value)), XMediaError);
  for (const metadata of ["bad json", "null", "{}", "[]", JSON.stringify({ ...target, channelId: "C123><!channel>" }),
    JSON.stringify({ ...target, userId: "U_OTHER" }), JSON.stringify({ ...target, teamId: "T_OTHER" })])
    assert.throws(() => parseXMediaSubmission(submission(link, metadata)), XMediaError);
  assert.throws(() => parseXMediaSubmission({ ...submission(), team: null }), XMediaError);
  assert.throws(() => parseXMediaSubmission({ ...submission(), view: { private_metadata: JSON.stringify(target), state: { values: {} } } }), XMediaError);
});

test("status views cannot resubmit and render error content as plain text", () => {
  for (const uploading of [true, false]) {
    const modal = buildXMediaStatusModal(target.channelId, "Status <https://example.com>", uploading);
    assert.equal(modal.submit, undefined);
    assert.equal(modal.blocks[0].type, "section");
    assert.match(JSON.stringify(modal.blocks[0]), /plain_text/);
  }
});
