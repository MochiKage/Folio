//! Dev-only smoke test: run the OCR engine on a PNG file.
//!
//! Usage:
//!   cargo run --bin ocr_smoke -- <path/to/image.png>
//!
//! Loads the models from `resources/models` and onnxruntime.dll from
//! `resources/lib` (relative to CARGO_MANIFEST_DIR).

use std::path::{Path, PathBuf};

fn main() {
    let arg = std::env::args().nth(1).expect("usage: ocr_smoke <image.png>");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let models_dir = manifest.join("resources").join("models");
    let dll_path = manifest.join("resources").join("lib").join("onnxruntime.dll");

    let engine = app_lib::ocr_engine::OcrEngine::load(&models_dir, &dll_path)
        .expect("engine load failed");
    let png = std::fs::read(Path::new(&arg)).expect("read image failed");

    let t = std::time::Instant::now();
    let (boxes, (w, h)) = engine.recognize(&png).expect("recognize failed");
    println!("image {}x{} — {} boxes in {:?}", w, h, boxes.len(), t.elapsed());
    for b in &boxes {
        println!(
            "  [{:>5.0},{:>5.0} {:>5.0},{:>5.0}] tight [{:>5.0},{:>5.0} {:>5.0},{:>5.0}] wb={} {:.3}  {}",
            b.x0, b.y0, b.x1, b.y1, b.tx0, b.ty0, b.tx1, b.ty1, b.word_bounds.len(), b.confidence, b.text
        );
    }
}
