# NoBo interactive Agent responses

The three feature PRs add the ten brainstormed capabilities. No new Slack OAuth scopes,
slash commands, or event subscriptions are required beyond the existing Bolt/Agents setup.
Interactivity must remain enabled at `/api/slack/interactions`; the existing
`/nobo-reminder` command also accepts `list` or `manage`.

| Feature | How to use it |
| --- | --- |
| Research results | Ask NoBo to research a topic. Actual search results become source links with save and follow-up controls. |
| Channel catch-up | Ask for a channel summary. NoBo can emit structured sections (decisions, open questions, next steps) using `present_result`; available history permalinks link back to Slack. |
| Reminders | Model-created schedules first show an approval preview. `/nobo-reminder list` shows five upcoming reminders; Home → My reminders manages up to ten with Edit and Cancel. |
| Artifacts | **Save note** stores an answer with sources. Document cards offer Open and Revise, with Versions and sharing in the overflow menu. HTML documents get a static inline PNG preview when rendering succeeds. |
| Model transparency | **⋯ → Response details** shows selected/used models. Only fallbacks and limitations appear automatically in the footer. Home → Model settings changes channel overrides. |
| Progress plans | Native streams group real tool progress with `task_display_mode=plan`; no invented progress or chain-of-thought is displayed. |
| Approval workflows | **Post elsewhere** and **Create issues** open review forms, then private Approve/Reject cards. Model schedule creation and interactive issue-create commands also require approval. |
| Feedback | Native Helpful/Not helpful controls save a rating quietly. Negative feedback opens an optional detail form; dismissing it preserves the rating. |
| Recovery | Safe failed text runs offer Retry or an alternate model. Runs that may have written data or included images do not offer automatic replay. |
| Follow-ups | Shorter, Deeper, Compare, and Turn into tasks run with read-only tools in the original thread. Tasks produces a draft; issue creation remains a separate reviewed action. |

Short conversational replies intentionally omit the large action toolbar. Structured research
and catch-up sections are model-driven, not guaranteed for every response. Links come from
actual tool results; missing Slack permalink permissions do not prevent an answer.

## Mobile-first layout

Each message has at most two visible action buttons and one native overflow menu (up to
five entries). Research offers Save note / Dig deeper; catch-ups offer Save note / Turn into
tasks; task lists offer Save note / Create issues; documents offer Open / Revise; reminders
offer Edit / Cancel. A meme never gets research or issue-management actions. Simple answers
need no action buttons at all. Global tools live in NoBo Home → Your NoBo tools: reminders,
saved documents, channel model settings, and integration readiness. Existing slash commands
remain available; this moves presentation, not capabilities.

Submitted actions update their original card to working, completed, or needs-attention status
and remove consumed controls. Native answer text and task blocks are preserved. Private cards
use Slack's response URL rather than attempting `chat.update` on an ephemeral message. If a
refresh fails or a private response URL expires, the operation's server-side single-use claim
still prevents duplicate writes. Pre-existing messages are not proactively rewritten; interacting
with an old card can refresh it while its stored record is still valid.

Image previews use a packaged headless Chromium browser with no app secrets in its environment,
JavaScript disabled, all network requests blocked, and a restrictive CSP. Only self-contained HTML,
inline styles, and embedded image data can render. Rendering is serialized, limited to three queued
requests, 256 KB of HTML and an 800 × 1600 maximum viewport. Oversized, overloaded, or failed
previews leave the document link intact. Screenshots get version-specific URLs to avoid stale
Slack image caches and follow the document's existing bearer-link access model. They are static
previews, not interactive web pages; external assets and scripts are intentionally absent.

## Safety and behavior

- Cards and feedback are stored in Redis for 24 hours. Controls are bound to their initiating
  user, workspace, and channel, with access policy checked again when used. Other people may
  read a public answer but cannot use its owner's action controls.
- Approval payloads stay on the server. Buttons contain opaque IDs, not destinations or
  content. Previewed post text, schedule first-run time/timezone/mode, and issue destination
  are fixed at review time. A changed issue destination requires a fresh review.
- Approve and Reject share an atomic, single-use decision. Mutation claims stay consumed
  after errors: an ambiguous network failure must not silently repeat an external write.
  Check the destination before submitting a fresh request.
- Without Redis, response controls are omitted and approval-dependent writes fail closed.
  This does not disable pre-existing explicitly submitted reminder forms, reaction shortcuts,
  or background schedules. Those retain their existing behavior.
- Reminder edits change text and the next occurrence only; recurrence, destination, and
  timezone stay unchanged. Use the existing schedule command to change cadence. Stale or
  already-running edits are rejected. Cancellation stops future occurrences, but an already
  in-flight delivery may finish.
- Revisions use the current stored document, not the old answer on the card. Guided revision
  is limited to 24 KB and uses a model without tools. The prior version is retained; a concurrent
  change rejects the revision. Versions shows retained version IDs; existing artifact commands
  provide diff/rollback. Artifact links retain the existing bearer-link access model: anyone
  with a URL can read the document. Do not save sensitive answers to shareable artifacts.
- **Post elsewhere** sends exactly the text reviewed in the form. Slack mentions in that
  approved text may notify people. Destination policy is rechecked before posting, and NoBo
  must already be able to post in the selected channel.
- Issue creation requires existing GitHub/Linear credentials and destination configuration.
  The modal accepts up to five reviewed task lines; missing configuration returns actionable
  drafts/errors rather than pretending issues were created. A partially successful batch is
  not automatically replayed.
- Follow-up generations cannot invoke write tools. Feedback is stored for inspection, not
  automatically used for training or changing model selection.

## Deployment and controls

- `SLACK_WIDGETS=off` suppresses answer footers; approval gating remains enabled.
- `SLACK_TASK_DISPLAY_MODE=timeline` restores chronological native task display; default is `plan`.
- `SLACK_NATIVE_AI=off` retains legacy text streaming with final cards.
- `ARTIFACT_IMAGE_PREVIEWS=off` disables static HTML image previews without disabling documents.
- If Slack rejects new footer blocks, finalization retries the same message with text blocks
  so the answer is not lost. Approval failures never silently execute the requested action.
- Keep one Railway replica: Stop cancellation and artifact mutation coordination are
  process-local. Keep `ARTIFACT_DIR` on persistent storage if documents must survive deployments;
  Redis stores card metadata, not artifact file contents.

## Acceptance checks

Automated coverage includes signed Bolt modal validation, ownership/access checks, duplicate
and expired actions, exact approval payloads, safe retry gating, read-only follow-up context,
artifact version retention/concurrent revision rejection, schedule edit/cancellation races,
and rejected-widget text fallback. Tests use fake Slack/model/issue ports and temporary files;
they do not send live Slack messages or purchase model generations.

After deploying, verify `/healthz`, the signed Slack URL challenge, and Railway startup logs.
For a live visual smoke test, ask NoBo to research a small topic, try Shorter and Save note,
then create a test reminder and approve/edit/cancel it. Check native progress and feedback
in the Agent surface. Slack client rendering is not proven by API/unit tests alone.

Slack references: [context actions](https://docs.slack.dev/reference/block-kit/blocks/context-actions-block/),
[stream footer blocks](https://docs.slack.dev/reference/methods/chat.stopStream/),
[plan display](https://docs.slack.dev/reference/methods/chat.startStream/),
[overflow menus](https://docs.slack.dev/reference/block-kit/block-elements/overflow-menu-element/),
[acknowledgements](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/).
