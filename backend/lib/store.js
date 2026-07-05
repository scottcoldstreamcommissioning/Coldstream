import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Storage interface — every method here is the contract the rest of the app
// depends on. The brief calls for Google Drive or a database, decided once
// the AI pipeline is solid, kept swappable behind an interface. SQLite +
// local filesystem is the concrete choice for now (zero external accounts,
// trivial to run in this environment); a Google Drive-backed implementation
// of the same methods could replace this file without touching any caller.
// Metadata lives in SQLite; original photo bytes live on disk — the
// resized/re-encoded copy vision.js sends to the API is never persisted,
// only used in-flight for the API call.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  originalFilename TEXT NOT NULL,
  storedPath TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  caption TEXT,
  category TEXT,
  equipment TEXT NOT NULL DEFAULT '[]',
  conditions TEXT NOT NULL DEFAULT '[]',
  activities TEXT NOT NULL DEFAULT '[]',
  visibleText TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  site TEXT,
  project TEXT,
  workType TEXT,
  note TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_createdAt ON photos(createdAt);
`;

const JSON_FIELDS = ["equipment", "conditions", "activities", "visibleText", "keywords"];
// Fields a caller (upload/retry/tagging flow) is allowed to write via addPhoto/updatePhoto.
const WRITABLE_FIELDS = [
  "status",
  "error",
  "caption",
  "category",
  "equipment",
  "conditions",
  "activities",
  "visibleText",
  "keywords",
  "confidence",
  "site",
  "project",
  "workType",
  "note",
];

function rowToPhoto(row) {
  if (!row) return null;
  const photo = { ...row };
  for (const field of JSON_FIELDS) {
    photo[field] = JSON.parse(row[field]);
  }
  photo.error = row.error ? JSON.parse(row.error) : null;
  return photo;
}

function analysisToFields(analysis) {
  return {
    status: "ok",
    error: null,
    caption: analysis.caption ?? null,
    category: analysis.category ?? null,
    equipment: JSON.stringify(analysis.equipment ?? []),
    conditions: JSON.stringify(analysis.conditions ?? []),
    activities: JSON.stringify(analysis.activities ?? []),
    visibleText: JSON.stringify(analysis.visibleText ?? []),
    keywords: JSON.stringify(analysis.keywords ?? []),
    confidence: analysis.confidence ?? null,
  };
}

// CREATE TABLE IF NOT EXISTS only handles a brand-new database — an existing
// capture.db from before a schema change (e.g. adding status/error columns
// for retry) is left untouched by it. Rather than requiring a full migration
// framework at this stage, add-only column diffs are applied automatically.
function migrate(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(photos)").all().map((c) => c.name));
  const columnDefs = {
    status: "TEXT NOT NULL DEFAULT 'ok'",
    error: "TEXT",
  };
  for (const [name, def] of Object.entries(columnDefs)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE photos ADD COLUMN ${name} ${def}`);
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath - path to the SQLite file
 * @param {string} opts.photosDir - directory original photo bytes are copied into
 */
export function createStore({ dbPath, photosDir }) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  mkdirSync(photosDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);

  const getStmt = db.prepare("SELECT * FROM photos WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM photos ORDER BY createdAt DESC LIMIT ? OFFSET ?");
  const untaggedStmt = db.prepare(
    "SELECT * FROM photos WHERE site IS NULL AND project IS NULL AND workType IS NULL ORDER BY createdAt ASC LIMIT ? OFFSET ?"
  );
  const countUntaggedStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM photos WHERE site IS NULL AND project IS NULL AND workType IS NULL"
  );
  // Dump-first tagging never blocks upload, so search has to work over whatever
  // the AI produced (caption/tags/OCR text/keywords) — not Site/Project, which
  // may not exist yet. Every searchable field is concatenated per-row and
  // matched against each query term (AND across terms) — keyword-in-corpus,
  // not true NLU, but the Phase 2 "keywords" field was written specifically to
  // carry colloquial phrasing so this covers most of what the brief asks for
  // ("dirty filters", "every RPZ valve") without an extra LLM call per search.

  return {
    /**
     * Persists one photo: copies the original bytes to disk and inserts its
     * metadata row. `analysis` is the successful vision.js output; pass
     * `error` instead (upload succeeded, analysis failed) to store the photo
     * anyway with status 'failed', so it shows up for per-photo retry rather
     * than being silently dropped.
     */
    addPhoto({ originalFilename, fileBuffer, mimeType, analysis, error }) {
      const id = randomUUID();
      const ext = path.extname(originalFilename) || ".jpg";
      const storedPath = `${id}${ext}`;
      writeFileSync(path.join(photosDir, storedPath), fileBuffer);

      const fields = analysis
        ? analysisToFields(analysis)
        : {
            status: "failed",
            error: JSON.stringify(error ?? { message: "Unknown error" }),
            caption: null,
            category: null,
            equipment: "[]",
            conditions: "[]",
            activities: "[]",
            visibleText: "[]",
            keywords: "[]",
            confidence: null,
          };

      const row = {
        id,
        originalFilename,
        storedPath,
        mimeType,
        site: null,
        project: null,
        workType: null,
        note: null,
        createdAt: new Date().toISOString(),
        ...fields,
      };

      db.prepare(
        `INSERT INTO photos (
          id, originalFilename, storedPath, mimeType, status, error, caption, category,
          equipment, conditions, activities, visibleText, keywords, confidence,
          site, project, workType, note, createdAt
        ) VALUES (
          @id, @originalFilename, @storedPath, @mimeType, @status, @error, @caption, @category,
          @equipment, @conditions, @activities, @visibleText, @keywords, @confidence,
          @site, @project, @workType, @note, @createdAt
        )`
      ).run(row);

      return rowToPhoto(row);
    },

    getPhoto(id) {
      return rowToPhoto(getStmt.get(id));
    },

    listPhotos({ limit = 200, offset = 0 } = {}) {
      return listStmt.all(limit, offset).map(rowToPhoto);
    },

    listUntagged({ limit = 200, offset = 0 } = {}) {
      return untaggedStmt.all(limit, offset).map(rowToPhoto);
    },

    countUntagged() {
      return countUntaggedStmt.get().n;
    },

    searchPhotos(query, { limit = 200 } = {}) {
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (terms.length === 0) return this.listPhotos({ limit });

      // better-sqlite3 needs a fixed parameter count per prepared statement,
      // so each term count gets its own query built from the same base SQL.
      const stmt = db.prepare(
        `SELECT * FROM photos WHERE ` +
          terms
            .map(
              () => `(lower(coalesce(caption,'') || ' ' || coalesce(category,'') || ' ' || equipment || ' ' ||
      conditions || ' ' || activities || ' ' || visibleText || ' ' || keywords || ' ' ||
      coalesce(site,'') || ' ' || coalesce(project,'') || ' ' || coalesce(workType,'') || ' ' || coalesce(note,'')) LIKE ?)`
            )
            .join(" AND ") +
          ` ORDER BY createdAt DESC LIMIT ?`
      );
      const params = [...terms.map((t) => `%${t}%`), limit];
      return stmt.all(...params).map(rowToPhoto);
    },

    /**
     * Partial update for fields an engineer can edit later (Phase 4):
     * tags, retry results, or the Site/Project/Work Type/note context
     * filled in by the tag-later flow.
     */
    updatePhoto(id, updates) {
      const existing = getStmt.get(id);
      if (!existing) return null;

      const merged = { ...existing };
      for (const field of WRITABLE_FIELDS) {
        if (!(field in updates)) continue;
        merged[field] = JSON_FIELDS.includes(field) ? JSON.stringify(updates[field]) : updates[field];
      }
      if ("error" in updates) merged.error = updates.error ? JSON.stringify(updates.error) : null;

      db.prepare(
        `UPDATE photos SET
          status = @status, error = @error, caption = @caption, category = @category,
          equipment = @equipment, conditions = @conditions, activities = @activities,
          visibleText = @visibleText, keywords = @keywords, confidence = @confidence,
          site = @site, project = @project, workType = @workType, note = @note
        WHERE id = @id`
      ).run(merged);

      return rowToPhoto(merged);
    },

    photoFilePath(photo) {
      return path.join(photosDir, photo.storedPath);
    },

    close() {
      db.close();
    },
  };
}
