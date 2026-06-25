import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { createNoboTools } from "../../lib/flue-tools.js";
import { decodeNoboAgentContext } from "../../lib/nobo-agent-context.js";
import { SYSTEM_PROMPT } from "../../lib/nobo-prompt.js";
import { INTERNAL_FLUE_HEADER, INTERNAL_FLUE_TOKEN } from "../internal-flue.js";
import { getNoboModelSpecifier, registerNoboProvider } from "../nobo-provider.js";

export const description = "NoBo Slack assistant model harness.";

export const route: AgentRouteHandler = async (c, next) => {
  if (c.req.header(INTERNAL_FLUE_HEADER) !== INTERNAL_FLUE_TOKEN) {
    return c.notFound();
  }

  await next();
};

export default createAgent(({ id }) => {
  const context = decodeNoboAgentContext(id);
  registerNoboProvider();

  return {
    model: getNoboModelSpecifier(context.modelId),
    instructions: SYSTEM_PROMPT,
    tools: context.toolMode === "none" ? [] : createNoboTools(context.scheduleContext, context.ownerUserId)
  };
});
