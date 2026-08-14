use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;
use crate::ocr_engine::{OcrBox, OcrEngine};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrPageData {
    pub document_id: String,
    pub page: i32,
    pub text: String,
    pub confidence: f32,
    pub boxes: Vec<OcrBox>,
}

/// Tauri-managed OCR state. The engine is loaded lazily on first use and
/// kept behind an Arc so the heavy inference can run in spawn_blocking
/// without blocking the UI thread.
pub struct OcrState {
    inner: Mutex<Option<Result<Arc<OcrEngine>, String>>>,
    models_dir: PathBuf,
    dll_path: PathBuf,
}

impl OcrState {
    pub fn new(models_dir: PathBuf, dll_path: PathBuf) -> Self {
        Self {
            inner: Mutex::new(None),
            models_dir,
            dll_path,
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// Return a reference-counted engine, loading it on first use.
    /// If a previous load failed but the model files exist now (e.g. the
    /// user ran download.ps1 while the app was open), retry the load.
    fn engine(&self) -> Result<Arc<OcrEngine>, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        let models_present = self.models_dir.join("ch_PP-OCRv4_det_infer.onnx").exists()
            && self.models_dir.join("ch_PP-OCRv4_rec_infer.onnx").exists();

        let need_load = match guard.as_ref() {
            None => true,
            Some(Err(_)) => models_present,
            Some(Ok(_)) => false,
        };
        if need_load {
            *guard = Some(OcrEngine::load(&self.models_dir, &self.dll_path).map(Arc::new));
        }
        match guard.as_ref().unwrap() {
            Ok(engine) => Ok(Arc::clone(engine)),
            Err(e) => Err(e.clone()),
        }
    }
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

/// Run PaddleOCR on a PNG render of one page (300 DPI, rendered at rotation 0).
///
/// The frontend passes the raw PNG bytes plus the render parameters needed to
/// map image-pixel coordinates back to PDF space:
///   - `dpi` / `image_height`: render scale info (image width is derived from
///     the decoded PNG itself)
///   - `view_box`: the page's PDF viewBox [x0, y0, x1, y1] at rotation 0
#[tauri::command]
pub async fn run_ocr(
    db: State<'_, Database>,
    state: State<'_, Arc<OcrState>>,
    doc_id: String,
    page: i32,
    image: Vec<u8>,
    dpi: f32,
    image_height: f32,
    view_box: [f32; 4],
) -> Result<OcrPageData, String> {
    let db = db.inner().clone();
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        run_ocr_blocking(&db, &state, &doc_id, page, &image, dpi, image_height, view_box)
    })
    .await
    .map_err(|e| format!("OCR task panicked: {}", e))?
}

fn run_ocr_blocking(
    db: &Database,
    state: &OcrState,
    doc_id: &str,
    page: i32,
    image: &[u8],
    _dpi: f32,
    _image_height: f32,
    view_box: [f32; 4],
) -> Result<OcrPageData, String> {
    let engine = state.engine()?;
    let (boxes, (img_w, img_h)) = engine.recognize(image)?;

    // Map image-pixel boxes (y-down) to PDF space (y-up) via the viewBox.
    // The render used rotation 0 and scale = dpi/72, so the mapping is a
    // proportional fit: x_pdf = x0 + px*(x1-x0)/W, y_pdf = y1 - py*(y1-y0)/H.
    let pdf_boxes: Vec<OcrBox> = boxes
        .iter()
        .map(|b| {
            let x0 = view_box[0] + b.x0 * (view_box[2] - view_box[0]) / img_w as f32;
            let x1 = view_box[0] + b.x1 * (view_box[2] - view_box[0]) / img_w as f32;
            let y_top = view_box[3] - b.y0 * (view_box[3] - view_box[1]) / img_h as f32;
            let y_bottom = view_box[3] - b.y1 * (view_box[3] - view_box[1]) / img_h as f32;
            let tx0 = view_box[0] + b.tx0 * (view_box[2] - view_box[0]) / img_w as f32;
            let tx1 = view_box[0] + b.tx1 * (view_box[2] - view_box[0]) / img_w as f32;
            let ty_top = view_box[3] - b.ty0 * (view_box[3] - view_box[1]) / img_h as f32;
            let ty_bottom = view_box[3] - b.ty1 * (view_box[3] - view_box[1]) / img_h as f32;
            OcrBox {
                text: b.text.clone(),
                x0,
                y0: y_bottom,
                x1,
                y1: y_top,
                confidence: b.confidence,
                tx0,
                ty0: ty_bottom,
                tx1,
                ty1: ty_top,
                chars: b.chars.clone(),
                word_bounds: b.word_bounds.clone(),
                v: b.v,
            }
        })
        .collect();

    let text = pdf_boxes
        .iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let confidence = if pdf_boxes.is_empty() {
        0.0
    } else {
        pdf_boxes.iter().map(|b| b.confidence).sum::<f32>() / pdf_boxes.len() as f32
    };

    // Persist to ocr_cache (upsert)
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let boxes_json = serde_json::to_string(&pdf_boxes).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO ocr_cache (document_id, page, text, confidence, boxes, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now')) \
         ON CONFLICT(document_id, page) DO UPDATE SET \
         text=excluded.text, confidence=excluded.confidence, boxes=excluded.boxes, \
         created_at=datetime('now')",
        rusqlite::params![doc_id, page, text, confidence, boxes_json],
    )
    .map_err(|e| format!("ocr_cache upsert failed: {}", e))?;

    Ok(OcrPageData {
        document_id: doc_id.to_string(),
        page,
        text,
        confidence,
        boxes: pdf_boxes,
    })
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

/// Report OCR model availability. `ready` = engine loaded successfully.
#[tauri::command]
pub fn ocr_model_status(state: State<'_, Arc<OcrState>>) -> serde_json::Value {
    let det = state
        .models_dir()
        .join("ch_PP-OCRv4_det_infer.onnx")
        .exists();
    let rec = state
        .models_dir()
        .join("ch_PP-OCRv4_rec_infer.onnx")
        .exists();
    let ready = state.engine().is_ok();
    serde_json::json!({
        "det": if det { "ready" } else { "missing" },
        "rec": if rec { "ready" } else { "missing" },
        "ready": ready,
    })
}
