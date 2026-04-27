#!/usr/bin/env node
/**
 * backfill-models.js
 *
 * Fixes meta.model in digest JSON files and index.json where the stored value
 * is "auto" (or another placeholder) by replacing it with the real model name.
 *
 * Usage:
 *   node backfill-models.js [options]
 *
 * Options:
 *   --output-dir <path>   Directory containing digest JSONs and index.json
 *                         (defaults to OUTPUT_DIR env, then /var/www/historank/digests)
 *   --model <name>        Model name to use when the correct one can't be inferred
 *                         from a mapping file or the log (required unless --map is given)
 *   --map <path>          JSON file mapping "YYYY-MM-DD" → "model-name" for precise control
 *   --log <path>          digest.log file; the script will try to extract actualModel lines
 *   --replace <value>     Only replace entries whose current meta.model matches this value
 *                         (default: "auto")
 *   --dry-run             Print what would change without writing anything
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const has = (flag) => args.includes(flag);

const outputDir = get("--output-dir") || process.env.OUTPUT_DIR || "/var/www/historank/digests";
const defaultModel = get("--model");
const mapFile = get("--map");
const logFile = get("--log");
const replaceValue = get("--replace") || "auto";
const dryRun = has("--dry-run");

if (!defaultModel && !mapFile) {
  console.error("ERROR: provide --model <name> or --map <path>");
  console.error("  --model applies to all entries missing a known mapping");
  console.error("  --map   JSON file { \"YYYY-MM-DD\": \"model-name\", ... }");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build date → model map
// ---------------------------------------------------------------------------
const dateModelMap = {};

// 1. From --map file
if (mapFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    Object.assign(dateModelMap, raw);
    console.log(`Loaded ${Object.keys(raw).length} date→model entries from ${mapFile}`);
  } catch (err) {
    console.error(`ERROR: could not read --map file: ${err.message}`);
    process.exit(1);
  }
}

// 2. Parse log file for lines like:
//    [TIMESTAMP] === HistoRank digest generation started for YYYY-MM-DD ===
//    [postprocess] DIGEST_MODEL env: auto, actualModel: gemini-2.5-pro-preview-05-06
if (logFile) {
  try {
    const logContent = fs.readFileSync(logFile, "utf8");
    const lines = logContent.split("\n");
    let currentDate = null;
    for (const line of lines) {
      const dateMatch = line.match(/=== HistoRank digest generation started for (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
      }
      // postprocess.js log line (goes to stdout, captured by cron or piped output)
      const modelMatch = line.match(/actualModel:\s*([^\s,)]+)/);
      if (modelMatch && currentDate && modelMatch[1] !== "(not" && modelMatch[1] !== "null") {
        if (!dateModelMap[currentDate]) {
          dateModelMap[currentDate] = modelMatch[1];
        }
      }
      // generate.sh also logs "Gemini model: <name>"
      const geminiMatch = line.match(/Gemini model:\s*(\S+)/);
      if (geminiMatch && currentDate && geminiMatch[1] !== "auto") {
        if (!dateModelMap[currentDate]) {
          dateModelMap[currentDate] = geminiMatch[1];
        }
      }
    }
    console.log(`Extracted ${Object.keys(dateModelMap).length} date→model entries from log`);
  } catch (err) {
    console.warn(`WARNING: could not read --log file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Find all digest JSON files (exclude index.json)
// ---------------------------------------------------------------------------
let digestFiles;
try {
  digestFiles = fs.readdirSync(outputDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => path.join(outputDir, f));
} catch (err) {
  console.error(`ERROR: could not read output directory "${outputDir}": ${err.message}`);
  process.exit(1);
}

if (digestFiles.length === 0) {
  console.log("No digest files found — nothing to do.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Update digest files
// ---------------------------------------------------------------------------
let changedCount = 0;
const changedDates = [];

for (const filePath of digestFiles) {
  let digest;
  try {
    digest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(`WARNING: could not parse ${filePath}: ${err.message}`);
    continue;
  }

  const date = digest.date || path.basename(filePath, ".json");
  const currentModel = digest.meta?.model;

  if (currentModel !== replaceValue) {
    continue;
  }

  const newModel = dateModelMap[date] || defaultModel;
  if (!newModel) {
    console.warn(`SKIP ${date}: no model mapping found and no --model default given`);
    continue;
  }

  console.log(`${dryRun ? "[dry-run] " : ""}${date}: "${currentModel}" → "${newModel}"`);

  if (!dryRun) {
    if (!digest.meta) digest.meta = {};
    digest.meta.model = newModel;
    fs.writeFileSync(filePath, JSON.stringify(digest, null, 2), "utf8");
  }

  changedDates.push(date);
  changedCount++;
}

console.log(`\n${dryRun ? "[dry-run] " : ""}Updated ${changedCount} digest file(s).`);

if (changedCount === 0 || dryRun) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Rebuild index.json from updated digest files
// ---------------------------------------------------------------------------
const indexPath = path.join(outputDir, "index.json");
let index = [];
try {
  index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
} catch {
  console.warn("WARNING: could not read existing index.json — will rebuild from scratch");
}

for (const date of changedDates) {
  const digestPath = path.join(outputDir, `${date}.json`);
  let digest;
  try {
    digest = JSON.parse(fs.readFileSync(digestPath, "utf8"));
  } catch {
    continue;
  }

  const idx = index.findIndex((e) => e.date === date);
  if (idx === -1) {
    console.warn(`WARNING: ${date} not found in index.json — skipping index update for this date`);
    continue;
  }

  if (!index[idx].meta) index[idx].meta = {};
  index[idx].meta.model = digest.meta.model;
  console.log(`index.json: updated ${date} meta.model → "${digest.meta.model}"`);
}

fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
console.log("index.json updated.");
