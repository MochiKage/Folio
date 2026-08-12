mod commands;
mod db;
mod dictionary;

use db::Database;
use dictionary::{DictionaryManager, DictionaryMeta};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // ── Database ──────────────────────────
            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let database = Database::new(app_dir)
                .expect("Failed to initialize database");

            // ── Dictionary Manager ────────────────
            let manager = DictionaryManager::new();
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            // 1. Load built-in dictionary from bundled resources.
            //    Search order: stardict.db → ecdict.db (dev + prod paths),
            //    plus common external paths.
            let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let candidate_names: [(&str, &str); 2] = [
                ("stardict.db", "Stardict 英汉词典"),
                ("ecdict.db",   "ECDICT 英汉词典"),
            ];

            let mut builtin_path = std::path::PathBuf::new();
            let mut builtin_name = "ECDICT 英汉词典";

            for (filename, label) in &candidate_names {
                let dev = manifest_dir.join("resources").join(filename);
                let prod = resource_dir.join("resources").join(filename);
                let dl = std::path::PathBuf::from("D:\\Downloads").join(filename);

                if dev.exists() {
                    builtin_path = dev;
                    builtin_name = label;
                    break;
                } else if prod.exists() {
                    builtin_path = prod;
                    builtin_name = label;
                    break;
                } else if dl.exists() {
                    builtin_path = dl;
                    builtin_name = label;
                    break;
                }
            }

            if builtin_path.as_os_str().is_empty() {
                log::warn!(
                    "Built-in dictionary not found (looked for stardict.db / ecdict.db in resources/ and D:\\Downloads\\)"
                );
            }

            let builtin_meta = DictionaryMeta {
                id: "builtin-dict".into(),
                name: builtin_name.to_string(),
                source_lang: "en".into(),
                target_lang: "zh".into(),
                format: "ecdict".into(),
                file_path: builtin_path.to_string_lossy().to_string(),
                enabled: true,
                priority: 0,
                entry_count: 0, // Updated by load()
                is_builtin: true,
                created_at: None,
                updated_at: None,
            };

            if !builtin_path.as_os_str().is_empty() {
                match manager.load(builtin_meta.clone()) {
                    Ok(()) => {
                        // Persist built-in dict metadata to DB (upsert)
                        let conn = database.conn.lock().unwrap();
                        // Remove stale built-in rows left over from a
                        // previous version (e.g. id "builtin-ecdict").
                        let _ = conn.execute(
                            "DELETE FROM dictionaries WHERE is_builtin = 1 AND id != ?1",
                            rusqlite::params![builtin_meta.id],
                        );
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO dictionaries \
                             (id, name, source_lang, target_lang, format, file_path, \
                              enabled, priority, entry_count, is_builtin, updated_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, datetime('now'))",
                            rusqlite::params![
                                builtin_meta.id,
                                builtin_meta.name,
                                builtin_meta.source_lang,
                                builtin_meta.target_lang,
                                builtin_meta.format,
                                builtin_meta.file_path,
                                builtin_meta.enabled,
                                builtin_meta.priority,
                                builtin_meta.entry_count,
                            ],
                        );
                    }
                    Err(e) => {
                        log::warn!("Failed to load built-in dictionary: {}", e);
                    }
                }
            }

            // 2. Load user-added dictionaries from the database
            let user_metas = load_user_dictionaries(&database);
            for meta in user_metas {
                match manager.load(meta.clone()) {
                    Ok(()) => log::info!("Loaded user dictionary: {}", meta.name),
                    Err(e) => log::warn!(
                        "Failed to load user dictionary '{}': {}",
                        meta.name,
                        e
                    ),
                }
            }

            app.manage(database);
            app.manage(manager);

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Documents
            commands::documents::get_all_documents,
            commands::documents::upsert_document,
            commands::documents::update_reading_progress,
            commands::documents::delete_document,
            // Annotations
            commands::annotations::get_annotations,
            commands::annotations::upsert_annotation,
            commands::annotations::delete_annotation,
            // Bookmarks
            commands::bookmarks::get_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            // Vocabulary
            commands::vocabulary::get_vocabulary,
            commands::vocabulary::add_vocabulary,
            commands::vocabulary::update_review,
            commands::vocabulary::remove_vocabulary,
            // Tags
            commands::tags::get_all_tags,
            commands::tags::upsert_tag,
            commands::tags::add_document_tag,
            commands::tags::remove_document_tag,
            commands::tags::get_document_tags,
            commands::tags::search_documents_by_tags,
            // OCR
            commands::ocr::get_ocr_result,
            commands::ocr::run_ocr,
            commands::ocr::delete_ocr_result,
            commands::ocr::ocr_model_status,
            // Dictionary
            commands::dictionary::lookup_word,
            commands::dictionary::list_dictionaries,
            commands::dictionary::validate_dictionary,
            commands::dictionary::add_dictionary,
            commands::dictionary::remove_dictionary,
            commands::dictionary::toggle_dictionary,
            commands::dictionary::reorder_dictionary,
            commands::dictionary::rename_dictionary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Query the database for user-added dictionaries that are enabled.
fn load_user_dictionaries(database: &Database) -> Vec<DictionaryMeta> {
    let conn = match database.conn.lock() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut stmt = match conn.prepare(
        "SELECT id, name, source_lang, target_lang, format, file_path, \
         enabled, priority, entry_count, is_builtin, created_at, updated_at \
         FROM dictionaries WHERE is_builtin = 0 AND enabled = 1 \
         ORDER BY priority ASC",
    ) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to prepare user dictionary query: {}", e);
            return Vec::new();
        }
    };

    let metas: Vec<DictionaryMeta> = stmt
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
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();

    drop(stmt);
    drop(conn);

    metas
}
