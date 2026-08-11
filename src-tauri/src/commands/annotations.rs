use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub document_id: String,
    pub page: i32,
    pub annot_type: String,
    pub color: Option<String>,
    pub rect: String,
    pub content: Option<String>,
    pub metadata: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[tauri::command]
pub fn get_annotations(db: State<Database>, document_id: String) -> Result<Vec<Annotation>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, document_id, page, annot_type, color, rect, content, metadata, created_at, updated_at FROM annotations WHERE document_id=?1 ORDER BY page, created_at")
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(rusqlite::params![document_id], |row| {
            Ok(Annotation {
                id: row.get(0)?,
                document_id: row.get(1)?,
                page: row.get(2)?,
                annot_type: row.get(3)?,
                color: row.get(4)?,
                rect: row.get(5)?,
                content: row.get(6)?,
                metadata: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn upsert_annotation(db: State<Database>, ann: Annotation) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO annotations (id, document_id, page, annot_type, color, rect, content, metadata, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           page=excluded.page, annot_type=excluded.annot_type, color=excluded.color,
           rect=excluded.rect, content=excluded.content, metadata=excluded.metadata,
           updated_at=datetime('now')",
        rusqlite::params![
            ann.id, ann.document_id, ann.page, ann.annot_type,
            ann.color, ann.rect, ann.content, ann.metadata
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_annotation(db: State<Database>, ann_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM annotations WHERE id=?1", rusqlite::params![ann_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
