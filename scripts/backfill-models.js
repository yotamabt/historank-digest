#!/usr/bin/env node
/**
 * backfill-models.js
 *
 * Fixes meta.model in digest JSON files and index.json where the stored value
 * is "auto" (or another placeholder) by reading the real model name from the
 * cron log (logs/cron.log), which captures postprocess.js output including
 * "actualModel: <name>" lines.
 *
 * Usage:
 *   node backfill-models.js [options]
 *
 * Options:
 *   --output-dir <path>   Directory containing digest JSONs and index.json
 *                         (defaults to OUTPUT_DIR env, then /var/www/historank/digests)
 *   --log <path>          Log file to parse for model info. Defaults to
 *                         logs/cron.log next to the project root (auto-detected).
 *   --model <name>        Fallback model name for dates not found in the log
 *   --replace <value>     Only replace entries whose current meta.model matches
 *                         this value (default: "auto")
 *   --dry-run             Print what would change without writing anything
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load .env from project root so OUTPUT_DIR etc. are available
// ---------------------------------------------------------------------------
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const clean = line.replace(/\r/, "").trim();
    if (!clean || clean.startsWith("#")) continue;
    const eq = clean.indexOf("=");
    if (eq === -1) continue;
    const key = clean.slice(0, eq).trim();
    const val = clean.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

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
console.log(`Output dir: ${outputDir}`);
const fallbackModel = get("--model") || null;
// --replace can be an exact value or a prefix ending with "*" (e.g. "auto*")
const replaceArg = get("--replace") || "auto*";
const replaceIsPrefix = replaceArg.endsWith("*");
const replaceValue = replaceIsPrefix ? replaceArg.slice(0, -1) : replaceArg;
const shouldReplace = (model) =>
  replaceIsPrefix ? (model ?? "").startsWith(replaceValue) : model === replaceValue;
const dryRun = has("--dry-run");

// ---------------------------------------------------------------------------
// Auto-detect log file
// ---------------------------------------------------------------------------
function findLogFile(explicitPath) {
  if (explicitPath) return explicitPath;

  // Try common locations relative to this script and the output dir
  const candidates = [
    path.join(__dirname, "..", "logs", "cron.log"),
    path.join(outputDir, "..", "logs", "cron.log"),
    path.join(process.env.DIGEST_DIR || "", "logs", "cron.log"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const logFilePath = findLogFile(get("--log"));

// ---------------------------------------------------------------------------
// Parse log → date → model map
// ---------------------------------------------------------------------------
const dateModelMap = {};

if (logFilePath) {
  console.log(`Reading log: ${logFilePath}`);
  try {
    const lines = fs.readFileSync(logFilePath, "utf8").split("\n");
    let currentDate = null;
    for (const line of lines) {
      const dateMatch = line.match(/=== HistoRank digest generation started for (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
      }

      if (!currentDate) continue;

      // "[postprocess] DIGEST_MODEL env: auto, actualModel: gemini-2.5-pro"
      const actualModelMatch = line.match(/actualModel:\s*([^\s,)]+)/);
      if (actualModelMatch) {
        const m = actualModelMatch[1];
        if (m !== "(not" && m !== "null" && m !== "auto") {
          if (!dateModelMap[currentDate]) dateModelMap[currentDate] = m;
        }
      }

      // "[TIMESTAMP] Gemini model: gemini-2.5-flash" (only when not "auto")
      const geminiMatch = line.match(/Gemini model:\s*(\S+)/);
      if (geminiMatch && geminiMatch[1] !== "auto") {
        if (!dateModelMap[currentDate]) dateModelMap[currentDate] = geminiMatch[1];
      }
    }
    console.log(`Found model info for ${Object.keys(dateModelMap).length} date(s) in log.\n`);
  } catch (err) {
    console.warn(`WARNING: could not read log file: ${err.message}\n`);
  }
} else {
  console.warn("WARNING: no log file found. Use --log <path> to specify one, or --model <name> as a fallback.\n");
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
let skippedCount = 0;
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

  if (!shouldReplace(currentModel)) continue;

  const newModel = dateModelMap[date] || fallbackModel;
  if (!newModel) {
    console.warn(`SKIP ${date}: not found in log and no --model fallback given`);
    skippedCount++;
    continue;
  }

  console.log(`${dryRun ? "[dry-run] " : ""}${date}: "${currentModel}" → "${newModel}"`);

  if (!dryRun) {
    digest.meta.model = newModel;
    fs.writeFileSync(filePath, JSON.stringify(digest, null, 2), "utf8");
  }

  changedDates.push(date);
  changedCount++;
}

console.log(`\n${dryRun ? "[dry-run] " : ""}Updated ${changedCount} digest file(s).${skippedCount ? ` Skipped ${skippedCount} (no log entry — re-run with --model <name> as fallback).` : ""}`);

if (changedCount === 0 || dryRun) process.exit(0);

// ---------------------------------------------------------------------------
// Patch index.json for changed dates
// ---------------------------------------------------------------------------
const indexPath = path.join(outputDir, "index.json");
let index = [];
try {
  index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
} catch {
  console.warn("WARNING: could not read existing index.json — skipping index update.");
  process.exit(0);
}

for (const date of changedDates) {
  const digest = JSON.parse(fs.readFileSync(path.join(outputDir, `${date}.json`), "utf8"));
  const idx = index.findIndex((e) => e.date === date);
  if (idx === -1) {
    console.warn(`WARNING: ${date} not found in index.json — skipping.`);
    continue;
  }
  if (!index[idx].meta) index[idx].meta = {};
  index[idx].meta.model = digest.meta.model;
  console.log(`index.json: ${date} → "${digest.meta.model}"`);
}

fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
console.log("index.json updated.");
