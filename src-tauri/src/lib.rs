mod commands;
mod db;

use db::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Initialize database in app data directory
            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let database = Database::new(app_dir)
                .expect("Failed to initialize database");
            app.manage(database);

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
