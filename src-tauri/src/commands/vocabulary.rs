use serde::{Deserialize, Serialize};
use tauri::State;
use rusqlite::OptionalExtension;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize)]
pub struct VocabWord {
    pub id: String,
    pub word: String,
    pub phonetic: Option<String>,
    pub definition: String,
    pub sentence: Option<String>,
    pub source_doc_id: Option<String>,
    pub source_page: Option<i32>,
    pub tags: String,
    pub review_count: i32,
    pub last_review_at: Option<String>,
    pub created_at: Option<String>,
}

#[tauri::command]
pub fn get_vocabulary(db: State<Database>) -> Result<Vec<VocabWord>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, word, phonetic, definition, sentence, source_doc_id, source_page, tags, review_count, last_review_at, created_at FROM vocabulary ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map([], |row| {
            Ok(VocabWord {
                id: row.get(0)?,
                word: row.get(1)?,
                phonetic: row.get(2)?,
                definition: row.get(3)?,
                sentence: row.get(4)?,
                source_doc_id: row.get(5)?,
                source_page: row.get(6)?,
                tags: row.get(7)?,
                review_count: row.get(8)?,
                last_review_at: row.get(9)?,
                created_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn add_vocabulary(db: State<Database>, word: VocabWord) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Check if this word already exists (case-insensitive)
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM vocabulary WHERE lower(word) = lower(?1) LIMIT 1",
            rusqlite::params![word.word],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(existing_id) = existing_id {
        // Update existing word — preserve review_count unless the new value is higher
        conn.execute(
            "UPDATE vocabulary SET
               phonetic = COALESCE(?2, phonetic),
               definition = CASE WHEN ?3 != '{}' THEN ?3 ELSE definition END,
               sentence = COALESCE(?4, sentence),
               source_doc_id = COALESCE(?5, source_doc_id),
               source_page = COALESCE(?6, source_page),
               tags = CASE WHEN ?7 != '[]' THEN ?7 ELSE tags END,
               updated_at = datetime('now')
             WHERE id = ?1",
            rusqlite::params![
                existing_id, word.phonetic, word.definition,
                word.sentence, word.source_doc_id, word.source_page,
                word.tags
            ],
        )
        .map_err(|e| e.to_string())?;
    } else {
        // Insert new word
        conn.execute(
            "INSERT INTO vocabulary (id, word, phonetic, definition, sentence, source_doc_id, source_page, tags, review_count, last_review_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))",
            rusqlite::params![
                word.id, word.word, word.phonetic, word.definition,
                word.sentence, word.source_doc_id, word.source_page,
                word.tags, word.review_count, word.last_review_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn update_review(db: State<Database>, word_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE vocabulary SET review_count = review_count + 1, last_review_at = datetime('now'), updated_at = datetime('now') WHERE id=?1",
        rusqlite::params![word_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_vocabulary(db: State<Database>, word_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM vocabulary WHERE id=?1", rusqlite::params![word_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
