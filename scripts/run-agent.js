#!/usr/bin/env node
/**
 * run-agent.js — DeepSeek digest agent
 *
 * DeepSeek has no CLI tool, so this script implements the agentic loop directly:
 *  - Connects to the historank HTTP MCP and wavespeed stdio MCP
 *  - Provides google_web_search (Serper.dev) and web_fetch as built-in tools
 *  - Runs the DeepSeek agentic loop via the OpenAI-compatible API
 *  - Emits stream-json format to stdout (compatible with postprocess.js)
 *
 * Usage:
 *   node run-agent.js --agent deepseek --prompt-file <path>
 */

import fs from "fs";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  return {
    agent: get("--agent") || "deepseek",
    promptFile: get("--prompt-file"),
  };
}

const { agent, promptFile } = parseArgs();

if (!promptFile) {
  console.error("Usage: run-agent.js --agent deepseek --prompt-file <path>");
  process.exit(1);
}

if (agent !== "deepseek") {
  console.error(`run-agent.js only handles 'deepseek', got '${agent}'`);
  process.exit(1);
}

const DIGEST_DIR = process.env.DIGEST_DIR || "/app";
const TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT || "1200", 10) * 1000; // seconds → ms

// ---------------------------------------------------------------------------
// stream-json output (compatible with postprocess.js)
// ---------------------------------------------------------------------------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitInit(model) {
  emit({ type: "init", model });
}

function emitText(text) {
  if (!text) return;
  emit({ type: "message", role: "assistant", content: text, delta: true });
}

// ---------------------------------------------------------------------------
// MCP clients
// ---------------------------------------------------------------------------

const historankClient = new Client({ name: "historank-digest-deepseek", version: "1.0" });
const wavespeedClient = new Client({ name: "historank-digest-deepseek-ws", version: "1.0" });

// toolRegistry: name -> async handler(args) -> string
const toolRegistry = new Map();

async function initMCP() {
  const historankUrl = process.env.HISTORANK_MCP_URL;
  if (!historankUrl) throw new Error("HISTORANK_MCP_URL not set");

  await historankClient.connect(
    new StreamableHTTPClientTransport(new URL(historankUrl))
  );
  const { tools: historankTools } = await historankClient.listTools();
  for (const t of historankTools) {
    toolRegistry.set(t.name, async (args) => {
      const r = await historankClient.callTool({ name: t.name, arguments: args });
      return mcpResultToString(r);
    });
  }
  process.stderr.write(`[deepseek-agent] Historank MCP: ${historankTools.length} tools\n`);

  const wavespeedTransport = new StdioClientTransport({
    command: "node",
    args: [path.join(DIGEST_DIR, "wavespeed-mcp", "index.js")],
    env: { ...process.env },
  });
  await wavespeedClient.connect(wavespeedTransport);
  const { tools: wavespeedTools } = await wavespeedClient.listTools();
  for (const t of wavespeedTools) {
    toolRegistry.set(t.name, async (args) => {
      const r = await wavespeedClient.callTool({ name: t.name, arguments: args });
      return mcpResultToString(r);
    });
  }
  process.stderr.write(`[deepseek-agent] Wavespeed MCP: ${wavespeedTools.length} tools\n`);
}

function mcpResultToString(result) {
  if (!result?.content) return "";
  return result.content
    .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Built-in tools: google_web_search + web_fetch
// ---------------------------------------------------------------------------

async function webSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return JSON.stringify({ error: "SERPER_API_KEY not set" });
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Serper error: ${res.status}`);
  const data = await res.json();
  const results = (data.organic || []).map((r) => ({
    title: r.title, url: r.link, snippet: r.snippet,
  }));
  return JSON.stringify({ results, knowledgeGraph: data.knowledgeGraph });
}

async function webFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "HistoRankDigestAgent/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  return (await res.text()).replace(/\s+/g, " ").slice(0, 60000);
}

toolRegistry.set("google_web_search", async ({ query }) => webSearch(query));
toolRegistry.set("web_fetch", async ({ url }) => webFetch(url));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

const TOOL_RESULT_LIMIT = parseInt(process.env.DEEPSEEK_TOOL_RESULT_LIMIT || "15000", 10);

// Track URLs actually returned by generate_image so we can verify the model used them
const generatedImageUrls = [];

async function executeTool(name, args) {
  const handler = toolRegistry.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  process.stderr.write(`[deepseek-agent] → ${name}\n`);
  try {
    let result = await handler(args);
    if (name === "generate_image") {
      const urlMatch = result.match(/https?:\/\/\S+/);
      if (urlMatch) {
        generatedImageUrls.push(urlMatch[0]);
        process.stderr.write(`[deepseek-agent] generate_image URL: ${urlMatch[0]}\n`);
      }
    }
    if (result.length > TOOL_RESULT_LIMIT) {
      result = result.slice(0, TOOL_RESULT_LIMIT) +
        `\n...[truncated — ${result.length} chars total, showing first ${TOOL_RESULT_LIMIT}]`;
    }
    process.stderr.write(`[deepseek-agent] ✓ ${name} (${String(result).length} chars)\n`);
    return result;
  } catch (err) {
    const msg = `Tool ${name} failed: ${err.message}`;
    process.stderr.write(`[deepseek-agent] ✗ ${msg}\n`);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// Build OpenAI-format tool list from registry + MCP schemas
// ---------------------------------------------------------------------------

async function getAllToolSchemas() {
  const { tools: historankTools } = await historankClient.listTools();
  const { tools: wavespeedTools } = await wavespeedClient.listTools();

  const builtins = [
    {
      name: "google_web_search",
      description: "Search the web using Google.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
    {
      name: "web_fetch",
      description: "Fetch the text content of a URL.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "URL to fetch" } },
        required: ["url"],
      },
    },
  ];

  return [...historankTools, ...wavespeedTools, ...builtins].map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
}

// ---------------------------------------------------------------------------
// DeepSeek agentic loop (OpenAI-compatible streaming API)
// ---------------------------------------------------------------------------

async function runDeepSeek(systemPrompt, userPrompt, tools) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");

  // deepseek-chat: supports tool calling, used for the research loop
  // deepseek-reasoner: no tool calling, 64K output — used for final JSON generation
  const toolModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const outputModel = process.env.DEEPSEEK_OUTPUT_MODEL || "deepseek-reasoner";
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" });

  emitInit(toolModel);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  process.stderr.write(`[deepseek-agent] Starting loop (tool model: ${toolModel}, output model: ${outputModel})\n`);

  while (true) {
    let fullText = "";
    const toolCallMap = {}; // index -> { id, name, args }

    const stream = await client.chat.completions.create({
      model: toolModel,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      max_tokens: 8192,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        emitText(delta.content);
        fullText += delta.content;
      }

      for (const tc of delta.tool_calls || []) {
        const idx = tc.index;
        if (!toolCallMap[idx]) {
          toolCallMap[idx] = { id: "", name: "", args: "" };
        }
        if (tc.id) toolCallMap[idx].id = tc.id;
        if (tc.function?.name) toolCallMap[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCallMap[idx].args += tc.function.arguments;
      }
    }

    if (fullText.trim()) {
      process.stderr.write(`[deepseek-agent] 💬 ${fullText.trim()}\n`);
    }

    const toolCalls = Object.values(toolCallMap);
    if (toolCalls.length === 0) {
      if (generatedImageUrls.length > 0) {
        emit({ type: "generated_image_urls", urls: generatedImageUrls });
        process.stderr.write(`[deepseek-agent] Emitted ${generatedImageUrls.length} real image URLs.\n`);
      }

      if (outputModel !== toolModel) {
        // Research loop finished — hand off to the output model (larger output
        // window, no tool calls) to write the final JSON in one uninterrupted shot.
        if (fullText.trim()) {
          messages.push({ role: "assistant", content: fullText });
        }
        messages.push({
          role: "user",
          content:
            "Research complete. Now write the complete digest JSON.\n" +
            "Output ONLY a single ```json ... ``` code fence containing the complete object. " +
            "No prose before or after the fence.",
        });

        process.stderr.write(`[deepseek-agent] Switching to output model: ${outputModel}\n`);
        emitInit(outputModel);

        let finalOutput = "";
        const finalStream = await client.chat.completions.create({
          model: outputModel,
          messages,
          max_tokens: 32000,
          stream: true,
        });
        for await (const chunk of finalStream) {
          const d = chunk.choices[0]?.delta;
          if (d?.content) {
            emitText(d.content);
            finalOutput += d.content;
          }
        }
        emit({ type: "final_message", role: "assistant", content: finalOutput });
        process.stderr.write(`[deepseek-agent] Output model complete (${finalOutput.length} chars).\n`);
      } else {
        // toolModel === outputModel: single-model path.
        // If the output ended cleanly emit as-is, otherwise request a continuation
        // with explicit format instructions to avoid it wrapping in a new code fence.
        const trimmed = fullText.trimEnd();
        if (trimmed.endsWith("}")) {
          emit({ type: "final_message", role: "assistant", content: fullText });
        } else {
          process.stderr.write(`[deepseek-agent] Output appears truncated — requesting continuation...\n`);
          const continuationMessages = [
            {
              role: "system",
              content:
                "You are completing a truncated JSON digest object. " +
                "Output ONLY the raw JSON continuation — no markdown fences, no prose, no repeated content. " +
                "The output must complete the JSON structure so the combined text becomes valid JSON.",
            },
            {
              role: "user",
              content:
                "Continue this truncated JSON digest from exactly where it ends:\n\n" +
                fullText.slice(-3000),
            },
          ];
          let continuation = "";
          const contStream = await client.chat.completions.create({
            model: toolModel,
            messages: continuationMessages,
            max_tokens: 8192,
            stream: true,
          });
          for await (const chunk of contStream) {
            const d = chunk.choices[0]?.delta;
            if (d?.content) continuation += d.content;
          }
          emit({ type: "final_message", role: "assistant", content: fullText + continuation });
          process.stderr.write(`[deepseek-agent] Continuation complete (${continuation.length} chars).\n`);
        }
      }
      break;
    }

    // Append assistant turn with tool calls
    messages.push({
      role: "assistant",
      content: fullText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    // Execute tools and append results
    for (const tc of toolCalls) {
      let args;
      try { args = JSON.parse(tc.args || "{}"); } catch { args = {}; }
      const result = await executeTool(tc.name, args);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  process.stderr.write(`[deepseek-agent] Loop complete\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const userPrompt = fs.readFileSync(promptFile, "utf8");
  const systemPromptFile = path.join(DIGEST_DIR, "AGENT.md");
  const systemPrompt = fs.existsSync(systemPromptFile)
    ? fs.readFileSync(systemPromptFile, "utf8")
    : "";

  const timeoutHandle = setTimeout(() => {
    process.stderr.write(`[deepseek-agent] TIMEOUT after ${TIMEOUT_MS}ms\n`);
    process.exit(124);
  }, TIMEOUT_MS);
  timeoutHandle.unref();

  await initMCP();

  const tools = await getAllToolSchemas();
  process.stderr.write(`[deepseek-agent] ${tools.length} tools available\n`);

  await runDeepSeek(systemPrompt, userPrompt, tools);

  clearTimeout(timeoutHandle);
  await historankClient.close().catch(() => {});
  await wavespeedClient.close().catch(() => {});
}

main().catch((err) => {
  process.stderr.write(`[deepseek-agent] FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
