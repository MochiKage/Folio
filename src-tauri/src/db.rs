use rusqlite::{Connection, Result as SqliteResult};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_dir: PathBuf) -> SqliteResult<Self> {
        std::fs::create_dir_all(&app_dir).ok();
        let db_path = app_dir.join("folio.db");
        let conn = Connection::open(db_path)?;

        // Enable WAL mode for better concurrent reads
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.initialize_schema()?;
        db.run_migrations()?;
        Ok(db)
    }

    fn initialize_schema(&self) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            -- Documents table
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                title TEXT,
                authors TEXT DEFAULT '[]',
                file_path TEXT NOT NULL UNIQUE,
                doi TEXT,
                year INTEGER,
                page_count INTEGER DEFAULT 0,
                last_page INTEGER DEFAULT 1,
                read_progress REAL DEFAULT 0.0,
                metadata TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- Tags for document classification
            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                value TEXT NOT NULL,
                color TEXT,
                UNIQUE(namespace, value)
            );

            CREATE TABLE IF NOT EXISTS document_tags (
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (document_id, tag_id)
            );

            -- Annotations
            CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                page INTEGER NOT NULL,
                annot_type TEXT NOT NULL DEFAULT 'highlight',
                color TEXT,
                rect TEXT DEFAULT '[]',
                content TEXT,
                metadata TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- Bookmarks
            CREATE TABLE IF NOT EXISTS bookmarks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                page INTEGER NOT NULL,
                label TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            -- Vocabulary / Word bank
            CREATE TABLE IF NOT EXISTS vocabulary (
                id TEXT PRIMARY KEY,
                word TEXT NOT NULL,
                phonetic TEXT,
                definition TEXT DEFAULT '{}',
                sentence TEXT,
                source_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
                source_page INTEGER,
                tags TEXT DEFAULT '[]',
                review_count INTEGER DEFAULT 0,
                last_review_at TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- OCR cache
            CREATE TABLE IF NOT EXISTS ocr_cache (
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                page INTEGER NOT NULL,
                text TEXT,
                confidence REAL,
                boxes TEXT DEFAULT '[]',
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (document_id, page)
            );

            -- TTS audio cache
            CREATE TABLE IF NOT EXISTS tts_cache (
                text_hash TEXT PRIMARY KEY,
                audio_path TEXT NOT NULL,
                voice_id TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );

            -- User-installed dictionaries
            CREATE TABLE IF NOT EXISTS dictionaries (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source_lang TEXT NOT NULL DEFAULT 'en',
                target_lang TEXT NOT NULL DEFAULT 'zh',
                format TEXT NOT NULL,
                file_path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                priority INTEGER NOT NULL DEFAULT 10,
                entry_count INTEGER DEFAULT 0,
                is_builtin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            -- Settings
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Full-text search index
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_documents
                USING fts5(title, authors, content='documents', content_rowid='rowid');

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_annotations_doc
                ON annotations(document_id, page);
            CREATE INDEX IF NOT EXISTS idx_bookmarks_doc
                ON bookmarks(document_id);
            CREATE INDEX IF NOT EXISTS idx_vocabulary_word
                ON vocabulary(word);
            CREATE INDEX IF NOT EXISTS idx_document_tags_doc
                ON document_tags(document_id);
            CREATE INDEX IF NOT EXISTS idx_document_tags_tag
                ON document_tags(tag_id);
            "
        )?;
        Ok(())
    }

    fn run_migrations(&self) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();

        // Migration: add boxes column to ocr_cache if missing
        let has_boxes_col: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('ocr_cache') WHERE name = 'boxes'")?
            .exists([])?;
        if !has_boxes_col {
            conn.execute(
                "ALTER TABLE ocr_cache ADD COLUMN boxes TEXT DEFAULT '[]'",
                [],
            )?;
        }

        Ok(())
    }
}
