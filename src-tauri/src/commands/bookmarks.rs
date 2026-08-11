use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub document_id: String,
    pub page: i32,
    pub label: Option<String>,
    pub created_at: Option<String>,
}

#[tauri::command]
pub fn get_bookmarks(db: State<Database>, document_id: String) -> Result<Vec<Bookmark>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, document_id, page, label, created_at FROM bookmarks WHERE document_id=?1 ORDER BY page")
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(rusqlite::params![document_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                document_id: row.get(1)?,
                page: row.get(2)?,
                label: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn add_bookmark(db: State<Database>, bm: Bookmark) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO bookmarks (id, document_id, page, label, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        rusqlite::params![bm.id, bm.document_id, bm.page, bm.label],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_bookmark(db: State<Database>, bm_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM bookmarks WHERE id=?1", rusqlite::params![bm_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
