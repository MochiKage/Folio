"""Generate OCR robustness test fixtures from test_scanned.pdf.

Produces (300 DPI renders of page 1):
  test_clean.png / .pdf            - clean render (baseline)
  test_noisy.png                   - gaussian noise (sigma 18) + speckles
                                     (historical single-page name)
  test_noisy_s<sigma>.png          - one PNG per NOISE_SIGMAS entry
  test_noisy.pdf                   - MULTI-PAGE: one page per NOISE_SIGMAS
                                     (σ6, σ12, σ18, σ24, σ30, σ36), each
                                     with speckles
  test_skewed.png / .pdf           - rotated +1.5° + gaussian noise (sigma 12)
  test_skewed_<angle>.png          - one PNG per SKEW_ANGLES entry
  test_skewed.pdf                  - MULTI-PAGE: one page per SKEW_ANGLES
                                     (+1°, +1.5°, +2°, +3°, +5°, -2°),
                                     each with sigma-12 noise

PNGs feed the CLI smoke test (`ocr_smoke`); PDFs are image-only
wrappers for testing in the Folio app. PDF pages embed JPEG quality 85
(except the clean baseline, which stays lossless PNG) — real scanned
PDFs store pages as DCT, and embedding noisy PNGs produced a
pathological decode storm in the viewer. The binaries are not
committed (noise defeats compression, gitignored); regenerate with:

  python scripts/make_scan_fixtures.py

Requires: pymupdf (fitz), numpy, Pillow
"""

SKEW_ANGLES = [1.0, 1.5, 2.0, 3.0, 5.0, -2.0]
NOISE_SIGMAS = [6, 12, 18, 24, 30, 36]

from pathlib import Path
import tempfile

import fitz
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def render_page1() -> np.ndarray:
    doc = fitz.open(ROOT / "test_scanned.pdf")
    pix = doc[0].get_pixmap(dpi=300)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
        pix.height, pix.width, pix.n
    )[:, :, :3]
    return img


def append_png_page(doc: fitz.Document, png_path: Path, dpi: int = 300) -> None:
    """Append a 300-DPI PNG as an image-only PDF page (lossless PNG
    embed); page size = image size / dpi."""
    img = Image.open(png_path)
    w_pt = img.width / dpi * 72
    h_pt = img.height / dpi * 72
    page = doc.new_page(width=w_pt, height=h_pt)
    page.insert_image(fitz.Rect(0, 0, w_pt, h_pt), filename=str(png_path))


def append_jpeg_page(
    doc: fitz.Document, pil_img: Image.Image, tmpdir: Path, dpi: int = 300
) -> None:
    """Append a 300-DPI PIL image as an image-only PDF page, embedded
    as JPEG quality 85 — mirrors how real scanned PDFs store pages
    (DCT). In-app test files must decode like a real book; embedding
    noisy lossless PNGs caused a pathological decode storm."""
    w_pt = pil_img.width / dpi * 72
    h_pt = pil_img.height / dpi * 72
    jpg_path = tmpdir / f"page_{id(pil_img)}.jpg"
    pil_img.save(jpg_path, quality=85)
    page = doc.new_page(width=w_pt, height=h_pt)
    page.insert_image(fitz.Rect(0, 0, w_pt, h_pt), filename=str(jpg_path))


def wrap_as_pdf(png_path: Path, pdf_path: Path, dpi: int = 300) -> None:
    """Wrap a 300-DPI PNG into a single-page image-only PDF."""
    doc = fitz.open()
    append_png_page(doc, png_path, dpi)
    doc.save(pdf_path)
    doc.close()


def main() -> None:
    img = render_page1()
    rng = np.random.default_rng(42)

    # 0) clean baseline
    Image.fromarray(img).save(ROOT / "test_clean.png")

    # 1) noisy scans: one page per sigma (gaussian noise + speckles)
    noisy_pdf = fitz.open()
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for s in NOISE_SIGMAS:
            n = img.astype(np.float32)
            n += rng.normal(0, s, n.shape)
            specks = rng.random(n.shape[:2]) > 0.9995
            n[specks] = rng.integers(0, 255, (specks.sum(), 3))
            n_img = Image.fromarray(np.clip(n, 0, 255).astype(np.uint8))
            png_path = ROOT / f"test_noisy_s{s}.png"
            n_img.save(png_path)
            append_jpeg_page(noisy_pdf, n_img, tmpdir)
            if s == 18:
                # Keep the historical single-page name for the smoke test
                n_img.save(ROOT / "test_noisy.png")

        # 2) skewed scans: one page per angle + moderate noise, white canvas
        base = Image.fromarray(img)
        skewed_pdf = fitz.open()
        for a in SKEW_ANGLES:
            im = base.rotate(a, resample=Image.BICUBIC, expand=True, fillcolor=255)
            sk = np.array(im).astype(np.float32)
            sk += rng.normal(0, 12, sk.shape)
            sk_img = Image.fromarray(np.clip(sk, 0, 255).astype(np.uint8))
            png_path = ROOT / f"test_skewed_{a:+.1f}.png"
            sk_img.save(png_path)
            append_jpeg_page(skewed_pdf, sk_img, tmpdir)
            if a == 1.5:
                # Keep the historical single-page name for the smoke test
                sk_img.save(ROOT / "test_skewed.png")
        skewed_pdf.save(ROOT / "test_skewed.pdf")
        skewed_pdf.close()

    noisy_pdf.save(ROOT / "test_noisy.pdf")
    noisy_pdf.close()

    # 3) PDF wrapper for the clean baseline
    wrap_as_pdf(ROOT / "test_clean.png", ROOT / "test_clean.pdf")

    print(f"generated clean/noisy fixtures (sigmas {NOISE_SIGMAS}) and a "
          f"multi-angle test_skewed.pdf ({SKEW_ANGLES})")


if __name__ == "__main__":
    main()
