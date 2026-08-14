//! PaddleOCR PP-OCRv4 inference engine (ONNX Runtime).
//!
//! Implements text detection + recognition following the RapidOCR 3.4.5
//! reference implementation, whose bundled ONNX models we ship:
//!   - det: DB (Differentiable Binarization) text detection, MobileNetV3
//!   - rec: SVTR text recognition with CTC decoding
//!
//! Verified model specs (see DEVLOG):
//!   - det in [?,3,?,?] → sigmoid prob map at FULL input resolution [?,1,?,?]
//!   - rec in [?,3,48,?] → softmax [?, T, 6625]
//!     class layout: 0=blank, 1..=6623 = ppocr_keys_v1.txt chars,
//!                   6624 = space (RapidOCR convention)
//!
//! Pipeline parameters (RapidOCR ch_PP-OCRv4 config):
//!   det: limit_side_len=960 (max), mean=std=0.5, thresh=0.3,
//!        box_thresh=0.5, unclip_ratio=1.6, dilation on, score_mode=fast
//!   rec: img [3,48,320] dynamic width, mean=std=0.5, batch=6

use image::{imageops, imageops::FilterType, Rgb, RgbImage};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

/// A recognized text box in image-pixel coordinates (y-down).
///
/// `x0..y1` is the *padded* box (after unclip) — generous margins, used for
/// cropping the recognition input. `tx0..ty1` is the *tight* bounding box of
/// the detected text pixels — used by the frontend to position the rendered
/// text layer spans precisely on top of the page glyphs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBox {
    pub text: String,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub confidence: f32,
    #[serde(default)]
    pub tx0: f32,
    #[serde(default)]
    pub ty0: f32,
    #[serde(default)]
    pub tx1: f32,
    #[serde(default)]
    pub ty1: f32,
    /// Per-character CTC emission fractions (0..1, aligned with `text`).
    /// Char k of `text` reached its probability PEAK at timestep
    /// chars[k]×T. The frontend takes midpoints between adjacent peaks as
    /// character boundaries — statistically the most stable alignment
    /// available from the model (validated: word boundaries ±10px @ 300 DPI).
    #[serde(default)]
    pub chars: Vec<f32>,
    /// Per-word horizontal spans as fractions (0..1) of the tight box
    /// width, aligned with the whitespace-separated words of `text`.
    /// Extracted from the SOURCE image's column profile inside the tight
    /// box: word gaps are the wide zero-ink runs, so boundaries come from
    /// pixel evidence instead of CTC timing (which drifts on
    /// variable-width glyphs). Empty when the gaps are ambiguous — the
    /// frontend falls back to `chars` (CTC peak midpoints).
    #[serde(default)]
    pub word_bounds: Vec<[f32; 2]>,
    /// Cache format version — bumped when the box fields change meaning.
    #[serde(default)]
    pub v: i32,
}

// ─── Detection constants ─────────────────────────

const DET_LIMIT_SIDE_LEN: f32 = 960.0; // resize so the max side ≤ 960 (32-multiple)
const DET_THRESH: f32 = 0.3; // binarization threshold on the prob map
const DET_BOX_THRESH: f32 = 0.5; // minimum mean score inside a box
const DET_UNCLIP_RATIO: f32 = 1.6; // box expansion: d = ratio * area / perimeter
const DET_MAX_CANDIDATES: usize = 1000;
const DET_MIN_SIZE: f32 = 3.0; // min side before unclip
const DET_MIN_SIZE_UNCLIPPED: f32 = 5.0; // min side after unclip

// ─── Recognition constants ───────────────────────

const REC_IMG_H: u32 = 48;
const REC_IMG_W: u32 = 320;
const REC_BATCH_NUM: usize = 6;

// ─── Engine ──────────────────────────────────────

pub struct OcrEngine {
    /// ort's Session::run takes &mut self, so guard with a Mutex
    /// (Session: Send + Sync — safe to share behind Arc).
    det_session: Mutex<Session>,
    rec_session: Mutex<Session>,
    det_input_name: String,
    det_output_name: String,
    rec_input_name: String,
    rec_output_name: String,
    /// Character table from ppocr_keys_v1.txt. Class layout:
    /// 0 = blank, 1..=keys.len() = chars, keys.len()+1 = space.
    keys: Vec<String>,
}

static ORT_INIT: Mutex<bool> = Mutex::new(false);

/// Load the onnxruntime DLL once per process (ort::init_from is global).
fn ensure_ort_init(dll_path: &Path) -> Result<(), String> {
    let mut done = ORT_INIT.lock().map_err(|e| e.to_string())?;
    if *done {
        return Ok(());
    }
    let builder = ort::init_from(dll_path)
        .map_err(|e| format!("onnxruntime init failed ({:?}): {}", dll_path, e))?;
    builder.commit(); // false = environment already committed elsewhere — fine
    *done = true;
    Ok(())
}

impl OcrEngine {
    /// Load ONNX sessions and the character table.
    /// `dll_path` is the onnxruntime.dll location; `models_dir` holds the
    /// det/rec .onnx files and ppocr_keys_v1.txt.
    pub fn load(models_dir: &Path, dll_path: &Path) -> Result<Self, String> {
        ensure_ort_init(dll_path)?;

        let det_path = models_dir.join("ch_PP-OCRv4_det_infer.onnx");
        let rec_path = models_dir.join("ch_PP-OCRv4_rec_infer.onnx");
        if !det_path.exists() {
            return Err(format!("det model not found: {:?}", det_path));
        }
        if !rec_path.exists() {
            return Err(format!("rec model not found: {:?}", rec_path));
        }

        let det_session = Session::builder()
            .map_err(|e| e.to_string())?
            .commit_from_file(&det_path)
            .map_err(|e| format!("failed to load det model: {}", e))?;
        let rec_session = Session::builder()
            .map_err(|e| e.to_string())?
            .commit_from_file(&rec_path)
            .map_err(|e| format!("failed to load rec model: {}", e))?;

        let det_input_name = det_session.inputs()[0].name().to_string();
        let det_output_name = det_session.outputs()[0].name().to_string();
        let rec_input_name = rec_session.inputs()[0].name().to_string();
        let rec_output_name = rec_session.outputs()[0].name().to_string();

        // Load the character table. Keep spaces — lines are stripped of
        // \n / \r\n only, like the reference implementation.
        let keys_path = models_dir.join("ppocr_keys_v1.txt");
        let raw = std::fs::read_to_string(&keys_path)
            .map_err(|e| format!("failed to read {:?}: {}", keys_path, e))?;
        let mut keys: Vec<String> = raw
            .split('\n')
            .map(|l| l.trim_end_matches('\r'))
            .map(|l| l.to_string())
            .collect();
        if keys.last().is_some_and(|l| l.is_empty()) {
            keys.pop(); // trailing newline artifact
        }
        if keys.is_empty() {
            return Err("ppocr_keys_v1.txt is empty".into());
        }

        log::info!(
            "[OCR] engine loaded: det={} rec={} keys={}",
            det_input_name,
            rec_input_name,
            keys.len()
        );

        Ok(Self {
            det_session: Mutex::new(det_session),
            rec_session: Mutex::new(rec_session),
            det_input_name,
            det_output_name,
            rec_input_name,
            rec_output_name,
            keys,
        })
    }

    /// Run the full OCR pipeline on a PNG image (smoke-test/dev tool).
    /// The app itself calls `recognize_rgb` — raw pixels skip the PNG
    /// encode/decode round trip, which costs ~2s/page in debug builds.
    pub fn recognize(&self, png: &[u8]) -> Result<(Vec<OcrBox>, (u32, u32)), String> {
        let src = image::load_from_memory(png)
            .map_err(|e| format!("PNG decode failed: {}", e))?
            .to_rgb8();
        let (src_w, src_h) = src.dimensions();
        self.recognize_image(&src, src_w, src_h)
    }

    /// Run the full OCR pipeline on raw RGB pixels (width*height*3 bytes,
    /// row-major). The frontend transfers the 300-DPI canvas straight from
    /// getImageData instead of PNG-encoding it.
    pub fn recognize_rgb(
        &self,
        rgb: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(Vec<OcrBox>, (u32, u32)), String> {
        let expected = (width * height * 3) as usize;
        if rgb.len() != expected {
            return Err(format!(
                "raw RGB size mismatch: {} bytes for {}x{} (expected {})",
                rgb.len(),
                width,
                height,
                expected
            ));
        }
        let src = RgbImage::from_raw(width, height, rgb.to_vec())
            .ok_or_else(|| format!("invalid image dimensions {}x{}", width, height))?;
        self.recognize_image(&src, width, height)
    }

    /// Shared pipeline body: detection + recognition on an RGB image.
    /// Returns (boxes in image-pixel coordinates y-down, in reading order,
    /// and the image dimensions for pixel→PDF mapping).
    fn recognize_image(
        &self,
        src: &RgbImage,
        src_w: u32,
        src_h: u32,
    ) -> Result<(Vec<OcrBox>, (u32, u32)), String> {
        let t0 = Instant::now();

        // ── Detection ──
        let (det_input, rw, rh) = det_preprocess(src);
        let t1 = Instant::now();

        let det_tensor = Tensor::from_array((vec![1i64, 3, rh as i64, rw as i64], det_input))
            .map_err(|e| format!("det tensor build failed: {}", e))?;
        let (pred, t2) = {
            let mut det = self.det_session.lock().map_err(|e| e.to_string())?;
            let det_out = det
                .run(ort::inputs![self.det_input_name.as_str() => det_tensor])
                .map_err(|e| format!("det inference failed: {}", e))?;
            let (_, pred): (_, &[f32]) = det_out[self.det_output_name.as_str()]
                .try_extract_tensor()
                .map_err(|e| format!("det output extract failed: {}", e))?;
            (pred.to_vec(), Instant::now())
        };

        // The det model outputs the probability map at FULL input resolution
        // (verified: 640×640 in → 640×640 out).
        let (ph, pw) = (rh, rw);
        if pred.len() != ph * pw {
            return Err(format!(
                "det output shape mismatch: {} elements, expected {}",
                pred.len(),
                ph * pw
            ));
        }
        let quads = db_postprocess(&pred, ph, pw, src_w as usize, src_h as usize);
        let t3 = Instant::now();

        // ── Recognition ──
        let mut boxes: Vec<OcrBox> = Vec::with_capacity(quads.len());
        for batch in quads.chunks(REC_BATCH_NUM) {
            let crops: Vec<RgbImage> = batch
                .iter()
                .map(|(q, _, _)| rotate_crop(src, &q.corners))
                .collect();
            let (logits, timesteps, batch_size) = self.rec_infer_batch(&crops)?;
            let classes = logits.len() / (timesteps * batch_size);
            if logits.len() != timesteps * batch_size * classes {
                return Err(format!(
                    "rec output shape mismatch: {} floats for {}x{}x{}",
                    logits.len(),
                    batch_size,
                    timesteps,
                    classes
                ));
            }
            for (i, (quad, tight, line_h)) in batch.iter().enumerate() {
                let start = i * timesteps * classes;
                let (text, conf, emissions) =
                    ctc_decode(&logits[start..start + timesteps * classes], classes, &self.keys);
                let chars: Vec<f32> = emissions
                    .iter()
                    .map(|t| *t as f32 / timesteps as f32)
                    .collect();
                // Word placement from pixel evidence: split the source
                // image's column profile at the wide zero-ink runs. The
                // CTC text only supplies the word count — the boundaries
                // themselves are real inter-word gaps in the pixels.
                let word_count = text.split(' ').filter(|s| !s.is_empty()).count();
                let horizontal = tight[2] - tight[0] > tight[3] - tight[1];
                // Skew guard: a tilted line inflates the axis-aligned
                // tight height (1.5° → ~2.2×); the expanded sample band
                // would then catch neighboring lines' ink and corrupt the
                // gaps. Skip pixel extraction — CTC fallback is safer.
                let skewed = tight[3] - tight[1] > 1.4 * line_h;
                let profile: Vec<u32> = if horizontal && !skewed {
                    source_word_profile(src, *tight, 0.35 * line_h)
                } else {
                    Vec::new()
                };
                let word_bounds: Vec<[f32; 2]> = word_segments(&profile, word_count)
                    .map(|segs| segs.into_iter().map(|(a, b)| [a, b]).collect())
                    .unwrap_or_default();
                let x0 = quad.corners.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
                let y0 = quad.corners.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
                let x1 = quad.corners.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max);
                let y1 = quad.corners.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max);
                boxes.push(OcrBox {
                    text,
                    x0,
                    y0,
                    x1,
                    y1,
                    confidence: conf,
                    tx0: tight[0],
                    ty0: tight[1],
                    tx1: tight[2],
                    ty1: tight[3],
                    chars,
                    word_bounds,
                    v: 2,
                });
            }
        }
        let t4 = Instant::now();

        log::info!(
            "[OCR] page {:?}x{}: det={} boxes, prep {:?}, det {:?}, post {:?}, rec {:?}",
            src_w,
            src_h,
            boxes.len(),
            t1 - t0,
            t2 - t1,
            t3 - t2,
            t4 - t3
        );
        Ok((boxes, (src_w, src_h)))
    }

    /// Run recognition on a batch of crops (already 48px-tall horizontal
    /// strips). Returns the flat logits of shape [B, T, classes].
    fn rec_infer_batch(&self, crops: &[RgbImage]) -> Result<(Vec<f32>, usize, usize), String> {
        // Batch width: max(320, 48 * max aspect ratio), like the reference.
        let mut max_wh = REC_IMG_W as f32 / REC_IMG_H as f32;
        let ratios: Vec<f32> = crops
            .iter()
            .map(|c| c.width() as f32 / c.height().max(1) as f32)
            .collect();
        for r in &ratios {
            max_wh = max_wh.max(*r);
        }
        // Round UP to a multiple of 8: the model outputs exactly W/8 time
        // steps (ceil semantics), so a non-multiple width would misalign
        // the CTC logits. (Trailing zero padding is invisible to the model.)
        let img_w_raw = ((REC_IMG_H as f32 * max_wh).round() as u32).max(REC_IMG_W);
        let img_w = (img_w_raw + 7) / 8 * 8;

        let b = crops.len();
        let mut buf: Vec<f32> = vec![0.0; b * 3 * REC_IMG_H as usize * img_w as usize];
        for (i, crop) in crops.iter().enumerate() {
            let resized_w = ((REC_IMG_H as f32 * ratios[i]).ceil() as u32)
                .min(img_w)
                .max(1);
            let resized = imageops::resize(crop, resized_w, REC_IMG_H, FilterType::Triangle);
            for c in 0..3 {
                for y in 0..REC_IMG_H {
                    for x in 0..resized_w {
                        let px = resized.get_pixel(x, y)[c] as f32;
                        // normalize: (x/255 - 0.5) / 0.5
                        buf[((i * 3 + c as usize) * REC_IMG_H as usize + y as usize)
                            * img_w as usize
                            + x as usize] = (px / 255.0 - 0.5) / 0.5;
                    }
                }
            }
        }

        let tensor = Tensor::from_array((
            vec![b as i64, 3, REC_IMG_H as i64, img_w as i64],
            buf,
        ))
        .map_err(|e| format!("rec tensor build failed: {}", e))?;
        let mut rec = self.rec_session.lock().map_err(|e| e.to_string())?;
        let out = rec
            .run(ort::inputs![self.rec_input_name.as_str() => tensor])
            .map_err(|e| format!("rec inference failed: {}", e))?;
        let (_, logits): (_, &[f32]) = out[self.rec_output_name.as_str()]
            .try_extract_tensor()
            .map_err(|e| format!("rec output extract failed: {}", e))?;

        // logits: [B, T, classes]; T = width / 8 (verified: 320 → 40)
        let timesteps = img_w as usize / 8;
        Ok((logits.to_vec(), timesteps, b))
    }
}

// ─── Detection preprocessing ─────────────────────

/// Resize (max side 960, 32-multiple) + normalize (x/255-0.5)/0.5 → CHW.
/// Returns (chw_buffer, resized_w, resized_h).
fn det_preprocess(src: &RgbImage) -> (Vec<f32>, usize, usize) {
    let (w, h) = src.dimensions();
    let max_side = w.max(h) as f32;
    let ratio = if max_side > DET_LIMIT_SIDE_LEN {
        DET_LIMIT_SIDE_LEN / max_side
    } else {
        1.0
    };
    let mut rw = ((w as f32 * ratio) / 32.0).round() as u32 * 32;
    let mut rh = ((h as f32 * ratio) / 32.0).round() as u32 * 32;
    rw = rw.max(32);
    rh = rh.max(32);

    let resized = imageops::resize(src, rw, rh, FilterType::Triangle);

    // Planar CHW layout (matches the ONNX NCHW input shape):
    // buf[c * rh * rw + y * rw + x] — NOT interleaved per-pixel.
    let mut buf = vec![0f32; (rw * rh * 3) as usize];
    let plane = (rw * rh) as usize;
    for (x, y, px) in resized.enumerate_pixels() {
        let p = (y * rw + x) as usize;
        for c in 0..3 {
            buf[c * plane + p] = (px[c] as f32 / 255.0 - 0.5) / 0.5;
        }
    }

    (buf, rw as usize, rh as usize)
}

// ─── Detection postprocessing (DB) ───────────────

/// An oriented text box: 4 corners ordered tl, tr, br, bl.
#[derive(Debug, Clone, Copy)]
struct Quad {
    corners: [(f32, f32); 4],
}

/// DB postprocessing, mirroring RapidOCR's DBPostProcess.
/// `pred` is the probability map at the resized-input resolution
/// (verified: the det model outputs at full input resolution).
///
/// Returns (quad, tight_bbox, line_height) triples in original-image
/// pixel coordinates (y-down). The quad is the unclipped (padded) box used
/// for recognition cropping; the tight bbox is the extent of the detected
/// text pixels; line_height is the pre-unclip PCA height (the line's ink
/// height regardless of skew) — used to size the word-gap profile band
/// and to detect skewed lines.
fn db_postprocess(
    pred: &[f32],
    ph: usize,
    pw: usize,
    src_w: usize,
    src_h: usize,
) -> Vec<(Quad, [f32; 4], f32)> {
    // 1. Binarize + dilate (2x2 kernel ≈ 1px growth, closes tiny gaps)
    let mut mask = vec![0u8; ph * pw];
    for (i, v) in pred.iter().enumerate() {
        if *v > DET_THRESH {
            mask[i] = 1;
        }
    }
    let mask = dilate(&mask, ph, pw);

    // 2. Connected components (4-connectivity, like the reference contours)
    let mut boxes: Vec<(Quad, f32, [f32; 4], f32)> = Vec::new();
    let mut visited = vec![false; ph * pw];
    for start in 0..(ph * pw) {
        if mask[start] == 0 || visited[start] {
            continue;
        }
        if boxes.len() >= DET_MAX_CANDIDATES {
            break;
        }

        // BFS flood fill, tracking the tight pixel extent of the component
        let mut comp: Vec<(usize, usize)> = Vec::new();
        let mut min_x = usize::MAX;
        let mut max_x = 0usize;
        let mut min_y = usize::MAX;
        let mut max_y = 0usize;
        let mut stack = vec![start];
        visited[start] = true;
        while let Some(i) = stack.pop() {
            let (x, y) = ((i % pw) as usize, (i / pw) as usize);
            comp.push((x, y));
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
            for opt in neighbors4(x, y, pw, ph) {
                if let Some((nx, ny)) = opt {
                    let ni = ny * pw + nx;
                    if mask[ni] == 1 && !visited[ni] {
                        visited[ni] = true;
                        stack.push(ni);
                    }
                }
            }
        }
        if let Some(quad) = component_to_quad(&comp) {
            // min side ≥ 3 before unclip
            if quad.min_side() < DET_MIN_SIZE {
                continue;
            }
            // Ink height, skew-independent. The PCA quad lives in map
            // space — scale to source pixels for downstream use.
            let quad_h = quad.height() * src_h as f32 / ph as f32;
            // fast score: mean prob inside the rect
            let score = box_score_fast(pred, pw, ph, &quad);
            if score < DET_BOX_THRESH {
                continue;
            }
            // unclip: expand rect by d = ratio * area / perimeter
            let expanded = quad.unclip(DET_UNCLIP_RATIO);
            if expanded.min_side() < DET_MIN_SIZE_UNCLIPPED {
                continue;
            }
            // map from map space to original image space
            let corners = expanded
                .corners
                .map(|(x, y)| {
                    (
                        (x / pw as f32 * src_w as f32).clamp(0.0, src_w as f32 - 1.0),
                        (y / ph as f32 * src_h as f32).clamp(0.0, src_h as f32 - 1.0),
                    )
                });
            let quad = Quad { corners };
            // filter_det_res: drop boxes ≤ 3px on either side after clipping
            if quad.width() <= 3.0 || quad.height() <= 3.0 {
                continue;
            }
            // Tight pixel extent (pre-unclip) mapped to original image space
            let tight = [
                (min_x as f32 / pw as f32 * src_w as f32).clamp(0.0, src_w as f32 - 1.0),
                (min_y as f32 / ph as f32 * src_h as f32).clamp(0.0, src_h as f32 - 1.0),
                ((max_x + 1) as f32 / pw as f32 * src_w as f32).clamp(0.0, src_w as f32 - 1.0),
                ((max_y + 1) as f32 / ph as f32 * src_h as f32).clamp(0.0, src_h as f32 - 1.0),
            ];
            boxes.push((quad, score, tight, quad_h));
        }
    }

    // 3. Reading-order sort (PaddleOCR sorted_boxes: rows by tl.y, then tl.x,
    //    with a height-adaptive tolerance for x reordering within a row)
    let median_h = median(
        &mut boxes
            .iter()
            .map(|(q, _, _, _)| q.height())
            .collect::<Vec<f32>>(),
    );
    let tol = median_h.max(10.0) * 0.5;
    boxes.sort_by(|a, b| {
        let (ay, ax) = (a.0.corners[0].1, a.0.corners[0].0);
        let (by, bx) = (b.0.corners[0].1, b.0.corners[0].0);
        ay.partial_cmp(&by)
            .unwrap()
            .then(ax.partial_cmp(&bx).unwrap())
    });
    // bubble within rows (same as the reference sorted_boxes)
    for i in 0..boxes.len().saturating_sub(1) {
        let mut j = i as isize;
        while j >= 0 {
            let (a, b) = (boxes[j as usize].0, boxes[(j + 1) as usize].0);
            let y_diff = (a.corners[0].1 - b.corners[0].1).abs();
            if y_diff < tol && b.corners[0].0 < a.corners[0].0 {
                boxes.swap(j as usize, (j + 1) as usize);
                j -= 1;
            } else {
                break;
            }
        }
    }

    boxes
        .into_iter()
        .map(|(q, _, tight, h)| (q, tight, h))
        .collect()
}

fn neighbors4(x: usize, y: usize, w: usize, h: usize) -> [Option<(usize, usize)>; 4] {
    [
        x.checked_sub(1).map(|nx| (nx, y)),
        (x + 1 < w).then_some((x + 1, y)),
        y.checked_sub(1).map(|ny| (x, ny)),
        (y + 1 < h).then_some((x, y + 1)),
    ]
}

/// Morphological dilation with a 2x2 kernel (≈ 1px growth all directions).
fn dilate(mask: &[u8], ph: usize, pw: usize) -> Vec<u8> {
    let mut out = mask.to_vec();
    for y in 0..ph {
        for x in 0..pw {
            let i = y * pw + x;
            if mask[i] == 1 {
                continue;
            }
            // any set 4-neighbor → set this pixel
            // (checked_sub: then_some evaluates eagerly, x-1 underflows at x=0)
            let set = [
                x.checked_sub(1).map(|nx| (nx, y)),
                (x + 1 < pw).then_some((x + 1, y)),
                y.checked_sub(1).map(|ny| (x, ny)),
                (y + 1 < ph).then_some((x, y + 1)),
            ]
            .into_iter()
            .flatten()
            .any(|(nx, ny)| mask[ny * pw + nx] == 1);
            if set {
                out[i] = 1;
            }
        }
    }
    out
}

/// Fit a minimum-area (PCA-based) oriented rectangle to a component.
fn component_to_quad(comp: &[(usize, usize)]) -> Option<Quad> {
    let n = comp.len();
    if n < 2 {
        return None;
    }
    let cx = comp.iter().map(|p| p.0 as f32).sum::<f32>() / n as f32;
    let cy = comp.iter().map(|p| p.1 as f32).sum::<f32>() / n as f32;

    let mut sxx = 0f32;
    let mut sxy = 0f32;
    let mut syy = 0f32;
    for &(x, y) in comp {
        let dx = x as f32 - cx;
        let dy = y as f32 - cy;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }

    // Largest eigenvector of [[sxx, sxy], [sxy, syy]]
    let (ux, uy) = if sxy.abs() < 1e-9 && (sxx - syy).abs() < 1e-9 {
        (1.0f32, 0.0f32) // degenerate blob → horizontal
    } else {
        let trace = sxx + syy;
        let det = sxx * syy - sxy * sxy;
        let disc = ((trace * trace) / 4.0 - det).max(0.0).sqrt();
        let lambda = trace / 2.0 + disc; // largest eigenvalue
        // eigenvector for lambda: (lambda - syy, sxy)
        let (ex, ey) = (lambda - syy, sxy);
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-9 {
            (1.0f32, 0.0f32)
        } else {
            (ex / len, ey / len)
        }
    };
    let (vx, vy) = (-uy, ux);

    // Project onto the two axes → w along u, h along v
    let mut min_a = f32::INFINITY;
    let mut max_a = f32::NEG_INFINITY;
    let mut min_b = f32::INFINITY;
    let mut max_b = f32::NEG_INFINITY;
    for &(x, y) in comp {
        let dx = x as f32 - cx;
        let dy = y as f32 - cy;
        let a = dx * ux + dy * uy;
        let b = dx * vx + dy * vy;
        min_a = min_a.min(a);
        max_a = max_a.max(a);
        min_b = min_b.min(b);
        max_b = max_b.max(b);
    }
    let w = max_a - min_a;
    let h = max_b - min_b;
    if w < 1.0 || h < 1.0 {
        return None;
    }

    let corners = [
        (cx + ux * max_a + vx * max_b, cy + uy * max_a + vy * max_b),
        (cx + ux * max_a + vx * min_b, cy + uy * max_a + vy * min_b),
        (cx + ux * min_a + vx * min_b, cy + uy * min_a + vy * min_b),
        (cx + ux * min_a + vx * max_b, cy + uy * min_a + vy * max_b),
    ];
    Some(Quad {
        corners: order_corners(corners),
    })
}

/// Order 4 rect corners as tl, tr, br, bl (like the reference get_mini_boxes).
fn order_corners(mut pts: [(f32, f32); 4]) -> [(f32, f32); 4] {
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let (mut l0, mut l1) = (pts[0], pts[1]); // left pair, l0 = top
    let (mut r0, mut r1) = (pts[2], pts[3]); // right pair, r0 = top
    if l0.1 > l1.1 {
        std::mem::swap(&mut l0, &mut l1);
    }
    if r0.1 > r1.1 {
        std::mem::swap(&mut r0, &mut r1);
    }
    [l0, r0, r1, l1]
}

/// Mean probability inside the rect (fast score mode).
fn box_score_fast(pred: &[f32], pw: usize, ph: usize, quad: &Quad) -> f32 {
    let (x0, x1, y0, y1) = quad.bbox();
    let (cx, cy) = quad.center();
    let (u, v) = quad.axes();
    let (hw, hh) = (quad.width() / 2.0, quad.height() / 2.0);

    let mut sum = 0f32;
    let mut count = 0usize;
    for y in (y0 as usize)..=((y1 as usize).min(ph - 1)) {
        for x in (x0 as usize)..=((x1 as usize).min(pw - 1)) {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let a = dx * u.0 + dy * u.1;
            let b = dx * v.0 + dy * v.1;
            if a.abs() <= hw + 0.5 && b.abs() <= hh + 0.5 {
                sum += pred[y * pw + x];
                count += 1;
            }
        }
    }
    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
}

fn median(vals: &mut [f32]) -> f32 {
    if vals.is_empty() {
        return 0.0;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    vals[vals.len() / 2]
}

/// Column profile of dark pixels inside `tight` (source-image pixels):
/// count of dark pixels per column. Computed on the SOURCE image, not
/// the detection map — the det map is downscaled ~2.5× and dilated, at
/// which scale inter-word gaps (2-3 columns) get closed entirely.
///
/// The sampled rows are expanded `expand` px above/below the tight box:
/// the det mask systematically misses thin top/bottom strokes (crossbars,
/// ascenders, descenders), so the tight box truncates them. Without the
/// expansion those columns read as fake word gaps (e.g. the "Th" ligature
/// area shows a 14px gap inside the word). `expand` is sized from the
/// line's ink height (skew-independent), NOT the tight height — a skewed
/// line inflates the axis-aligned tight box and would over-expand into
/// neighboring lines.
fn source_word_profile(src: &RgbImage, tight: [f32; 4], expand: f32) -> Vec<u32> {
    let (iw, ih) = src.dimensions();
    let x0 = tight[0].round() as u32;
    let x1 = (tight[2].round() as u32).min(iw.saturating_sub(1));
    let y0 = ((tight[1] - expand).round() as i64).clamp(0, ih as i64 - 1) as u32;
    let y1 = ((tight[3] + expand).round() as i64).clamp(0, ih as i64 - 1) as u32;
    if x1 < x0 || y1 < y0 {
        return Vec::new();
    }
    let mut profile = vec![0u32; (x1 - x0 + 1) as usize];
    for y in y0..=y1 {
        for x in x0..=x1 {
            let px = src.get_pixel(x, y);
            // Luminance threshold: strokes are < 160, page background is
            // white. Generous enough to keep antialiased thin strokes.
            let lum = 0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32;
            if lum < 160.0 {
                profile[(x - x0) as usize] += 1;
            }
        }
    }
    // Noise suppression: scan speckles are 1-2 isolated dark pixels, real
    // strokes occupy ≥3 rows of the sampled band (even "i" dots and
    // periods). Zeroing sparse columns keeps word gaps intact on noisy
    // scans — verified: a 13-word line on a speckled scan rejected the
    // gap split at count≥1 (8px fake splits) but accepted at count≥3.
    for p in profile.iter_mut() {
        if *p < 3 {
            *p = 0;
        }
    }
    profile
}

/// Split a line's column ink profile into word segments.
///
/// Word gaps are zero-ink column runs (inter-word spaces are
/// systematically wider than inter-letter gaps). The `word_count - 1`
/// widest runs are taken as word gaps. Accepted only when the smallest
/// chosen gap is clearly wider than the largest unchosen run (≥1.5×,
/// min 2 columns) — otherwise the gap structure is ambiguous and None
/// is returned.
///
/// Returns word segments as (start, end) column fractions of the tight
/// box width, aligned with the whitespace-separated words of the CTC
/// text (which supplies `word_count`; the boundaries themselves are pure
/// pixel evidence).
fn word_segments(profile: &[u32], word_count: usize) -> Option<Vec<(f32, f32)>> {
    let n = profile.len();
    if n == 0 {
        return None;
    }
    if word_count <= 1 {
        // Single word: the tight box IS the word's ink extent.
        return Some(vec![(0.0, 1.0)]);
    }

    // Zero-column runs. All runs are interior: the tight extent starts
    // and ends on ink by construction.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < n {
        if profile[i] == 0 {
            let start = i;
            while i < n && profile[i] == 0 {
                i += 1;
            }
            runs.push((start, i - 1));
        } else {
            i += 1;
        }
    }

    let k = word_count - 1; // number of word gaps
    if runs.len() < k {
        return None;
    }
    // The k widest runs are the word gaps.
    let mut sorted = runs.clone();
    sorted.sort_unstable_by_key(|&(s, e)| std::cmp::Reverse(e - s + 1));
    let chosen_w = sorted[k - 1].1 - sorted[k - 1].0 + 1;
    let unchosen_w = sorted.get(k).map(|&(s, e)| e - s + 1).unwrap_or(0);
    // Guard: the chosen/unchosen boundary must be clear (reject ties and
    // lines whose letter gaps are as wide as the word gaps).
    if chosen_w < 2 || (chosen_w as f32) < unchosen_w as f32 * 1.5 {
        return None;
    }

    // Chosen gaps in reading order → segments between them.
    let mut gaps: Vec<(usize, usize)> = sorted[..k].to_vec();
    gaps.sort_unstable_by_key(|&(s, _)| s);
    let nf = n as f32;
    let mut segs = Vec::with_capacity(word_count);
    let mut left = 0usize;
    for &(s, e) in &gaps {
        segs.push((left as f32 / nf, s as f32 / nf));
        left = e + 1;
    }
    segs.push((left as f32 / nf, 1.0));
    Some(segs)
}

impl Quad {
    /// Expand the rect on all sides by d = ratio * area / perimeter.
    fn unclip(&self, ratio: f32) -> Quad {
        let w = self.width();
        let h = self.height();
        let d = ratio * w * h / (2.0 * (w + h));
        if d <= 0.0 {
            return *self;
        }
        // Shrink/grow the rect: keep center + orientation, add d to each half-extent.
        let (cx, cy) = self.center();
        let (u, v) = self.axes();
        let hw = w / 2.0 + d;
        let hh = h / 2.0 + d;
        let corners = [
            (cx + u.0 * hw + v.0 * hh, cy + u.1 * hw + v.1 * hh),
            (cx + u.0 * hw - v.0 * hh, cy + u.1 * hw - v.1 * hh),
            (cx - u.0 * hw - v.0 * hh, cy - u.1 * hw - v.1 * hh),
            (cx - u.0 * hw + v.0 * hh, cy - u.1 * hw + v.1 * hh),
        ];
        Quad {
            corners: order_corners(corners),
        }
    }

    fn center(&self) -> (f32, f32) {
        (
            self.corners.iter().map(|p| p.0).sum::<f32>() / 4.0,
            self.corners.iter().map(|p| p.1).sum::<f32>() / 4.0,
        )
    }

    /// Unit axes: u along tl→tr, v along tl→bl.
    fn axes(&self) -> ((f32, f32), (f32, f32)) {
        let [tl, tr, _, bl] = self.corners;
        let ex = (tr.0 - tl.0, tr.1 - tl.1);
        let ey = (bl.0 - tl.0, bl.1 - tl.1);
        let ew = (ex.0 * ex.0 + ex.1 * ex.1).sqrt().max(1e-6);
        let eh = (ey.0 * ey.0 + ey.1 * ey.1).sqrt().max(1e-6);
        ((ex.0 / ew, ex.1 / ew), (ey.0 / eh, ey.1 / eh))
    }

    fn width(&self) -> f32 {
        let [tl, tr, _, _] = self.corners;
        ((tr.0 - tl.0).powi(2) + (tr.1 - tl.1).powi(2)).sqrt()
    }

    fn height(&self) -> f32 {
        let [tl, _, _, bl] = self.corners;
        ((bl.0 - tl.0).powi(2) + (bl.1 - tl.1).powi(2)).sqrt()
    }

    fn min_side(&self) -> f32 {
        self.width().min(self.height())
    }

    fn bbox(&self) -> (f32, f32, f32, f32) {
        let x0 = self.corners.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
        let y0 = self.corners.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
        let x1 = self.corners.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max);
        let y1 = self.corners.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max);
        (x0, x1, y0, y1)
    }
}

// ─── Crop + recognition helpers ──────────────────

/// Perspective-crop a (possibly rotated) quad into an axis-aligned strip.
/// Mirrors the reference get_rotate_crop_image: tl→(0,0), tr→(w,0),
/// br→(w,h), bl→(0,h); vertical crops (h/w ≥ 1.5) are rotated 90° CCW.
fn rotate_crop(img: &RgbImage, corners: &[(f32, f32); 4]) -> RgbImage {
    let [tl, tr, _, bl] = *corners;
    let (e1x, e1y) = (tr.0 - tl.0, tr.1 - tl.1);
    let (e2x, e2y) = (bl.0 - tl.0, bl.1 - tl.1);
    let w = (e1x * e1x + e1y * e1y).sqrt().max(1.0);
    let h = (e2x * e2x + e2y * e2y).sqrt().max(1.0);
    let (u1, u2) = (e1x / w, e1y / w);
    let (v1, v2) = (e2x / h, e2y / h);
    let (wi, hi) = (w.round() as u32, h.round() as u32);
    let (iw, ih) = img.dimensions();

    let mut out = RgbImage::new(wi, hi);
    for y in 0..hi {
        for x in 0..wi {
            let sx = tl.0 + u1 * x as f32 + v1 * y as f32;
            let sy = tl.1 + u2 * x as f32 + v2 * y as f32;
            out.put_pixel(x, y, bilinear_sample(img, sx, sy, iw, ih));
        }
    }

    // Vertical text → rotate 90° CCW (np.rot90 equivalent)
    if hi as f32 / wi as f32 >= 1.5 {
        let mut rot = RgbImage::new(hi, wi);
        for y_out in 0..wi {
            for x_out in 0..hi {
                rot.put_pixel(x_out, y_out, *out.get_pixel(wi - 1 - y_out, x_out));
            }
        }
        return rot;
    }
    out
}

/// Bilinear sampling with border replication (clamped coords).
fn bilinear_sample(img: &RgbImage, x: f32, y: f32, w: u32, h: u32) -> Rgb<u8> {
    let x = x.clamp(0.0, w as f32 - 1.0);
    let y = y.clamp(0.0, h as f32 - 1.0);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;

    let p00 = img.get_pixel(x0, y0);
    let p10 = img.get_pixel(x1, y0);
    let p01 = img.get_pixel(x0, y1);
    let p11 = img.get_pixel(x1, y1);

    let mut out = [0u8; 3];
    for c in 0..3 {
        let v = p00[c] as f32 * (1.0 - fx) * (1.0 - fy)
            + p10[c] as f32 * fx * (1.0 - fy)
            + p01[c] as f32 * (1.0 - fx) * fy
            + p11[c] as f32 * fx * fy;
        out[c] = v.round().clamp(0.0, 255.0) as u8;
    }
    Rgb(out)
}

// ─── CTC decoding ────────────────────────────────

/// Greedy CTC decode. Class layout: 0=blank, 1..=keys.len()=chars,
/// keys.len()+1=space. Returns (text, mean confidence, per-character
/// PEAK-emission timesteps — the timestep of each char's highest
/// probability within its emission run; one entry per char of `text`).
fn ctc_decode(
    logits: &[f32],
    classes: usize,
    keys: &[String],
) -> (String, f32, Vec<u32>) {
    let timesteps = logits.len() / classes;
    if timesteps == 0 {
        return (String::new(), 0.0, Vec::new());
    }

    let blank = 0usize;
    let space_class = keys.len() + 1;

    if classes != keys.len() + 2 {
        log::warn!(
            "[OCR] rec output classes {} != keys {} + 2 — decode may be wrong",
            classes,
            keys.len()
        );
    }

    let mut text = String::new();
    let mut confs: Vec<f32> = Vec::new();
    let mut emissions: Vec<u32> = Vec::new();
    let mut prev = usize::MAX;
    // Peak tracking for the current emission run
    let mut run_p = -1.0f32;
    let mut run_idx = 0usize;
    for t in 0..timesteps {
        let row = &logits[t * classes..(t + 1) * classes];
        let mut best = 0usize;
        let mut best_p = f32::NEG_INFINITY;
        for (i, v) in row.iter().enumerate() {
            if *v > best_p {
                best_p = *v;
                best = i;
            }
        }
        if best == blank {
            prev = blank;
            run_p = -1.0;
            continue;
        }
        if best == prev {
            // Same char continues — track its probability peak
            if best_p > run_p {
                run_p = best_p;
                emissions[run_idx] = t as u32;
            }
            continue;
        }
        prev = best;
        run_p = best_p;
        run_idx = emissions.len();
        emissions.push(t as u32);
        if best <= keys.len() {
            text.push_str(&keys[best - 1]);
        } else if best == space_class {
            text.push(' ');
        }
        confs.push(best_p);
    }
    let conf = if confs.is_empty() {
        0.0
    } else {
        confs.iter().sum::<f32>() / confs.len() as f32
    };
    (text, conf, emissions)
}

// ─── Tests ───────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_order_corners() {
        // A diamond: top (110,90), right (120,100), bottom (110,110), left (100,100)
        let pts = [(100.0, 100.0), (110.0, 90.0), (120.0, 100.0), (110.0, 110.0)];
        let [tl, tr, br, bl] = order_corners(pts);
        assert_eq!(tl, (110.0, 90.0));
        assert_eq!(tr, (120.0, 100.0));
        assert_eq!(br, (110.0, 110.0));
        assert_eq!(bl, (100.0, 100.0));
    }

    #[test]
    fn test_ctc_decode_basic() {
        // classes = 5: [blank, 'a', 'b', 'c', space]
        // sequence: a a blank b space b b
        let logits = [
            // t0 → a
            0.1, 0.8, 0.05, 0.03, 0.02,
            // t1 → a (duplicate, dropped)
            0.1, 0.8, 0.05, 0.03, 0.02,
            // t2 → blank
            0.8, 0.05, 0.05, 0.05, 0.05,
            // t3 → b
            0.05, 0.05, 0.8, 0.05, 0.05,
            // t4 → space
            0.05, 0.05, 0.05, 0.05, 0.8,
            // t5 → b
            0.05, 0.05, 0.8, 0.05, 0.05,
            // t6 → b (duplicate, dropped)
            0.05, 0.05, 0.8, 0.05, 0.05,
        ];
        let keys = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let (text, conf, emissions) = ctc_decode(&logits, 5, &keys);
        assert_eq!(text, "ab b");
        assert!((conf - 0.8).abs() < 1e-6);
        // emission timesteps: a@0, b@3, space@4, b@5
        assert_eq!(emissions, vec![0, 3, 4, 5]);
    }

    #[test]
    fn test_unclip_expands() {
        let q = Quad {
            corners: [(0.0, 0.0), (10.0, 0.0), (10.0, 2.0), (0.0, 2.0)],
        };
        let e = q.unclip(1.6);
        // d = 1.6 * 20 / 24 ≈ 1.333 → w = 12.67, h = 4.67
        assert!((e.width() - 12.6667).abs() < 0.01);
        assert!((e.height() - 4.6667).abs() < 0.01);
    }

    #[test]
    fn test_component_to_quad_horizontal_line() {
        // A horizontal text-line-like block: 100px wide, 5px tall.
        // (A 1px line has zero PCA height and is dropped, matching the
        // reference min_size filtering.)
        let comp: Vec<(usize, usize)> = (0..100)
            .flat_map(|x| (10..15).map(move |y| (x, y)))
            .collect();
        let q = component_to_quad(&comp).unwrap();
        assert!(q.width() > 95.0);
        assert!(q.height() > 3.0 && q.height() < 5.0);
    }

    #[test]
    fn test_rotate_crop_horizontal() {
        // 2x1 white pixel at top-left of a 4x4 image; crop region = that area
        let mut img = RgbImage::new(4, 4);
        img.put_pixel(0, 0, Rgb([255, 255, 255]));
        img.put_pixel(1, 0, Rgb([255, 255, 255]));
        // horizontal quad covering pixels (0,0)..(2,1)
        let crop = rotate_crop(&img, &[(0.0, 0.0), (2.0, 0.0), (2.0, 1.0), (0.0, 1.0)]);
        assert_eq!(crop.dimensions(), (2, 1));
        assert_eq!(crop.get_pixel(0, 0), &Rgb([255, 255, 255]));
        assert_eq!(crop.get_pixel(1, 0), &Rgb([255, 255, 255]));
    }

    #[test]
    fn test_word_segments_basic() {
        // "AB CDE": ink 0..=5 (1px letter gap at col 3), 4px word gap at
        // 6..=9, ink 10..=25 (1px letter gap at col 20)
        let mut profile = vec![0u32; 26];
        for c in [0, 1, 2, 4, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25] {
            profile[c] = 5;
        }
        let segs = word_segments(&profile, 2).unwrap();
        assert_eq!(segs.len(), 2);
        assert!((segs[0].0).abs() < 1e-6);
        assert!((segs[0].1 - 6.0 / 26.0).abs() < 1e-6);
        assert!((segs[1].0 - 10.0 / 26.0).abs() < 1e-6);
        assert!((segs[1].1 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_word_segments_three_words() {
        // "aa bb cc": two word gaps (4px, 3px), no letter gaps
        let mut profile = vec![0u32; 25];
        for c in [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 23, 24] {
            profile[c] = 5;
        }
        let segs = word_segments(&profile, 3).unwrap();
        assert_eq!(segs.len(), 3);
        assert!((segs[0].1 - 6.0 / 25.0).abs() < 1e-6);
        assert!((segs[1].0 - 10.0 / 25.0).abs() < 1e-6);
        assert!((segs[1].1 - 16.0 / 25.0).abs() < 1e-6);
        assert!((segs[2].0 - 19.0 / 25.0).abs() < 1e-6);
    }

    #[test]
    fn test_word_segments_tied_widths_rejected() {
        // Two equal 2px gaps → ambiguous which one is the word gap
        let mut profile = vec![0u32; 20];
        for c in [0, 1, 2, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19] {
            profile[c] = 4;
        }
        assert!(word_segments(&profile, 2).is_none());
    }

    #[test]
    fn test_word_segments_too_few_gaps() {
        // One gap (3..=5) but 3 words need 2 gaps
        let mut profile = vec![0u32; 20];
        for c in [0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] {
            profile[c] = 4;
        }
        assert!(word_segments(&profile, 3).is_none());
    }
}
