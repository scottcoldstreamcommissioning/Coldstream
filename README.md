# Capture

Capture is a module of Streamline (Coldstream Commissioning's internal
engineering platform). It turns the hundreds of site photos engineers take
every week into searchable, structured knowledge.

## Status: Phase 1, 2 & 3 complete — no UI built yet

Per the build brief, no UI is being built until the vision pipeline is
proven reliable on real site photos and photos persist properly. Phase 1
proved the AI call, Phase 2 expanded its output through the brief's full
feature list, Phase 3 added real storage behind a swappable interface.
Everything in this repo right now is backend + CLI tooling — no frontend
yet (that's Phase 4).

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

- `backend/` — Node backend. CLI tooling for now; grows into the real
  Express API layer in Phase 4, once the frontend needs endpoints.
  - `lib/vision.js` — the Claude vision call (image normalization, prompt,
    forced structured output, vocabulary, sanitization). This is the
    function every later phase builds on.
  - `lib/store.js` — storage interface (`addPhoto`/`getPhoto`/`listPhotos`/
    `updatePhoto`) + its concrete SQLite/filesystem implementation. Any
    consumer only talks to these five methods, so swapping in a
    Google Drive-backed implementation later touches this file only.
  - `lib/batch.js` — concurrency pool + rate-limit retry/backoff, shared by
    every script that walks a folder of photos.
  - `scripts/prove-pipeline.js` — reliability-testing CLI: batch-processes
    a folder through `lib/vision.js` and reports results. No side effects
    (nothing is persisted) — meant to be re-run repeatedly during testing.
  - `scripts/ingest.js` — the real "upload a batch" path: analyzes and
    permanently stores photos via `lib/store.js`.
  - `scripts/list-photos.js` — queries the store; used to prove persistence
    survives closing and reopening the app.
- `frontend/` — not started yet. Comes in Phase 4.

## Running the reliability proof

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

## Ingesting into permanent storage

```bash
npm run ingest -- /path/to/folder/of/photos
npm run list-photos           # run in a fresh process to prove persistence
```

`ingest.js` analyzes each photo exactly like the proving script, but
persists every success: the original photo bytes are copied to
`backend/data/photos/`, and its full analysis (caption, category,
equipment, conditions, activities, OCR text, keywords, confidence) is
written to `backend/data/capture.db` (SQLite). `backend/data/` is
gitignored — it's real site data and local test output, not something to
commit. `list-photos.js` opens the store in a brand new process, so
running it after `ingest.js` has fully exited proves the data survives
closing and reopening the app, not just staying alive in memory.

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

**Phase 3 (storage): built and verified.** Ran `ingest.js` on the full
20-photo test batch — 20/20 analyzed and stored (original bytes + full
metadata). Queried the store from a completely separate process
invocation (`list-photos.js`) and got back all 20 records with correctly
round-tripped JSON fields (equipment/conditions/activities/keywords arrays
intact). Also verified `updatePhoto` — set Site/Project/Work Type/note on
a record, closed the store, reopened it fresh, and the update was still
there with unrelated fields (e.g. equipment) untouched. This is the
concrete proof persistence survives closing and reopening the app, which
was a stated limitation of the artifact prototype.

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

## Storage design

SQLite (`backend/data/capture.db`) for metadata + local filesystem
(`backend/data/photos/`) for original photo bytes, chosen over Google
Drive for Phase 3 because it needs no external OAuth/account setup and is
trivial to run in this environment — the brief explicitly left this
decision open ("Google Drive... or a proper database if that proves
simpler"). Every caller only touches the five methods on `lib/store.js`'s
interface (`addPhoto`/`getPhoto`/`listPhotos`/`updatePhoto`/
`photoFilePath`), so a Google Drive-backed implementation of the same
interface could replace this file later without touching the API layer or
frontend. The schema already has nullable `site`/`project`/`workType`/
`note` columns for Phase 4's dump-first-tag-later flow — reserved now so
there's no migration surprise later, but no tagging logic exists yet.

## Next steps

**Phase 4** — UI: ledger view (not grid) as default, dump-first/tag-later
upload, untagged review queue, natural-language search, editable AI tags,
one-tap caption copy, per-photo retry with real errors, session summaries.
This is also when the Express API layer gets built — endpoints only get
added once the frontend actually needs them.

See the full build brief for detail on each phase.
