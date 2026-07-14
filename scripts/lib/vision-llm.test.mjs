import { test } from "node:test";
import assert from "node:assert/strict";
import { callVisionLlm, VisionUnsupportedError } from "./vision-llm.mjs";

test("posts to {base_url}/chat/completions with an image_url content block", async () => {
  let capturedUrl, capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "fake response" } }] }),
    };
  };
  const result = await callVisionLlm(
    { baseUrl: "https://example.test/v1", apiKey: "sk-test", model: "test-model" },
    "iVBORw0KGgo=",
    "describe this image",
    { fetchImpl: fakeFetch }
  );
  assert.equal(capturedUrl, "https://example.test/v1/chat/completions");
  assert.equal(capturedBody.model, "test-model");
  const imageBlock = capturedBody.messages[0].content.find((c) => c.type === "image_url");
  assert.ok(imageBlock, "expected an image_url content block");
  assert.equal(result, "fake response");
});

test("throws VisionUnsupportedError when the API reports no image support", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "This model does not support image inputs" } }),
  });
  await assert.rejects(
    () =>
      callVisionLlm(
        { baseUrl: "https://example.test/v1", apiKey: "sk-test", model: "text-only-model" },
        "iVBORw0KGgo=",
        "describe this image",
        { fetchImpl: fakeFetch }
      ),
    VisionUnsupportedError
  );
});

test("throws a plain Error (not VisionUnsupportedError) on other API failures", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: "Invalid API key" } }),
  });
  await assert.rejects(
    () =>
      callVisionLlm(
        { baseUrl: "https://example.test/v1", apiKey: "sk-bad", model: "gpt-4o" },
        "iVBORw0KGgo=",
        "describe this image",
        { fetchImpl: fakeFetch }
      ),
    (err) => err instanceof Error && !(err instanceof VisionUnsupportedError)
  );
});
