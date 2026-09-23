import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Context, type Model } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { createNoboProvider, getNoboModelSpecifier, registerNoboProvider } from "../src/nobo-provider.js";
import { listOpenCodeGoModelDefinitions, supportsOpenCodeGoImageInput } from "../lib/nobo-models.js";

test("registers every OpenCode Go wire protocol", () => {
  assert.doesNotThrow(() => registerNoboProvider());
});

test("provider registration agrees with the selector and runtime capability catalog", () => {
  const models = createNoboProvider().getModels();
  assert.equal(models.length, listOpenCodeGoModelDefinitions().length);
  for (const definition of listOpenCodeGoModelDefinitions()) {
    const model = models.find(({ id }) => id === definition.id);
    assert.ok(model);
    assert.equal(model.api, definition.api);
    assert.equal(model.provider, "opencode-go");
    assert.equal(model.input.includes("image"), supportsOpenCodeGoImageInput(model.id));
    assert.equal(model.baseUrl, definition.api === "anthropic-messages"
      ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen/go/v1");
  }
});

for (const id of ["grok-4.7", "mimo-v2.6-flash", "mimo-v2.6-pro", "deepseek-v4.1-flash"]) {
  test(`${id} serializes images and tool history using its actual SDK adapter`, async () => {
    const model = createNoboProvider().getModels().find((model) => model.id === id)!;
    assert.ok(model);
    assert.ok(model.contextWindow >= 500_000);
    assert.ok(model.maxTokens >= 131_072);
    const context: Context = {
      systemPrompt: "You are NoBo.",
      tools: [{ name: "lookup", description: "Look up a fact", parameters: Type.Object({}) }],
      messages: [
        { role: "user", timestamp: 1, content: [
          { type: "text", text: "Describe this image and look up context." },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
        ] },
        {
          role: "assistant", api: model.api, provider: model.provider, model: id,
          timestamp: 2, stopReason: "toolUse",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [
            ...(model.api === "openai-completions" ? [{ type: "thinking" as const,
              thinking: "I should check context.", thinkingSignature: "reasoning_content" }] : []),
            { type: "toolCall", id: "call_lookup", name: "lookup", arguments: {} }
          ]
        },
        { role: "toolResult", toolCallId: "call_lookup", toolName: "lookup", timestamp: 3,
          isError: false, content: [{ type: "text", text: "Found context." }] }
      ]
    };
    let payload: any;
    // Stop after real adapter serialization, before any network request or billing.
    const options = {
      apiKey: "test-only", maxTokens: 512, reasoningEffort: "high" as const,
      onPayload(value: unknown) { payload = value; throw new Error("payload captured"); },
      fetch: (async () => { throw new Error("Unexpected network request"); }) as typeof fetch
    };
    const result = model.api === "openai-responses"
      ? await streamResponses(model as Model<"openai-responses">, context, options).result()
      : await streamCompletions(model as Model<"openai-completions">, context, options).result();
    assert.equal(result.errorMessage, "payload captured");
    assert.equal(payload.model, id);
    assert.equal(payload.stream, true);
    assert.ok(JSON.stringify(payload).includes("data:image/png;base64,aW1hZ2U="));
    assert.ok(JSON.stringify(payload).includes("Found context."));
    if (model.api === "openai-completions") {
      assert.equal(payload.max_tokens, 512);
      assert.equal(payload.max_completion_tokens, undefined);
      assert.equal(payload.messages[0].role, "system");
      const assistant = payload.messages.find((message: any) => message.role === "assistant");
      assert.equal(assistant.reasoning_content, "I should check context.");
      assert.equal(assistant.tool_calls[0].function.name, "lookup");
      assert.equal(payload.tools[0].function.name, "lookup");
      if (id.startsWith("deepseek-")) {
        assert.deepEqual(payload.thinking, { type: "enabled" });
        assert.equal(payload.reasoning_effort, "high");
      } else {
        assert.equal(payload.reasoning_effort, undefined);
      }
    } else {
      assert.equal(payload.max_output_tokens, 512);
      assert.equal(payload.tools[0].name, "lookup");
      assert.ok(payload.input.some((item: any) => item.type === "function_call" && item.name === "lookup"));
      assert.equal(payload.reasoning.effort, "high");
    }
  });
}

test("routes OpenCode Go models through their required providers", () => {
  assert.equal(getNoboModelSpecifier("glm-5.3"), "opencode-go/glm-5.3");
  assert.equal(getNoboModelSpecifier("qwen3.8-max"), "opencode-go/qwen3.8-max");
  assert.equal(getNoboModelSpecifier("gpt-5.6-luna"), "opencode-go/gpt-5.6-luna");
});
