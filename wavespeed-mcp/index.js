import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const WAVESPEED_MODEL_DEFAULT = process.env.WAVESPEED_MODEL || "wavespeed-ai/flux-dev";

if (!WAVESPEED_API_KEY) {
  console.error("[wavespeed-mcp] ERROR: WAVESPEED_API_KEY environment variable is not set.");
  process.exit(1);
}

const server = new McpServer({
  name: "wavespeed",
  version: "1.0.0",
});

server.tool(
  "generate_image",
  "Generate an image using the Wavespeed AI API. Returns the URL of the generated image.",
  {
    prompt: z.string().describe("The image generation prompt. Be descriptive and evocative."),
    width: z.number().optional().default(1280).describe("Image width in pixels (default: 1280)"),
    height: z.number().optional().default(720).describe("Image height in pixels (default: 720)"),
    model: z.string().optional().describe("Wavespeed model to use (overrides WAVESPEED_MODEL env var)"),
  },
  async ({ prompt, width = 1280, height = 720, model }) => {
    const resolvedModel = model || WAVESPEED_MODEL_DEFAULT;

    // Submit the generation request
    const submitUrl = `https://api.wavespeed.ai/api/v3/${resolvedModel}`;
    let predictionId;
    let submitData;

    try {
      const submitResponse = await fetch(submitUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WAVESPEED_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          width,
          height,
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        throw new Error(
          `Wavespeed submit failed: HTTP ${submitResponse.status} — ${errorText}`
        );
      }

      submitData = await submitResponse.json();

      // Accept either data.id or top-level id depending on API version
      predictionId = submitData?.data?.id ?? submitData?.id;
      if (!predictionId) {
        throw new Error(
          `Wavespeed submit response did not include a prediction id. Response: ${JSON.stringify(submitData)}`
        );
      }
    } catch (err) {
      throw new Error(`Failed to submit image generation request: ${err.message}`);
    }

    // Poll for completion
    const pollUrl = submitData?.data?.urls?.get ?? `https://api.wavespeed.ai/api/v3/predictions/${predictionId}/result`;
    const MAX_ATTEMPTS = 60;
    const POLL_INTERVAL_MS = 5000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      let pollData;
      try {
        const pollResponse = await fetch(pollUrl, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${WAVESPEED_API_KEY}`,
          },
        });

        if (!pollResponse.ok) {
          const errorText = await pollResponse.text();
          throw new Error(
            `Wavespeed poll failed: HTTP ${pollResponse.status} — ${errorText}`
          );
        }

        pollData = await pollResponse.json();
      } catch (err) {
        // Network errors during polling — keep trying unless we've exhausted attempts
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`Wavespeed polling network error on final attempt: ${err.message}`);
        }
        continue;
      }

      const status = pollData?.data?.status ?? pollData?.status;
      const outputs = pollData?.data?.outputs ?? pollData?.outputs;

      if (status === "completed" || status === "succeeded") {
        if (!outputs || outputs.length === 0) {
          throw new Error(
            `Wavespeed prediction ${predictionId} completed but returned no outputs.`
          );
        }
        const imageUrl = outputs[0];
        return {
          content: [
            {
              type: "text",
              text: imageUrl,
            },
          ],
        };
      }

      if (status === "failed" || status === "canceled" || status === "error") {
        const errorMsg = pollData?.data?.error ?? pollData?.error ?? "unknown error";
        throw new Error(
          `Wavespeed prediction ${predictionId} ${status}: ${errorMsg}`
        );
      }

      // status is "starting", "processing", or similar — keep polling
    }

    throw new Error(
      `Wavespeed prediction ${predictionId} did not complete within ${MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000} seconds (${MAX_ATTEMPTS} poll attempts).`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
