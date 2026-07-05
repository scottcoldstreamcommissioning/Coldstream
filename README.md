# Capture

Capture is a module of Streamline (Coldstream Commissioning's internal
engineering platform). It turns the hundreds of site photos engineers take
every week into searchable, structured knowledge.

## Status: Phase 1 — proving the AI pipeline

Per the build brief, no UI is being built until the vision pipeline is
proven reliable on real site photos. Everything in this repo right now is
that proof: a CLI script that sends photos to Claude vision and reports
whether it works.

**Do not build Phase 2+ until this consistently succeeds (>90% useful
output) on a real batch of 15-20 Coldstream site photos, at acceptable
latency for a 40-100 photo batch.**

### Why this failed before

The original prototype was a Claude.ai artifact (React running in a
sandboxed browser iframe). Its vision calls failed because the artifact
sandbox's `fetch()` proxy rejected requests to the Anthropic API before
they reached the model — a platform limitation, not a fixable bug. Capture
is now a real backend (this repo) plus a static frontend, so the vision
call happens server-side with real error visibility. This also means
Capture can later be embedded as an `<iframe>` inside Streamline without
any code changes — it's built as its own page from day one, not merged
into the host document.

## Architecture

- `backend/` — Node backend. Right now it's just the Phase 1 proving
  script; it grows into the real API layer (Express) in later phases.
  - `lib/vision.js` — the Claude vision call itself (image normalization,
    prompt, forced structured output). This is the function every later
    phase builds on.
  - `scripts/prove-pipeline.js` — Phase 1 CLI: batch-processes a folder of
    photos through `lib/vision.js` and reports results.
- `frontend/` — not started yet. Comes in Phase 4, after storage (Phase 3)
  and the expanded AI output (Phase 2) are solid.

## Running the Phase 1 proof

```bash
cd backend
npm install
cp .env.example .env   # then add your ANTHROPIC_API_KEY

npm run prove -- /path/to/folder/of/photos
# optional flags:
npm run prove -- /path/to/photos --concurrency=8 --model=claude-sonnet-5
```

Supported formats: jpg, jpeg, png, webp, gif, heic, heif. Images are
resized (long edge capped at 1568px, per Anthropic's guidance) and
re-encoded as JPEG before sending, so large phone photos don't blow the
API's payload limit.

For each photo, the script prints one line as soon as that photo finishes:

```
OK      842ms  IMG_4213.jpg  [Water Sampling & Testing] Sample bottle labelled "COLINGTON MAINS PRIMARY LTHW FINAL + INHIB"
FAIL    311ms  IMG_4219.jpg  529 Overloaded: ...
```

Photos are processed concurrently (default 5 at a time — override with
`--concurrency`), not one at a time, so a full day's batch doesn't take
forever. At the end it prints:

- Success rate (target: >90%)
- Average / min / max latency
- Total batch wall-clock time
- Category breakdown
- The full raw error (not a generic message) for every failure

A full JSON report (per-photo results + aggregate) is written to
`backend/output/report-<timestamp>.json` for inspection. That folder is
gitignored, as is any `test-photos/` or `photos/` folder — real site
photos should never be committed to this repo.

## What Phase 1 asks for exactly

One caption, one category — nothing more. Category is a small fixed list
(`lib/vision.js` → `CATEGORIES`) distinct from the full Phase 2 equipment/
condition/activity taxonomy in the build brief; that expansion happens only
once caption + category is proven reliable.

## Next steps (do not start until Phase 1 passes its gate)

1. **Phase 2** — incrementally add equipment detection, condition tags,
   activity recognition, OCR, keywords, confidence score. Test reliability
   after each addition, not all at once. Give water sampling / flushing /
   chemical dosing first-class treatment (dedicated work types + tags).
2. **Phase 3** — real storage (Google Drive or a database, decided once
   Phase 1/2 are solid) behind an interface, so it's swappable later.
   Must survive closing and reopening the app.
3. **Phase 4** — UI: ledger view (not grid) as default, dump-first/tag-later
   upload, untagged review queue, natural-language search, editable AI
   tags, one-tap caption copy, per-photo retry with real errors, session
   summaries.

See the full build brief for detail on each phase.
