#!/usr/bin/env node
// Phase 1 proving script — see /README.md and the build brief.
//
// Sends every photo in a folder to Claude vision, asking for exactly one
// caption and one category. Logs per-photo success/fail, latency, and the
// full raw error on failure. Prints an aggregate summary at the end.
//
// Usage:
//   node scripts/prove-pipeline.js <folder> [--concurrency=5] [--model=claude-sonnet-5]

import "dotenv/config";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { analyzePhoto, SUPPORTED_EXTENSIONS } from "../lib/vision.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags[key] = value ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function serializeError(err) {
  return {
    name: err.name,
    message: err.message,
    status: err.status ?? null,
    apiError: err.error ?? null,
    requestId: err.requestID ?? err.headers?.["request-id"] ?? null,
    stack: err.stack,
  };
}

const RETRYABLE_STATUSES = new Set([429, 503, 529]);
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Anthropic's API returns 429s constantly on low-tier accounts under any
// real concurrency — this isn't an edge case, it's the normal shape of a
// batch run. Retry-After is honored when present; otherwise back off
// exponentially so a real 40-100 photo batch survives its own rate limit.
function backoffMs(err, attempt) {
  const retryAfter = err.headers?.["retry-after"];
  if (retryAfter) return Math.ceil(Number(retryAfter) * 1000) + 500;
  return Math.min(2 ** attempt * 2000, 30000);
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, next));
  return results;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const folder = positional[0];

  if (!folder) {
    console.error("Usage: node scripts/prove-pipeline.js <folder> [--concurrency=5] [--model=claude-sonnet-5]");
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

  console.log(`Capture — Phase 1 pipeline proof`);
  console.log(`Model: ${model} | Concurrency: ${concurrency} | Photos: ${files.length}\n`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const batchStart = Date.now();

  const results = await runPool(files, concurrency, async (filePath) => {
    const start = Date.now();
    const name = path.basename(filePath);
    let attempt = 0;

    while (true) {
      try {
        const {
          caption,
          category,
          equipment,
          conditions,
          activities,
          droppedTags,
          visibleText,
          keywords,
          confidence,
          usage,
        } = await analyzePhoto(client, model, filePath);
        const latencyMs = Date.now() - start;
        const equipmentTag = equipment?.length ? ` {${equipment.join(", ")}}` : "";
        const conditionTag = conditions?.length ? ` (${conditions.join(", ")})` : "";
        const activityTag = activities?.length ? ` <${activities.join(", ")}>` : "";
        const textTag = visibleText?.length ? ` [text: ${visibleText.join(" | ")}]` : "";
        const keywordTag = keywords?.length ? ` [kw: ${keywords.join(", ")}]` : "";
        const confidenceTag = ` (conf ${confidence.toFixed(2)})`;
        console.log(
          `OK   ${latencyMs.toString().padStart(6)}ms  ${name}  [${category}]${equipmentTag}${conditionTag}${activityTag}${confidenceTag} ${caption}${textTag}${keywordTag}`
        );
        if (droppedTags?.length) {
          console.log(`WARN  out-of-vocabulary tag(s) dropped for ${name}: ${droppedTags.join(", ")}`);
        }
        return {
          file: name,
          status: "ok",
          latencyMs,
          caption,
          category,
          equipment,
          conditions,
          activities,
          droppedTags,
          visibleText,
          keywords,
          confidence,
          usage,
          retries: attempt,
        };
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

  const totalBatchTimeMs = Date.now() - batchStart;
  const succeeded = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "fail");
  const avgLatencyMs = succeeded.length
    ? Math.round(succeeded.reduce((sum, r) => sum + r.latencyMs, 0) / succeeded.length)
    : 0;

  const categoryBreakdown = {};
  const equipmentBreakdown = {};
  const conditionBreakdown = {};
  const activityBreakdown = {};
  for (const r of succeeded) {
    categoryBreakdown[r.category] = (categoryBreakdown[r.category] ?? 0) + 1;
    for (const item of r.equipment ?? []) {
      equipmentBreakdown[item] = (equipmentBreakdown[item] ?? 0) + 1;
    }
    for (const tag of r.conditions ?? []) {
      conditionBreakdown[tag] = (conditionBreakdown[tag] ?? 0) + 1;
    }
    for (const activity of r.activities ?? []) {
      activityBreakdown[activity] = (activityBreakdown[activity] ?? 0) + 1;
    }
  }

  const withVisibleText = succeeded.filter((r) => r.visibleText?.length).length;
  const avgKeywordCount = succeeded.length
    ? Math.round((succeeded.reduce((sum, r) => sum + (r.keywords?.length ?? 0), 0) / succeeded.length) * 10) / 10
    : 0;
  const totalDroppedTags = succeeded.reduce((sum, r) => sum + (r.droppedTags?.length ?? 0), 0);
  const LOW_CONFIDENCE_THRESHOLD = 0.6;
  const avgConfidence = succeeded.length
    ? Math.round((succeeded.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / succeeded.length) * 100) / 100
    : 0;
  const lowConfidenceCount = succeeded.filter((r) => r.confidence < LOW_CONFIDENCE_THRESHOLD).length;

  const summary = {
    total: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    successRatePct: Number(((succeeded.length / results.length) * 100).toFixed(1)),
    avgLatencyMs,
    minLatencyMs: succeeded.length ? Math.min(...succeeded.map((r) => r.latencyMs)) : null,
    maxLatencyMs: succeeded.length ? Math.max(...succeeded.map((r) => r.latencyMs)) : null,
    totalBatchTimeMs,
    totalDroppedTags,
    categoryBreakdown,
    equipmentBreakdown,
    conditionBreakdown,
    activityBreakdown,
    withVisibleText,
    avgKeywordCount,
    avgConfidence,
    lowConfidenceCount,
  };

  console.log("\n--- Summary ---");
  console.log(`Success rate:     ${summary.successRatePct}% (${summary.succeeded}/${summary.total})`);
  console.log(`Avg latency:      ${summary.avgLatencyMs}ms  (min ${summary.minLatencyMs}ms / max ${summary.maxLatencyMs}ms)`);
  console.log(`Total batch time: ${(summary.totalBatchTimeMs / 1000).toFixed(1)}s`);
  console.log(`Avg keywords:     ${summary.avgKeywordCount}/photo`);
  console.log(`Avg confidence:   ${summary.avgConfidence}  (${summary.lowConfidenceCount} below ${LOW_CONFIDENCE_THRESHOLD} threshold)`);
  console.log(`Dropped tags:     ${summary.totalDroppedTags} out-of-vocabulary value(s) sanitized`);
  console.log(`Categories:       ${JSON.stringify(summary.categoryBreakdown)}`);
  console.log(`Photos w/ text:   ${summary.withVisibleText}/${summary.succeeded}`);
  console.log(`Equipment:        ${JSON.stringify(summary.equipmentBreakdown)}`);
  console.log(`Conditions:       ${JSON.stringify(summary.conditionBreakdown)}`);
  console.log(`Activities:       ${JSON.stringify(summary.activityBreakdown)}`);

  if (failed.length > 0) {
    console.log(`\n${failed.length} failure(s) — full raw errors:`);
    for (const r of failed) {
      console.log(`\n  ${r.file}:`);
      console.log(`  ${JSON.stringify(r.error, null, 2).replace(/\n/g, "\n  ")}`);
    }
  }

  await mkdir(path.join(process.cwd(), "output"), { recursive: true });
  const reportPath = path.join(process.cwd(), "output", `report-${batchStart}.json`);
  await writeFile(reportPath, JSON.stringify({ model, concurrency, folder, summary, results }, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
