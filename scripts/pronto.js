/**
 * Pronto.io image upload utility.
 * Docs: https://www.getpronto.io/docs/api-reference/overview
 *
 * Usage:
 *   import { uploadImageFromUrl } from "./pronto.js";
 *   const prontoUrl = await uploadImageFromUrl(wavespeedUrl, "hero.png");
 */

import sharp from "sharp";

const PRONTO_BASE_URL = "https://api.getpronto.io/v1";

/**
 * Downloads an image from `sourceUrl`, converts it to WebP (quality 85),
 * and uploads it to Pronto.io. Returns the Pronto.io CDN URL.
 *
 * @param {string} sourceUrl   - URL of the image to download (e.g. wavespeed CDN URL)
 * @param {string} [filename]  - Optional filename hint (e.g. "2026-03-20-hero.png")
 * @returns {Promise<string>}  - Pronto.io URL of the uploaded file
 */
export async function uploadImageFromUrl(sourceUrl, filename) {
  const apiKey = process.env.PRONTO_API_KEY;
  if (!apiKey) throw new Error("PRONTO_API_KEY is not set.");

  // 1. Download the image (retry up to 3 times on 429 with exponential backoff)
  let imgRes;
  const MAX_FETCH_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      imgRes = await fetch(sourceUrl);
    } catch (err) {
      throw new Error(`Network error fetching image from ${sourceUrl}: ${err.message}`);
    }
    if (imgRes.status === 429) {
      if (attempt === MAX_FETCH_ATTEMPTS) {
        throw new Error(`Failed to fetch image from ${sourceUrl}: HTTP 429 after ${MAX_FETCH_ATTEMPTS} attempts`);
      }
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (!imgRes.ok) {
      throw new Error(`Failed to fetch image from ${sourceUrl}: HTTP ${imgRes.status}`);
    }
    break;
  }
  const rawBuffer = Buffer.from(await imgRes.arrayBuffer());

  // 2. Convert to WebP at quality 85 (~60-80% smaller than PNG)
  const webpBuffer = await sharp(rawBuffer).webp({ quality: 85 }).toBuffer();
  const name = (filename || `image-${Date.now()}`).replace(/\.[^.]+$/, "") + ".webp";

  // 3. Upload to Pronto.io via multipart/form-data
  const form = new FormData();
  form.append("file", new Blob([webpBuffer], { type: "image/webp" }), name);

  let uploadRes;
  try {
    uploadRes = await fetch(`${PRONTO_BASE_URL}/upload`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${apiKey}`,
      Accept: "application/json",
      // Note: do NOT set Content-Type manually — fetch sets it with the boundary
    },
      body: form,
    });
  } catch (err) {
    throw new Error(`Network error uploading to Pronto.io: ${err.message}`);
  }

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Pronto upload failed: HTTP ${uploadRes.status} — ${errText}`);
  }

  const data = await uploadRes.json();

  // Pronto response shape: { url, id, filename, mimetype, size, createdAt }
  // (or nested under data — handle both)
  const url =
    data?.file?.secureUrl ??
    data?.file?.rawUrl ??
    data?.url ??
    data?.data?.url;

  if (!url) {
    throw new Error(`Pronto upload response missing URL. Response: ${JSON.stringify(data)}`);
  }

  // Warm the CDN cache: one GET request pulls the image from origin into the edge,
  // so the first real user is served from cache rather than cold storage.
  try {
    const warmRes = await fetch(url);
    await warmRes.arrayBuffer(); // consume body to ensure full transfer is cached
  } catch {
    // Non-fatal — upload succeeded, cache warm is best-effort
  }

  return url;
}
