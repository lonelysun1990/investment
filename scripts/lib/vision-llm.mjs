export class VisionUnsupportedError extends Error {}

export async function callVisionLlm(config, imageBase64, prompt, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    if (/does not support image|vision|image input/i.test(message)) {
      throw new VisionUnsupportedError(
        `Model "${config.model}" does not support image input: ${message}`
      );
    }
    throw new Error(`Vision LLM call failed: ${message}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Vision LLM response missing choices[0].message.content");
  }
  return content;
}
