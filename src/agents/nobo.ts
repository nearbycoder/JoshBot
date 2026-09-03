'use agent';

import { type AgentProps, useModel, useTool } from "@flue/runtime";
import { createNoboTools } from "../../lib/flue-tools.js";
import { decodeNoboAgentContext } from "../../lib/nobo-agent-context.js";
import { formatOpenCodeGoRuntimeContext } from "../../lib/nobo-models.js";
import { SYSTEM_PROMPT } from "../../lib/nobo-prompt.js";
import { getNoboModelSpecifier } from "../nobo-provider.js";

function Nobo({ id }: AgentProps) {
  const context = decodeNoboAgentContext(id);

  useModel(getNoboModelSpecifier(context.modelId));

  if (context.toolMode !== "none") {
    for (const tool of createNoboTools(context.scheduleContext, context.ownerUserId)) {
      useTool(tool);
    }
  }

  return `${SYSTEM_PROMPT}

${formatOpenCodeGoRuntimeContext(context.modelId)}`;
}

Nobo.agentName = "nobo";

export default Nobo;
