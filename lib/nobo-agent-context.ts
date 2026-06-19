import { randomUUID } from "node:crypto";
import type { SlackScheduleContext } from "./schedules.js";

export type NoboAgentToolMode = "slack" | "none";

export type NoboAgentContext = {
  nonce: string;
  modelId: string;
  toolMode: NoboAgentToolMode;
  scheduleContext?: SlackScheduleContext;
};

export function encodeNoboAgentContext(
  context: Omit<NoboAgentContext, "nonce"> & { nonce?: string }
) {
  return Buffer.from(
    JSON.stringify({
      nonce: context.nonce ?? randomUUID(),
      modelId: context.modelId,
      toolMode: context.toolMode,
      ...(context.scheduleContext ? { scheduleContext: context.scheduleContext } : {})
    }),
    "utf8"
  ).toString("base64url");
}

export function decodeNoboAgentContext(encoded: string): NoboAgentContext {
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<NoboAgentContext>;

  if (
    !parsed ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.modelId !== "string" ||
    (parsed.toolMode !== "slack" && parsed.toolMode !== "none")
  ) {
    throw new Error("Invalid NoBo agent context.");
  }

  return {
    nonce: parsed.nonce,
    modelId: parsed.modelId,
    toolMode: parsed.toolMode,
    ...(parsed.scheduleContext ? { scheduleContext: parsed.scheduleContext } : {})
  };
}
