/**
 * Migrate / reconvert digest image URLs to Pronto.io WebP.
 *
 * Modes:
 *   node scripts/migrate-to-pronto.js              — upload non-Pronto URLs (first-time migration)
 *   node scripts/migrate-to-pronto.js --reconvert  — re-upload all Pronto PNGs as WebP
 */

import fs from "fs";
import path from "path";
import { uploadImageFromUrl } from "./pronto.js";

const OUTPUT_DIR = process.env.OUTPUT_DIR || "/output";
const RECONVERT = process.argv.includes("--reconvert");

function needsProcessing(url) {
  if (typeof url !== "string" || !url) return false;
  if (RECONVERT) {
    // Re-upload any Pronto PNG (already migrated but not yet converted to WebP)
    return url.includes("getpronto.io") && !url.endsWith(".webp");
  }
  // First-time migration: upload anything not already on Pronto
  return !url.includes("getpronto.io");
}

function log(msg) {
  console.log(`[migrate-to-pronto] ${msg}`);
}

if (!process.env.PRONTO_API_KEY) {
  console.error("[migrate-to-pronto] ERROR: PRONTO_API_KEY is not set.");
  process.exit(1);
}

log(RECONVERT ? "Mode: reconvert existing Pronto PNGs to WebP." : "Mode: first-time migration to Pronto.io.");

const files = fs.readdirSync(OUTPUT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
log(`Found ${files.length} digest file(s) in ${OUTPUT_DIR}.`);

let totalUploaded = 0;
let totalSkipped = 0;
let totalFailed = 0;

for (const file of files) {
  const filePath = path.join(OUTPUT_DIR, file);
  const date = file.replace(".json", "");
  let digest;

  try {
    digest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    log(`SKIP ${file}: could not parse JSON — ${err.message}`);
    continue;
  }

  let changed = false;

  // Process images[]
  if (Array.isArray(digest.images)) {
    for (const img of digest.images) {
      if (!needsProcessing(img.url)) { totalSkipped++; continue; }
      try {
        img.url = await uploadImageFromUrl(img.url, `${date}-${img.id}.png`);
        log(`  ${file}: processed image "${img.id}" → ${img.url}`);
        changed = true;
        totalUploaded++;
      } catch (err) {
        log(`  ${file}: FAILED image "${img.id}" — ${err.message}`);
        totalFailed++;
      }
    }
  }

  // Process legacy hero_image
  if (needsProcessing(digest.hero_image?.url)) {
    try {
      digest.hero_image.url = await uploadImageFromUrl(digest.hero_image.url, `${date}-hero.png`);
      log(`  ${file}: processed hero_image → ${digest.hero_image.url}`);
      changed = true;
      totalUploaded++;
    } catch (err) {
      log(`  ${file}: FAILED hero_image — ${err.message}`);
      totalFailed++;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(digest, null, 2), "utf8");
    log(`  ${file}: saved.`);
  }
}

log(`Done. Processed: ${totalUploaded}, skipped: ${totalSkipped}, failed: ${totalFailed}.`);
