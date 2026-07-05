import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// Storage interface — every method here is the contract the rest of the app
// depends on. The brief calls for Google Drive or a database, decided once
// the AI pipeline is solid, kept swappable behind an interface. SQLite +
// local filesystem is the concrete choice for now (zero external accounts,
// trivial to run in this environment); a Google Drive-backed implementation
// of the same five methods could replace this file without touching any
// caller. Metadata lives in SQLite; original photo bytes live on disk —
// the resized/re-encoded copy vision.js sends to the API is never persisted,
// only used in-flight for the API call.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  originalFilename TEXT NOT NULL,
  storedPath TEXT NOT NULL,
  mimeType TEXT NOT NULL,
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

function rowToPhoto(row) {
  if (!row) return null;
  const photo = { ...row };
  for (const field of JSON_FIELDS) {
    photo[field] = JSON.parse(row[field]);
  }
  return photo;
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

  const insertStmt = db.prepare(`
    INSERT INTO photos (
      id, originalFilename, storedPath, mimeType, caption, category,
      equipment, conditions, activities, visibleText, keywords, confidence,
      site, project, workType, note, createdAt
    ) VALUES (
      @id, @originalFilename, @storedPath, @mimeType, @caption, @category,
      @equipment, @conditions, @activities, @visibleText, @keywords, @confidence,
      @site, @project, @workType, @note, @createdAt
    )
  `);
  const getStmt = db.prepare("SELECT * FROM photos WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM photos ORDER BY createdAt DESC LIMIT ? OFFSET ?");

  return {
    /**
     * Persists one analyzed photo: copies the original bytes to disk and
     * inserts its metadata row. Returns the stored record.
     */
    addPhoto({ originalFilename, fileBuffer, mimeType, analysis }) {
      const id = randomUUID();
      const ext = path.extname(originalFilename) || ".jpg";
      const storedPath = `${id}${ext}`;
      writeFileSync(path.join(photosDir, storedPath), fileBuffer);

      const row = {
        id,
        originalFilename,
        storedPath,
        mimeType,
        caption: analysis.caption ?? null,
        category: analysis.category ?? null,
        equipment: JSON.stringify(analysis.equipment ?? []),
        conditions: JSON.stringify(analysis.conditions ?? []),
        activities: JSON.stringify(analysis.activities ?? []),
        visibleText: JSON.stringify(analysis.visibleText ?? []),
        keywords: JSON.stringify(analysis.keywords ?? []),
        confidence: analysis.confidence ?? null,
        site: null,
        project: null,
        workType: null,
        note: null,
        createdAt: new Date().toISOString(),
      };
      insertStmt.run(row);
      return rowToPhoto(row);
    },

    getPhoto(id) {
      return rowToPhoto(getStmt.get(id));
    },

    listPhotos({ limit = 100, offset = 0 } = {}) {
      return listStmt.all(limit, offset).map(rowToPhoto);
    },

    /**
     * Partial update for fields an engineer can edit later (Phase 4):
     * tags, or the Site/Project/Work Type/note context filled in by the
     * tag-later flow.
     */
    updatePhoto(id, updates) {
      const existing = getStmt.get(id);
      if (!existing) return null;

      const merged = { ...existing, ...updates };
      for (const field of JSON_FIELDS) {
        if (field in updates) merged[field] = JSON.stringify(updates[field]);
      }

      db.prepare(
        `UPDATE photos SET
          caption = @caption, category = @category, equipment = @equipment,
          conditions = @conditions, activities = @activities, visibleText = @visibleText,
          keywords = @keywords, confidence = @confidence, site = @site,
          project = @project, workType = @workType, note = @note
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
