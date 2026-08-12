use tauri::State;
use crate::db::Database;
use crate::dictionary::{self, DictEntry, DictionaryManager, DictionaryMeta, ValidationResult};

// ─── Lookup ─────────────────────────────────────

#[tauri::command]
pub fn lookup_word(
    manager: State<DictionaryManager>,
    word: String,
) -> Result<Option<DictEntry>, String> {
    manager.lookup(&word)
}

// ─── Dictionary management ─────────────────────

#[tauri::command]
pub fn list_dictionaries(
    db: State<Database>,
) -> Result<Vec<DictionaryMeta>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, source_lang, target_lang, format, file_path, \
             enabled, priority, entry_count, is_builtin, created_at, updated_at \
             FROM dictionaries ORDER BY priority ASC",
        )
        .map_err(|e| e.to_string())?;

    let dicts = stmt
        .query_map([], |row| {
            Ok(DictionaryMeta {
                id: row.get(0)?,
                name: row.get(1)?,
                source_lang: row.get(2)?,
                target_lang: row.get(3)?,
                format: row.get(4)?,
                file_path: row.get(5)?,
                enabled: row.get::<_, bool>(6).unwrap_or(true),
                priority: row.get(7)?,
                entry_count: row.get(8)?,
                is_builtin: row.get::<_, bool>(9).unwrap_or(false),
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(dicts)
}

#[tauri::command]
pub fn validate_dictionary(
    file_path: String,
    format: String,
) -> Result<ValidationResult, String> {
    Ok(dictionary::validate_dictionary(&file_path, &format))
}

#[tauri::command]
pub fn add_dictionary(
    manager: State<DictionaryManager>,
    db: State<Database>,
    meta: DictionaryMeta,
) -> Result<(), String> {
    // 1. Validate the file first
    let validation = dictionary::validate_dictionary(&meta.file_path, &meta.format);
    if !validation.valid {
        let messages: Vec<String> = validation.errors.iter().map(|e| e.message.clone()).collect();
        return Err(format!("Dictionary validation failed:\n- {}", messages.join("\n- ")));
    }

    // 2. Load the backend (verifies it actually works)
    manager.load(meta.clone())?;

    // 3. Persist to database
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO dictionaries \
         (id, name, source_lang, target_lang, format, file_path, enabled, priority, entry_count, is_builtin) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)",
        rusqlite::params![
            meta.id,
            meta.name,
            meta.source_lang,
            meta.target_lang,
            meta.format,
            meta.file_path,
            meta.enabled,
            meta.priority,
            meta.entry_count,
        ],
    )
    .map_err(|e| format!("Failed to save dictionary: {}", e))?;

    log::info!("Dictionary added: {} ({})", meta.name, meta.id);
    Ok(())
}

#[tauri::command]
pub fn remove_dictionary(
    manager: State<DictionaryManager>,
    db: State<Database>,
    dict_id: String,
) -> Result<(), String> {
    // 1. Check it's not a built-in dictionary
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let is_builtin: bool = conn
        .query_row(
            "SELECT is_builtin FROM dictionaries WHERE id = ?1",
            rusqlite::params![dict_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Dictionary not found: {}", e))?;

    if is_builtin {
        return Err("Cannot remove the built-in dictionary. You can disable it instead.".into());
    }

    // 2. Unload from memory
    manager.unload(&dict_id);

    // 3. Remove from database
    conn.execute(
        "DELETE FROM dictionaries WHERE id = ?1 AND is_builtin = 0",
        rusqlite::params![dict_id],
    )
    .map_err(|e| format!("Failed to remove dictionary: {}", e))?;

    log::info!("Dictionary removed: {}", dict_id);
    Ok(())
}

#[tauri::command]
pub fn toggle_dictionary(
    manager: State<DictionaryManager>,
    db: State<Database>,
    dict_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Update in-memory
    if !manager.set_enabled(&dict_id, enabled) {
        return Err(format!("Dictionary not found in memory: {}", dict_id));
    }

    // Update database
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE dictionaries SET enabled = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![dict_id, enabled],
    )
    .map_err(|e| format!("Failed to update dictionary: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn reorder_dictionary(
    manager: State<DictionaryManager>,
    db: State<Database>,
    dict_id: String,
    new_priority: i32,
) -> Result<(), String> {
    // Update in-memory
    manager.set_priority(&dict_id, new_priority);

    // Update database — save all priorities
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    for meta in manager.list_metas() {
        conn.execute(
            "UPDATE dictionaries SET priority = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![meta.id, meta.priority],
        )
        .map_err(|e| format!("Failed to update priority: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn rename_dictionary(
    manager: State<DictionaryManager>,
    db: State<Database>,
    dict_id: String,
    new_name: String,
) -> Result<(), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("Dictionary name cannot be empty.".into());
    }

    // Update in-memory
    if !manager.rename(&dict_id, new_name) {
        return Err(format!("Dictionary not found in memory: {}", dict_id));
    }

    // Update database
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE dictionaries SET name = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![dict_id, new_name],
    )
    .map_err(|e| format!("Failed to rename dictionary: {}", e))?;

    log::info!("Dictionary renamed: {} → {}", dict_id, new_name);
    Ok(())
}
