use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrBox {
    pub text: String,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub confidence: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrPageData {
    pub document_id: String,
    pub page: i32,
    pub text: String,
    pub confidence: f32,
    pub boxes: Vec<OcrBox>,
}

#[tauri::command]
pub fn get_ocr_result(
    db: State<Database>,
    doc_id: String,
    page: i32,
) -> Result<Option<OcrPageData>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT document_id, page, text, confidence, boxes FROM ocr_cache WHERE document_id=?1 AND page=?2")
        .map_err(|e| e.to_string())?;

    let result = stmt
        .query_row(rusqlite::params![doc_id, page], |row| {
            let boxes_json: String = row.get::<_, String>(4).unwrap_or_else(|_| "[]".to_string());
            let boxes: Vec<OcrBox> =
                serde_json::from_str(&boxes_json).unwrap_or_default();
            Ok(OcrPageData {
                document_id: row.get(0)?,
                page: row.get(1)?,
                text: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                confidence: row.get(3)?,
                boxes,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub async fn run_ocr(
    _db: State<'_, Database>,
    doc_id: String,
    page: i32,
    _image: Vec<u8>,
    _dpi: f32,
    _image_height: f32,
    _view_box: [f32; 4],
) -> Result<OcrPageData, String> {
    // Phase 1: OCR engine not yet implemented
    // In Phase 3, this will:
    // 1. Decode the PNG image
    // 2. Run PaddleOCR ONNX detection + recognition
    // 3. Convert image-pixel boxes to PDF-point space via image_to_pdf_space()
    // 4. Upsert into ocr_cache and return
    Err(format!(
        "OCR engine not initialized for document {} page {}",
        doc_id, page
    ))
}

#[tauri::command]
pub fn delete_ocr_result(
    db: State<Database>,
    doc_id: String,
    page: i32,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM ocr_cache WHERE document_id=?1 AND page=?2",
        rusqlite::params![doc_id, page],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ocr_model_status() -> Result<serde_json::Value, String> {
    // Phase 1: models not downloaded yet
    Ok(serde_json::json!({
        "det": "missing",
        "rec": "missing",
        "ready": false
    }))
}
