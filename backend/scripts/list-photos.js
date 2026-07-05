#!/usr/bin/env node
// Queries the store in a fresh process — run this after ingest.js has
// exited to prove stored photos survive closing and reopening the app
// (a stated limitation of the artifact prototype that must not carry into
// this build). Not part of the API layer; just a Phase 3 verification tool.
//
// Usage:
//   node scripts/list-photos.js [--limit=100]

import "dotenv/config";
import path from "node:path";
import { createStore } from "../lib/store.js";
import { parseArgs } from "../lib/batch.js";

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const limit = flags.limit ? Number(flags.limit) : 100;

  const store = createStore({
    dbPath: path.join(process.cwd(), "data", "capture.db"),
    photosDir: path.join(process.cwd(), "data", "photos"),
  });

  const photos = store.listPhotos({ limit });
  console.log(`${photos.length} photo(s) in store (freshly opened in this process):\n`);
  for (const p of photos) {
    console.log(`${p.createdAt}  id=${p.id}  [${p.category}] ${p.caption}`);
    console.log(`  file: ${store.photoFilePath(p)}`);
  }

  store.close();
}

main();
