#!/usr/bin/env node
// Real ingestion: analyze a folder of photos and persist them permanently.
// Unlike prove-pipeline.js (a reliability-testing harness meant to be
// re-run repeatedly without side effects), this is the real "upload a
// day's batch" path — every successfully analyzed photo is written to the
// store. See /README.md for the Phase 3 storage design.
//
// Usage:
//   node scripts/ingest.js <folder> [--concurrency=5] [--model=claude-sonnet-5]

import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { analyzePhoto, SUPPORTED_EXTENSIONS } from "../lib/vision.js";
import { createStore } from "../lib/store.js";
import { parseArgs, serializeError, RETRYABLE_STATUSES, MAX_RETRIES, sleep, backoffMs, runPool } from "../lib/batch.js";

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const folder = positional[0];

  if (!folder) {
    console.error("Usage: node scripts/ingest.js <folder> [--concurrency=5] [--model=claude-sonnet-5]");
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  const concurrency = flags.concurrency ? Number(flags.concurrency) : 5;
  const model = flags.model ?? process.env.VISION_MODEL ?? "claude-sonnet-5";

  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (err) {
    console.error(`Could not read folder "${folder}": ${err.message}`);
    process.exit(1);
  }

  const files = entries
    .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(folder, e.name))
    .sort();

  if (files.length === 0) {
    console.error(`No supported images found in "${folder}" (looked for: ${[...SUPPORTED_EXTENSIONS].join(", ")})`);
    process.exit(1);
  }

  const store = createStore({
    dbPath: path.join(process.cwd(), "data", "capture.db"),
    photosDir: path.join(process.cwd(), "data", "photos"),
  });

  console.log(`Capture — ingesting into permanent storage`);
  console.log(`Model: ${model} | Concurrency: ${concurrency} | Photos: ${files.length}\n`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const batchStart = Date.now();

  const results = await runPool(files, concurrency, async (filePath) => {
    const start = Date.now();
    const name = path.basename(filePath);
    let attempt = 0;

    while (true) {
      try {
        const analysis = await analyzePhoto(client, model, filePath);
        const fileBuffer = await readFile(filePath);
        const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
        const stored = store.addPhoto({ originalFilename: name, fileBuffer, mimeType, analysis });
        const latencyMs = Date.now() - start;
        console.log(`OK   ${latencyMs.toString().padStart(6)}ms  ${name}  -> stored id=${stored.id}  [${stored.category}] ${stored.caption}`);
        return { file: name, status: "ok", latencyMs, id: stored.id, retries: attempt };
      } catch (err) {
        if (RETRYABLE_STATUSES.has(err.status) && attempt < MAX_RETRIES) {
          const waitMs = backoffMs(err, attempt);
          attempt++;
          console.log(`WAIT ${waitMs.toString().padStart(6)}ms  ${name}  retry ${attempt}/${MAX_RETRIES} after ${err.status}`);
          await sleep(waitMs);
          continue;
        }
        const latencyMs = Date.now() - start;
        const serialized = serializeError(err);
        console.log(`FAIL ${latencyMs.toString().padStart(6)}ms  ${name}  ${serialized.status ?? ""} ${serialized.message}`);
        return { file: name, status: "fail", latencyMs, error: serialized, retries: attempt };
      }
    }
  });

  store.close();

  const totalBatchTimeMs = Date.now() - batchStart;
  const succeeded = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "fail");

  console.log("\n--- Summary ---");
  console.log(`Stored:           ${succeeded.length}/${results.length}`);
  console.log(`Total batch time: ${(totalBatchTimeMs / 1000).toFixed(1)}s`);

  if (failed.length > 0) {
    console.log(`\n${failed.length} failure(s) — full raw errors:`);
    for (const r of failed) {
      console.log(`\n  ${r.file}:`);
      console.log(`  ${JSON.stringify(r.error, null, 2).replace(/\n/g, "\n  ")}`);
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
