import fs from "fs";
import path from "path";
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
if (isStreamJson) {
  const chunks = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // Extract the actual model from the init event
      if (event?.type === "init" && typeof event?.model === "string") {
        actualModel = event.model;
      }
      // Assistant text arrives as: { type: "message", role: "assistant", content: "...", delta: true }
      if (event?.type === "message" && event?.role === "assistant" && typeof event?.content === "string") {
        chunks.push(event.content);
      }
    } catch { /* skip malformed lines */ }
  }
  responseText = chunks.join("");
  log(`Detected stream-json format (${lines.length} events, ${chunks.length} content chunks, model: ${actualModel}).`);
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
  die("Could not extract a response string from the Gemini output.");
}

// --- Extract the digest JSON from the response string ---
let digestJson;

// Strategy 1: look for ```json ... ``` fence
const fenceMatch = responseText.match(/```json\s*([\s\S]*?)```/);
if (fenceMatch) {
  try {
    digestJson = JSON.parse(fenceMatch[1].trim());
    log("Extracted digest JSON from ```json fence.");
  } catch (err) {
    die(`Found \`\`\`json fence but failed to parse its contents: ${err.message}`);
  }
}

// Strategy 2: find outermost { ... }
if (!digestJson) {
  const firstBrace = responseText.indexOf("{");
  const lastBrace = responseText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = responseText.slice(firstBrace, lastBrace + 1);
    try {
      digestJson = JSON.parse(candidate);
      log("Extracted digest JSON by finding outermost braces.");
    } catch (err) {
      die(`Could not parse JSON from outermost braces: ${err.message}`);
    }
  }
}

if (!digestJson) {
  die("Could not locate a JSON object in the Gemini response string.");
}

// --- Validate required top-level fields ---
const REQUIRED_FIELDS = ["id", "date", "theme", "narrative", "events", "model_analysis", "sources"];
for (const field of REQUIRED_FIELDS) {
  if (digestJson[field] === undefined || digestJson[field] === null) {
    die(`Digest JSON is missing required field: "${field}"`);
  }
}

// images[] (new) or hero_image (legacy) — at least one must be present
if (!Array.isArray(digestJson.images) || digestJson.images.length === 0) {
  if (!digestJson.hero_image?.url) {
    die(`Digest must have either "images" array (new) or "hero_image.url" (legacy).`);
  }
  log("WARNING: using legacy hero_image field. Consider upgrading to images[].");
} else {
  log(`Images: ${digestJson.images.length} found.`);
  for (const img of digestJson.images) {
    if (!img.id || !img.url) die(`Each image must have "id" and "url". Found: ${JSON.stringify(img)}`);
  }
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

// --- Validate each event has ratings for all 4 models ---
const REQUIRED_MODELS = ["gemini", "chatgpt", "claude", "deepseek"];
for (const event of digestJson.events) {
  const eventLabel = `event id=${event.id ?? "(no id)"}`;
  if (!event.ratings || typeof event.ratings !== "object") {
    die(`${eventLabel} is missing a "ratings" object.`);
  }
  for (const modelKey of REQUIRED_MODELS) {
    if (!event.ratings[modelKey]) {
      die(`${eventLabel} is missing ratings for model "${modelKey}".`);
    }
    const rating = event.ratings[modelKey];
    if (typeof rating.score !== "number") {
      die(`${eventLabel} ratings.${modelKey}.score must be a number.`);
    }
  }
}

log(`Validation passed: ${digestJson.events.length} events, all 4 model ratings present.`);

// --- Stamp the actual model used (from stream-json init event) ---
if (actualModel) {
  if (!digestJson.meta) digestJson.meta = {};
  digestJson.meta.model = actualModel;
  log(`Stamped meta.model = "${actualModel}" (from stream-json init event).`);
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

// Prepend newest entry
index.unshift(indexEntry);

// Keep only the last MAX_INDEX_ENTRIES entries
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
