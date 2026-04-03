import fs from "fs";
import path from "path";
import { jsonrepair } from "jsonrepair";
import { uploadImageFromUrl } from "./pronto.js";

const RAW_INPUT = "/tmp/raw-digest.json";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/var/www/historank/digests";
const INDEX_FILE = path.join(OUTPUT_DIR, "index.json");
const MAX_INDEX_ENTRIES = 365;

function log(msg) {
  console.log(`[postprocess] ${msg}`);
}

function die(msg) {
  console.error(`[postprocess] ERROR: ${msg}`);
  process.exit(1);
}

// --- Read raw Gemini CLI output ---
let rawContent;
try {
  rawContent = fs.readFileSync(RAW_INPUT, "utf8");
} catch (err) {
  die(`Could not read raw input from ${RAW_INPUT}: ${err.message}`);
}

// --- Extract response text ---
// Handles three Gemini CLI output formats:
//   stream-json  → newline-delimited JSON events; concatenate all "content" chunks
//   json         → single envelope: { "response": "...", "stats": {...} }
//   plain text   → raw model output (no --output-format flag)
let responseText;

// Try stream-json: every line is a JSON object, text lives in event.content
const lines = rawContent.split("\n").map((l) => l.trim()).filter(Boolean);
const firstLine = lines[0];
let isStreamJson = false;
try {
  const firstEvent = JSON.parse(firstLine);
  // stream-json events have a "type" field; plain json envelope does not
  if (typeof firstEvent?.type === "string") {
    isStreamJson = true;
  }
} catch { /* not JSON at all */ }

let actualModel = null;
let supplementaryMessage = null; // DeepSeek follow-up with model_analysis + sources
let generatedImageUrls = null;   // Real URLs from generate_image tool calls
if (isStreamJson) {
  const deltaChunks = [];   // token-level deltas (Gemini / Claude / DeepSeek) — join with ""
  const blockChunks = [];   // full message blocks (Codex agent_message) — join with "\n"
  let finalMessage = null;       // DeepSeek final turn — use instead of concatenated deltas
  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // --- Gemini / DeepSeek: model from init event ---
      if (event?.type === "init" && typeof event?.model === "string") {
        actualModel = event.model;
      }

      // --- Claude Code CLI: model from system init event ---
      if (event?.type === "system" && event?.subtype === "init" && typeof event?.model === "string") {
        actualModel = event.model;
      }

      // --- Gemini / DeepSeek stream-json: { type: "message", role: "assistant", content: "...", delta: true } ---
      if (event?.type === "message" && event?.role === "assistant" && typeof event?.content === "string") {
        deltaChunks.push(event.content);
      }

      // --- Claude Code CLI: { type: "assistant", message: { content: [{type:"text", text:"..."}] } } ---
      if (event?.type === "assistant" && Array.isArray(event?.message?.content)) {
        for (const part of event.message.content) {
          if (part?.type === "text" && typeof part?.text === "string") {
            deltaChunks.push(part.text);
          }
        }
      }

      // --- DeepSeek: final turn emitted as a single complete event ---
      if (event?.type === "final_message" && event?.role === "assistant" && typeof event?.content === "string") {
        finalMessage = event.content;
      }

      // --- DeepSeek: supplementary model_analysis + sources ---
      if (event?.type === "supplementary_message" && event?.role === "assistant" && typeof event?.content === "string") {
        supplementaryMessage = event.content;
      }

      // --- DeepSeek: real image URLs from generate_image tool calls ---
      if (event?.type === "generated_image_urls" && Array.isArray(event?.urls)) {
        generatedImageUrls = event.urls;
      }

      // --- Codex exec --json: { type: "item.completed", item: { type: "agent_message", text: "..." } } ---
      if (event?.type === "item.completed" && event?.item?.type === "agent_message" && typeof event?.item?.text === "string") {
        blockChunks.push(event.item.text);
      }
    } catch { /* skip malformed lines */ }
  }
  const totalChunks = deltaChunks.length + blockChunks.length;
  // Prefer final_message (clean final turn) over noisy concatenated deltas
  if (finalMessage !== null) {
    responseText = finalMessage;
    log("Using final_message event for response extraction.");
  } else {
    responseText = deltaChunks.join("") + (blockChunks.length ? "\n" + blockChunks.join("\n") : "");
    log("No final_message event found; using concatenated delta chunks.");
  }
  log(`Detected stream-json format (${lines.length} events, ${totalChunks} content chunks, model: ${actualModel}).`);
} else {
  // Try single JSON envelope
  try {
    const envelope = JSON.parse(rawContent);
    responseText = envelope?.response ?? envelope?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof responseText === "string" && responseText.trim()) {
      log("Detected JSON envelope format.");
    } else {
      responseText = null;
    }
  } catch { /* not JSON */ }

  if (!responseText) {
    // Plain text fallback
    responseText = rawContent;
    log("Detected plain text format.");
  }
}

if (!responseText || responseText.trim() === "") {
  die("Could not extract a response string from the agent output.");
}

// --- Extract the digest JSON from the response string ---
let digestJson;

function tryParseJson(text, label) {
  // Build candidates: original, and a version with { prepended if it looks like
  // the opening brace was stripped (model sometimes starts inside the object).
  const trimmed = text.trimStart();
  const candidates = [trimmed];
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    candidates.push("{" + trimmed);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch { /* fall through to jsonrepair */ }
    try {
      const repaired = jsonrepair(candidate);
      const parsed = JSON.parse(repaired);
      log(`Repaired malformed JSON from ${label}.`);
      return parsed;
    } catch { /* try next candidate */ }
  }
  return null;
}

// Strategy 1: look for ```json ... ``` fences — try from last to first
// (model may emit multiple fences; the last complete one is the digest)
const fenceRegex = /```json\s*([\s\S]*?)```/g;
const fences = [];
let fm;
while ((fm = fenceRegex.exec(responseText)) !== null) {
  fences.push(fm[1].trim());
}
if (fences.length > 0) {
  for (let i = fences.length - 1; i >= 0; i--) {
    digestJson = tryParseJson(fences[i], `\`\`\`json fence #${i + 1}`);
    if (digestJson) {
      log(`Extracted digest JSON from \`\`\`json fence #${i + 1} of ${fences.length}.`);
      break;
    }
  }
  if (!digestJson) {
    log(`WARNING: Found ${fences.length} \`\`\`json fence(s) but none parsed — falling through to outermost-brace strategy.`);
  }
}

// Strategy 2: from first { to end of string (let jsonrepair close any truncated structure)
if (!digestJson) {
  const firstBrace = responseText.indexOf("{");
  if (firstBrace !== -1) {
    const candidate = responseText.slice(firstBrace);
    digestJson = tryParseJson(candidate, "outermost braces");
    if (digestJson) {
      log("Extracted digest JSON by finding outermost braces.");
    } else {
      die(`Could not parse JSON from outermost braces even after repair.`);
    }
  }
}

if (!digestJson) {
  die("Could not locate a JSON object in the agent response string.");
}

// --- Inject real generate_image URLs (DeepSeek may hallucinate image URLs) ---
if (generatedImageUrls && generatedImageUrls.length > 0 && Array.isArray(digestJson.images)) {
  let injected = 0;
  for (let i = 0; i < digestJson.images.length && injected < generatedImageUrls.length; i++) {
    digestJson.images[i].url = generatedImageUrls[injected++];
  }
  log(`Injected ${injected} real image URL(s) from generate_image tool calls.`);
}

// --- Merge supplementary message (DeepSeek model_analysis + sources follow-up) ---
if (supplementaryMessage) {
  const suppJson = tryParseJson(supplementaryMessage.slice(supplementaryMessage.indexOf("{")), "supplementary_message");
  if (suppJson) {
    if (suppJson.model_analysis) { digestJson.model_analysis = suppJson.model_analysis; log("Merged model_analysis from supplementary_message."); }
    if (Array.isArray(suppJson.sources)) { digestJson.sources = suppJson.sources; log("Merged sources from supplementary_message."); }
  } else {
    log("WARNING: Could not parse supplementary_message JSON.");
  }
}

// --- Validate required top-level fields ---
log(`Extracted JSON top-level keys: ${Object.keys(digestJson).join(", ")}`);
log(`responseText length: ${responseText.length} chars | last 200: ${responseText.slice(-200).replace(/\n/g, "↵")}`);
const REQUIRED_FIELDS = ["id", "date", "theme", "narrative", "events"];
for (const field of REQUIRED_FIELDS) {
  if (digestJson[field] === undefined || digestJson[field] === null) {
    die(`Digest JSON is missing required field: "${field}"`);
  }
}
// model_analysis with all 4 tendencies is required — frontend crashes without it
if (!digestJson.model_analysis || typeof digestJson.model_analysis !== "object") {
  die(`"model_analysis" field is missing. The agent must produce this section.`);
}
if (!digestJson.model_analysis.tendencies || typeof digestJson.model_analysis.tendencies !== "object") {
  die(`"model_analysis.tendencies" is missing. All four model keys (gemini, chatgpt, claude, deepseek) are required.`);
}
for (const m of ["gemini", "chatgpt", "claude", "deepseek"]) {
  if (typeof digestJson.model_analysis.tendencies[m] !== "string" || !digestJson.model_analysis.tendencies[m].trim()) {
    die(`"model_analysis.tendencies.${m}" is missing or empty. All four model tendency keys are required.`);
  }
}
if (!Array.isArray(digestJson.model_analysis.most_agreed)) {
  log("WARNING: model_analysis.most_agreed is missing — defaulting to [].");
  digestJson.model_analysis.most_agreed = [];
}
if (!Array.isArray(digestJson.model_analysis.most_disputed)) {
  log("WARNING: model_analysis.most_disputed is missing — defaulting to [].");
  digestJson.model_analysis.most_disputed = [];
}
// sources is best-effort — some agents hit token limits before writing it
if (!Array.isArray(digestJson.sources) || digestJson.sources.length === 0) {
  log("WARNING: sources field is missing or empty — agent may have been truncated.");
  digestJson.sources = [];
}

// images[] (new) or hero_image (legacy) — at least one must be present
if (Array.isArray(digestJson.images)) {
  const before = digestJson.images.length;
  digestJson.images = digestJson.images.filter((img) => {
    if (!img.id) { log(`WARNING: Image missing "id" — skipping.`); return false; }
    if (!img.url) { log(`WARNING: Image "${img.id}" has no URL (generation may have failed) — skipping.`); return false; }
    return true;
  });
  if (digestJson.images.length < before) {
    log(`WARNING: ${before - digestJson.images.length} image(s) dropped due to missing URL.`);
  }
}
if (!Array.isArray(digestJson.images) || digestJson.images.length === 0) {
  if (!digestJson.hero_image?.url) {
    die(`Digest must have either "images" array (new) or "hero_image.url" (legacy).`);
  }
  log("WARNING: using legacy hero_image field. Consider upgrading to images[].");
} else {
  log(`Images: ${digestJson.images.length} found.`);
}

// visualizations[] — optional but validate shape if present
if (Array.isArray(digestJson.visualizations)) {
  const VALID_VIZ_TYPES = [
    "timeline_scatter","model_comparison_bar","divergence_ranking","geo_map",
    "radar_model","score_heatmap","line_trend","treemap","box_plot",
  ];
  for (const viz of digestJson.visualizations) {
    if (!viz.id) die(`Visualization is missing "id": ${JSON.stringify(viz)}`);
    if (!VALID_VIZ_TYPES.includes(viz.type)) {
      die(`Unknown visualization type "${viz.type}". Valid types: ${VALID_VIZ_TYPES.join(", ")}`);
    }
  }
  log(`Visualizations: ${digestJson.visualizations.length} found.`);
}

if (!Array.isArray(digestJson.narrative)) {
  die(`"narrative" must be an array, got: ${typeof digestJson.narrative}`);
}

if (!Array.isArray(digestJson.events)) {
  die(`"events" must be an array, got: ${typeof digestJson.events}`);
}

if (digestJson.events.length < 5) {
  die(`"events" array has only ${digestJson.events.length} entries; minimum required is 5.`);
}

if (!Array.isArray(digestJson.sources)) {
  die(`"sources" must be an array, got: ${typeof digestJson.sources}`);
}

// --- Validate each event has ratings for all 4 models; drop incomplete events ---
const REQUIRED_MODELS = ["gemini", "chatgpt", "claude", "deepseek"];
const validEvents = [];
for (const event of digestJson.events) {
  const eventLabel = `event id=${event.id ?? "(no id)"}`;
  if (!event.ratings || typeof event.ratings !== "object") {
    log(`WARNING: ${eventLabel} is missing a "ratings" object — skipping.`);
    continue;
  }
  let complete = true;
  for (const modelKey of REQUIRED_MODELS) {
    if (!event.ratings[modelKey]) {
      log(`WARNING: ${eventLabel} is missing ratings for model "${modelKey}" — skipping. ratings keys present: ${Object.keys(event.ratings).join(", ")}`);
      complete = false;
      break;
    }
    if (typeof event.ratings[modelKey].score !== "number") {
      log(`WARNING: ${eventLabel} ratings.${modelKey}.score is not a number — skipping.`);
      complete = false;
      break;
    }
    if (typeof event.ratings[modelKey].explanation !== "string") {
      log(`WARNING: ${eventLabel} ratings.${modelKey}.explanation is not a string — skipping.`);
      complete = false;
      break;
    }
    if (typeof event.ratings[modelKey].category !== "string") {
      log(`WARNING: ${eventLabel} ratings.${modelKey}.category is not a string — skipping.`);
      complete = false;
      break;
    }
  }
  if (complete) validEvents.push(event);
}
digestJson.events = validEvents;
if (digestJson.events.length < 5) {
  die(`Only ${digestJson.events.length} events have complete ratings (minimum 5 required).`);
}

log(`Validation passed: ${digestJson.events.length} events, all 4 model ratings present.`);

// --- Stamp the actual model used ---
// Prefer the model name from the stream-json init event; fall back to the
// DIGEST_AGENT env var set by generate.sh (covers codex and other agents
// that don't emit an init event).
log(`DIGEST_MODEL env: ${process.env.DIGEST_MODEL ?? "(not set)"}, actualModel: ${actualModel ?? "(not set)"}`);
// DIGEST_MODEL (set by generate.sh) always wins — it knows the real model name.
// actualModel (from stream-json init event) is used only as a fallback.
const resolvedModel = process.env.DIGEST_MODEL ?? actualModel ?? null;
if (resolvedModel) {
  if (!digestJson.meta) digestJson.meta = {};
  digestJson.meta.model = resolvedModel;
  log(`Stamped meta.model = "${resolvedModel}" (${process.env.DIGEST_MODEL ? "DIGEST_MODEL env" : "stream-json init event"}).`);
}

// --- Upload images to Pronto.io (if PRONTO_API_KEY is set) ---
if (process.env.PRONTO_API_KEY) {
  const date = digestJson.date ?? "unknown";

  // Handle new images[] array
  if (Array.isArray(digestJson.images)) {
    for (const img of digestJson.images) {
      if (!img.url) continue;
      try {
        const filename = `${date}-${img.id}.png`;
        img.url = await uploadImageFromUrl(img.url, filename);
        log(`Uploaded image "${img.id}" to Pronto.io: ${img.url}`);
      } catch (err) {
        log(`WARNING: Could not upload image "${img.id}" to Pronto.io: ${err.message}. Keeping original URL.`);
      }
    }
  }

  // Handle legacy hero_image
  if (digestJson.hero_image?.url) {
    try {
      digestJson.hero_image.url = await uploadImageFromUrl(digestJson.hero_image.url, `${date}-hero.png`);
      log(`Uploaded legacy hero_image to Pronto.io: ${digestJson.hero_image.url}`);
    } catch (err) {
      log(`WARNING: Could not upload hero_image to Pronto.io: ${err.message}. Keeping original URL.`);
    }
  }
} else {
  log("PRONTO_API_KEY not set — skipping Pronto.io upload, keeping Wavespeed URLs.");
}

// --- Write the digest file ---
const date = digestJson.date;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  die(`Digest "date" field is missing or not in YYYY-MM-DD format: "${date}"`);
}

try {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
} catch (err) {
  die(`Could not create output directory "${OUTPUT_DIR}": ${err.message}`);
}

const digestFilePath = path.join(OUTPUT_DIR, `${date}.json`);
try {
  fs.writeFileSync(digestFilePath, JSON.stringify(digestJson, null, 2), "utf8");
  log(`Digest written to ${digestFilePath}`);
} catch (err) {
  die(`Failed to write digest file at "${digestFilePath}": ${err.message}`);
}

// --- Update index.json ---
let index = [];
if (fs.existsSync(INDEX_FILE)) {
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    if (!Array.isArray(index)) {
      log(`WARNING: Existing index.json is not an array; starting fresh.`);
      index = [];
    }
  } catch (err) {
    log(`WARNING: Could not parse existing index.json (${err.message}); starting fresh.`);
    index = [];
  }
}

// Remove any existing entry for this date to avoid duplicates
index = index.filter((entry) => entry.date !== date);

// Build the summary entry
// Resolve hero image — prefer images[0], fall back to legacy hero_image
const heroImg = digestJson.images?.[0] ?? digestJson.hero_image ?? {};

const indexEntry = {
  id: digestJson.id,
  date: digestJson.date,
  theme: {
    type: digestJson.theme?.type,
    value: digestJson.theme?.value,
    tagline: digestJson.theme?.tagline,
  },
  hero_image: {
    url: heroImg.url ?? "",
    alt: heroImg.alt ?? "",
  },
  meta: digestJson.meta ?? { event_count: digestJson.events.length },
};

index.push(indexEntry);

// Sort descending by date and keep only the most recent MAX_INDEX_ENTRIES
index.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
if (index.length > MAX_INDEX_ENTRIES) {
  index = index.slice(0, MAX_INDEX_ENTRIES);
}

try {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
  log(`index.json updated (${index.length} total entries).`);
} catch (err) {
  die(`Failed to write index.json at "${INDEX_FILE}": ${err.message}`);
}

log(`Success: digest for ${date} written with ${digestJson.events.length} events.`);
