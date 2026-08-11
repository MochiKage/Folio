use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: Option<String>,
    pub authors: String,
    pub file_path: String,
    pub doi: Option<String>,
    pub year: Option<i32>,
    pub page_count: i32,
    pub last_page: i32,
    pub read_progress: f64,
    pub metadata: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[tauri::command]
pub fn get_all_documents(db: State<Database>) -> Result<Vec<Document>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, title, authors, file_path, doi, year, page_count, last_page, read_progress, metadata, created_at, updated_at FROM documents ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;

    let docs = stmt
        .query_map([], |row| {
            Ok(Document {
                id: row.get(0)?,
                title: row.get(1)?,
                authors: row.get(2)?,
                file_path: row.get(3)?,
                doi: row.get(4)?,
                year: row.get(5)?,
                page_count: row.get(6)?,
                last_page: row.get(7)?,
                read_progress: row.get(8)?,
                metadata: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(docs)
}

#[tauri::command]
pub fn upsert_document(db: State<Database>, doc: Document) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO documents (id, title, authors, file_path, doi, year, page_count, last_page, read_progress, metadata, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, authors=excluded.authors, doi=excluded.doi,
           year=excluded.year, page_count=excluded.page_count, last_page=excluded.last_page,
           read_progress=excluded.read_progress, metadata=excluded.metadata,
           updated_at=datetime('now')",
        rusqlite::params![
            doc.id, doc.title, doc.authors, doc.file_path,
            doc.doi, doc.year, doc.page_count, doc.last_page,
            doc.read_progress, doc.metadata
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_reading_progress(
    db: State<Database>,
    doc_id: String,
    page: i32,
    progress: f64,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE documents SET last_page=?1, read_progress=?2, updated_at=datetime('now') WHERE id=?3",
        rusqlite::params![page, progress, doc_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_document(db: State<Database>, doc_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM documents WHERE id=?1", rusqlite::params![doc_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
