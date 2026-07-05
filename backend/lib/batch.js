// Shared by every script that walks a folder of photos through the vision
// pipeline (prove-pipeline.js, ingest.js): CLI arg parsing, a concurrency
// pool, and rate-limit retry/backoff. Extracted once a second script needed
// the exact same ~40 lines rather than diverging copies.

export function parseArgs(argv) {
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

export function serializeError(err) {
  return {
    name: err.name,
    message: err.message,
    status: err.status ?? null,
    apiError: err.error ?? null,
    requestId: err.requestID ?? err.headers?.["request-id"] ?? null,
    stack: err.stack,
  };
}

export const RETRYABLE_STATUSES = new Set([429, 503, 529]);
export const MAX_RETRIES = 5;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Anthropic's API returns 429s constantly on low-tier accounts under any
// real concurrency — this isn't an edge case, it's the normal shape of a
// batch run. Retry-After is honored when present; otherwise back off
// exponentially so a real 40-100 photo batch survives its own rate limit.
export function backoffMs(err, attempt) {
  const retryAfter = err.headers?.["retry-after"];
  if (retryAfter) return Math.ceil(Number(retryAfter) * 1000) + 500;
  return Math.min(2 ** attempt * 2000, 30000);
}

export async function runPool(items, concurrency, worker) {
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
