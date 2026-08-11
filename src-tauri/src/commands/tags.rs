use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub namespace: String,
    pub value: String,
    pub color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TagWithCount {
    pub tag: Tag,
    pub count: i64,
}

#[tauri::command]
pub fn get_all_tags(db: State<Database>) -> Result<Vec<TagWithCount>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.namespace, t.value, t.color, COUNT(dt.document_id) as cnt
             FROM tags t
             LEFT JOIN document_tags dt ON t.id = dt.tag_id
             GROUP BY t.id
             ORDER BY t.namespace, t.value",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map([], |row| {
            Ok(TagWithCount {
                tag: Tag {
                    id: row.get(0)?,
                    namespace: row.get(1)?,
                    value: row.get(2)?,
                    color: row.get(3)?,
                },
                count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn upsert_tag(db: State<Database>, tag: Tag) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO tags (id, namespace, value, color) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![tag.id, tag.namespace, tag.value, tag.color],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn add_document_tag(db: State<Database>, document_id: String, tag_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?1, ?2)",
        rusqlite::params![document_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_document_tag(db: State<Database>, document_id: String, tag_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM document_tags WHERE document_id=?1 AND tag_id=?2",
        rusqlite::params![document_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_document_tags(db: State<Database>, document_id: String) -> Result<Vec<Tag>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.namespace, t.value, t.color
             FROM tags t
             JOIN document_tags dt ON t.id = dt.tag_id
             WHERE dt.document_id = ?1
             ORDER BY t.namespace, t.value",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(rusqlite::params![document_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                namespace: row.get(1)?,
                value: row.get(2)?,
                color: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn search_documents_by_tags(db: State<Database>, tag_ids: Vec<String>) -> Result<Vec<String>, String> {
    if tag_ids.is_empty() {
        return Ok(vec![]);
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let placeholders = tag_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT d.id FROM documents d
         JOIN document_tags dt ON d.id = dt.document_id
         WHERE dt.tag_id IN ({})
         GROUP BY d.id
         HAVING COUNT(DISTINCT dt.tag_id) = ?",
        placeholders
    );

    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
        tag_ids.iter().map(|id| Box::new(id.clone()) as Box<dyn rusqlite::types::ToSql>).collect();
    params.push(Box::new(tag_ids.len() as i64));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())), |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}
