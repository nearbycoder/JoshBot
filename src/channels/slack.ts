import { createSlackChannel } from "@flue/slack";
import { handleSlackEventCallbackPayload } from "../../lib/slack-events.js";
import { isSlackRetryRequest } from "../../lib/slack.js";

const missingSlackSigningSecret = "nobo-disabled-slack-signing-secret";

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET || missingSlackSigningSecret,
  async events({ c, payload }) {
    if (!process.env.SLACK_SIGNING_SECRET) {
      return c.text("Slack signing secret is not configured.", 503);
    }

    if (payload.type !== "event_callback") {
      return undefined;
    }

    if (isSlackRetryRequest(c.req.raw.headers)) {
      return undefined;
    }

    await handleSlackEventCallbackPayload(payload);
    return undefined;
  }
});
