#!/usr/bin/env node
// Capture's API layer — the "real backend" the architecture note calls for.
// Serves the static frontend (public/) and the JSON API it calls over HTTP.
// Deliberately built only once the frontend needed it (Phase 4), not ahead
// of that need.
//
// Runs as its own page at its own URL, embeddable later as an <iframe>
// inside Streamline — no framing restrictions are set (no helmet/frameguard,
// no X-Frame-Options), and CORS is left open enough for cross-origin embeds
// once Capture and Streamline are hosted separately.

import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { analyzePhoto, SUPPORTED_EXTENSIONS } from "./lib/vision.js";
import { createStore } from "./lib/store.js";
import { serializeError } from "./lib/batch.js";

const PORT = process.env.PORT ?? 3001;
const MODEL = process.env.VISION_MODEL ?? "claude-sonnet-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const store = createStore({
  dbPath: path.join(process.cwd(), "data", "capture.db"),
  photosDir: path.join(process.cwd(), "data", "photos"),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — generous for a phone photo, not unbounded
});

const app = express();
app.use(express.json());

// Explicitly permissive rather than silent-by-default: this app is meant to
// be embedded cross-origin inside Streamline, so say so rather than relying
// on Express's lack of framing headers by accident.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

function isSupportedUpload(file) {
  return SUPPORTED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase());
}

// Dump-first, tag-later: this is the only upload path, and it accepts
// photos with zero required fields. Every photo — success or failure — is
// persisted, because a failed analysis still needs to exist for per-photo
// retry to have something to act on.
app.post("/api/photos", upload.array("photos", 100), async (req, res) => {
  const files = req.files ?? [];
  if (files.length === 0) {
    return res.status(400).json({ error: "No photos in upload" });
  }

  const results = await Promise.all(
    files.map(async (file) => {
      if (!isSupportedUpload(file)) {
        const stored = store.addPhoto({
          originalFilename: file.originalname,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
          error: { message: `Unsupported file type: ${path.extname(file.originalname)}` },
        });
        return stored;
      }

      try {
        const analysis = await analyzePhoto(client, MODEL, file.buffer);
        return store.addPhoto({
          originalFilename: file.originalname,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
          analysis,
        });
      } catch (err) {
        return store.addPhoto({
          originalFilename: file.originalname,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
          error: serializeError(err),
        });
      }
    })
  );

  const succeeded = results.filter((r) => r.status === "ok");
  const equipmentCounts = {};
  const issueCounts = {};
  const ISSUE_CONDITIONS = new Set(["Dirty", "Corroded", "Leaking", "Damaged", "Missing Insulation", "Missing Label", "Poor Access"]);
  for (const r of succeeded) {
    for (const item of r.equipment ?? []) equipmentCounts[item] = (equipmentCounts[item] ?? 0) + 1;
    for (const c of r.conditions ?? []) {
      if (ISSUE_CONDITIONS.has(c)) issueCounts[c] = (issueCounts[c] ?? 0) + 1;
    }
  }

  res.json({
    photos: results,
    summary: {
      total: results.length,
      succeeded: succeeded.length,
      failed: results.length - succeeded.length,
      equipmentCounts,
      issueCounts,
    },
  });
});

app.get("/api/photos", (req, res) => {
  const { search, limit, offset } = req.query;
  const opts = { limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined };
  const photos = search && String(search).trim() ? store.searchPhotos(String(search), opts) : store.listPhotos(opts);
  res.json({ photos });
});

app.get("/api/photos/untagged", (req, res) => {
  const { limit, offset } = req.query;
  const photos = store.listUntagged({ limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined });
  res.json({ photos, count: store.countUntagged() });
});

app.get("/api/photos/:id", (req, res) => {
  const photo = store.getPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: "Not found" });
  res.json({ photo });
});

app.get("/api/photos/:id/image", (req, res) => {
  const photo = store.getPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: "Not found" });
  res.sendFile(store.photoFilePath(photo));
});

// Editable AI tags + the Site/Project/Work Type/note tag-later flow both
// go through this one endpoint — same partial-update semantics either way.
app.patch("/api/photos/:id", (req, res) => {
  const updated = store.updatePhoto(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json({ photo: updated });
});

// Per-photo retry: re-run analysis on the ALREADY-STORED original bytes
// (not a re-upload), so the engineer never has to find the photo again.
app.post("/api/photos/:id/retry", async (req, res) => {
  const photo = store.getPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: "Not found" });

  try {
    const analysis = await analyzePhoto(client, MODEL, store.photoFilePath(photo));
    const updated = store.updatePhoto(photo.id, { ...analysis, status: "ok", error: null });
    res.json({ photo: updated });
  } catch (err) {
    const error = serializeError(err);
    const updated = store.updatePhoto(photo.id, { status: "failed", error });
    res.status(502).json({ photo: updated, error });
  }
});

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => {
  console.log(`Capture running at http://localhost:${PORT}`);
});
