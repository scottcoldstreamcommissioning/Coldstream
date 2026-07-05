# Capture

Capture is a module of Streamline (Coldstream Commissioning's internal
engineering platform). It turns the hundreds of site photos engineers take
every week into searchable, structured knowledge.

## Status: Phase 1 & 2 complete — AI output proven, no UI built yet

Per the build brief, no UI is being built until the vision pipeline is
proven reliable on real site photos. Everything in this repo right now is
that proof: a CLI script that sends photos to Claude vision and reports
whether it works, expanded incrementally through the brief's full Phase 2
feature list.

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

- `backend/` — Node backend. Right now it's just the proving script; it
  grows into the real API layer (Express) in Phase 3.
  - `lib/vision.js` — the Claude vision call itself (image normalization,
    prompt, forced structured output, vocabulary, sanitization). This is
    the function every later phase builds on.
  - `scripts/prove-pipeline.js` — proving CLI: batch-processes a folder of
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

For each photo, the script prints one line as soon as that photo finishes,
with every field the model returns:

```
OK   4263ms  IMG_4213.jpg  [Water Sampling & Testing] {Sample Points} (Dirty) <Water Sampling> (conf 0.85) Sample bottle labelled "COLINGTON MAINS PRIMARY LTHW FINAL + INHIB" [text: COLINGTON MAINS | PRIMARY LTHW | FINAL + INHIB] [kw: water sample, dirty water, ...]
FAIL  311ms   IMG_4219.jpg  529 Overloaded: ...
WAIT  18500ms IMG_4220.jpg  retry 1/5 after 429
```

Photos are processed concurrently (default 5 at a time — override with
`--concurrency`), not one at a time, so a full day's batch doesn't take
forever. At the end it prints an aggregate: success rate, latency stats,
category/equipment/condition/activity breakdowns, average confidence and
how many photos fell below a low-confidence threshold, how many photos had
legible text, average keyword count, and how many out-of-vocabulary tags
got sanitized. Every failure prints its full raw error, not a generic
message.

A full JSON report (per-photo results + aggregate) is written to
`backend/output/report-<timestamp>.json` for inspection. That folder is
gitignored, as is any `test-photos/` or `photos/` folder — real site
photos should never be committed to this repo.

### Validation status

**Phase 1 gate (>90% success on 15-20 real photos): met.** Run against 20
real Coldstream site photos — water sample bottles (incl. handwritten
labels), a cold water storage tank interior (staining/limescale/biofilm),
a sump dip-test, plant room pipework (Grundfos and Wilo pump arrays,
underfloor heating manifolds), BMS/controller screens, data plates, and
ductwork: **100% success (20/20)**.

**Phase 2 (equipment, conditions, activities, OCR, keywords, confidence):
each increment added and re-validated against the same 20-photo batch
individually, per the brief's "test after each addition" instruction —
100% success held through every single addition.** Along the way, one real
reliability finding: a JSON schema `enum` on a tool-use field is a strong
instruction to Claude, not an API-enforced constraint, and it did once
emit a condition tag ("Wet") outside the defined vocabulary. Fixed with a
sanitization layer (`lib/vision.js` → `sanitizeEnum`/`sanitizeEnumArray`)
that drops anything outside the known vocabulary and surfaces what got
dropped, rather than letting vocabulary drift corrupt tag-based search
silently. Confidence scores are genuinely calibrated (observed range
0.55-0.95, lower on ambiguous/plain shots) rather than defaulting high.

One thing to sort out before a full-scale (40-100 photo) day's-batch run,
account-level not code-level: the Anthropic account used for testing has
low default rate limits (5 requests/min, 10k input tokens/min) —
consistent with no billing method attached yet. Retry-with-backoff
(honoring `Retry-After`) is built into the script to survive this, but it
inflates latency (avg ~35-45s/photo across the 20-photo runs, vs. ~3-20s
for a call that doesn't get rate-limited) and a 100-photo batch would take
a long time until the limit is raised at console.anthropic.com/settings/limits.

## What the vision call returns

Per photo: caption, category (fixed list), equipment (open vocabulary,
`lib/vision.js` → `EQUIPMENT_VOCABULARY`), condition tags (closed
vocabulary, `CONDITION_TAGS`), activities/work-type (closed vocabulary,
`ACTIVITIES`, includes the brief's dedicated water sampling/flushing/
dosing work types), verbatim OCR of all legible text, natural-language
search keywords, and a confidence score. Structured numeric extraction
from readings (chlorine ppm, temperature, etc. into real fields) is
deferred per the brief's own note — currently those live as raw OCR text,
not parsed fields.

## Next steps

1. **Phase 3** — real storage (Google Drive or a database, decided once
   this is solid — it is) behind an interface, so it's swappable later.
   Must survive closing and reopening the app.
2. **Phase 4** — UI: ledger view (not grid) as default, dump-first/tag-later
   upload, untagged review queue, natural-language search, editable AI
   tags, one-tap caption copy, per-photo retry with real errors, session
   summaries.

See the full build brief for detail on each phase.
