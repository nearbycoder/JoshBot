import assert from "node:assert/strict";
import test from "node:test";
import { Type, normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { createNoboProvider, getNoboModelSpecifier, registerNoboProvider } from "../src/nobo-provider.js";
import { getOpenCodeGoModelBaseUrl, listOpenCodeGoModelDefinitions, supportsOpenCodeGoImageInput } from "../lib/nobo-models.js";

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
    assert.equal(model.baseUrl, getOpenCodeGoModelBaseUrl(definition.id));
  }
});

test("retains upstream token limits, pricing tiers, and protocol compatibility", () => {
  const upstreamModels = new Map(opencodeGoProvider().getModels().map((model) => [model.id, model]));
  for (const model of createNoboProvider().getModels()) {
    const upstream = upstreamModels.get(model.id);
    assert.ok(upstream, `${model.id} must have verified upstream metadata`);
    assert.equal(model.contextWindow, upstream.contextWindow);
    assert.equal(model.maxTokens, upstream.maxTokens);
    assert.deepEqual(model.cost, upstream.cost);
    assert.deepEqual(model.compat, model.id === "mimo-v2.6-flash" || model.id === "mimo-v2.6-pro"
      ? { ...upstream.compat, supportsReasoningEffort: false }
      : upstream.compat);
    assert.deepEqual(model.thinkingLevelMap, upstream.thinkingLevelMap);
  }
  const grok = createNoboProvider().getModels().find(({ id }) => id === "grok-4.7")!;
  assert.ok(grok.cost.tiers?.some((tier) => tier.inputTokensAbove === 200_000));
});

for (const { id, path, authHeader, authValue } of [
  { id: "gpt-6-luna", path: "/inference/go/openai/v1/responses", authHeader: "authorization", authValue: "Bearer test-only" },
  { id: "claude-haiku-5-5", path: "/inference/go/anthropic/v1/messages", authHeader: "x-api-key", authValue: "test-only" },
  { id: "gemini-4-argon-contributor", path: "/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent", authHeader: "x-goog-api-key", authValue: "test-only" },
  ...["step-5-preview", "beam-free", "minimax-m3.1-flash-free"].map((id) => ({
    id, path: "/inference/go/openai/v1/chat/completions", authHeader: "authorization", authValue: "Bearer test-only"
  }))
]) {
  test(`${id} sends the correct route, auth, session, prompt, and tools without network access`, async (t) => {
    const provider = createNoboProvider();
    const model = provider.getModels().find((model) => model.id === id)!;
    assert.ok(model);
    let request: Request | undefined;
    let body: any;
    // Exercise the SDK's real HTTP serialization. Every attempted request ends
    // here with a non-retryable error; no model credentials or network are used.
    const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      body = await request.clone().json();
      return Response.json({ error: { type: "invalid_request_error", code: 400, message: "test transport stopped" } }, { status: 400 });
    });
    const result = await provider.stream(model, normalizeContext({
      systemPrompt: "You are NoBo. Keep the system prompt.",
      tools: [{ name: "lookup", description: "Look up a fact", parameters: Type.Object({}) }],
      messages: [{ role: "user", timestamp: 1, content: [
        { type: "text", text: "Look up context." },
        ...(supportsOpenCodeGoImageInput(id) ? [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }] : [])
      ] }]
    }), {
      apiKey: "test-only",
      maxTokens: 512,
      sessionId: "nobo-test-session",
      identity: { userAgent: { custom: "nobo-tests/1.0" } },
      fetch: globalThis.fetch
    }).result();

    assert.match(result.errorMessage ?? "", /test transport stopped/);
    assert.equal(fetch.mock.callCount(), 1);
    assert.ok(request);
    assert.equal(request.method, "POST");
    const url = new URL(request.url);
    assert.equal(url.origin, "https://opencode.ai");
    assert.equal(url.pathname, path);
    assert.equal(request.headers.get(authHeader), authValue);
    assert.equal(request.headers.get("x-opencode-session"), "nobo-test-session");
    assert.equal(request.headers.get("user-agent"), "nobo-tests/1.0");
    assert.ok(JSON.stringify(body).includes("You are NoBo. Keep the system prompt."));
    assert.ok(JSON.stringify(body).includes("Look up context."));
    if (supportsOpenCodeGoImageInput(id)) assert.ok(JSON.stringify(body).includes("aW1hZ2U="));

    if (model.api === "google-generative-ai") {
      assert.equal(body.generationConfig.maxOutputTokens, 512);
      assert.equal(body.tools[0].functionDeclarations[0].name, "lookup");
      assert.equal(url.searchParams.get("alt"), "sse");
    } else {
      assert.equal(body.model, id);
      assert.equal(body.stream, true);
      if (model.api === "openai-completions") {
        assert.equal(body.messages[0].role, "system");
        assert.equal(body.max_tokens, 512);
        assert.equal(body.tools[0].function.name, "lookup");
      } else if (model.api === "anthropic-messages") {
        assert.equal(body.max_tokens, 512);
        assert.equal(body.tools[0].name, "lookup");
      } else {
        assert.equal(body.max_output_tokens, 512);
        // GPT 6 declares tools in its transcript to support mid-conversation additions.
        const declaration = body.input.find((item: any) => item.type === "additional_tools");
        assert.equal(declaration.tools[0].name, "lookup");
      }
    }
  });
}

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
      ? await streamResponses(model as Model<"openai-responses">, normalizeContext(context), options).result()
      : await streamCompletions(model as Model<"openai-completions">, normalizeContext(context), options).result();
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
