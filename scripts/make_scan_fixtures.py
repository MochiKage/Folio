"""Generate OCR robustness test fixtures from test_scanned.pdf.

Produces (300 DPI renders of page 1):
  test_noisy.png   - gaussian noise (sigma 18) + 0.05% salt-and-pepper speckles
  test_skewed.png  - rotated 1.5° + gaussian noise (sigma 12)

The binaries are not committed (noise defeats PNG compression: ~14MB each);
regenerate with:

  python scripts/make_scan_fixtures.py

Requires: pymupdf (fitz), numpy, Pillow
"""

from pathlib import Path

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


def main() -> None:
    img = render_page1()
    rng = np.random.default_rng(42)

    # 1) noisy scan: gray background + gaussian noise + speckles
    noisy = img.astype(np.float32)
    noisy += rng.normal(0, 18, noisy.shape)
    specks = rng.random(noisy.shape[:2]) > 0.9995
    noisy[specks] = rng.integers(0, 255, (specks.sum(), 3))
    Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8)).save(ROOT / "test_noisy.png")

    # 2) skewed scan: rotate 1.5 deg + moderate noise, white canvas
    im = Image.fromarray(img).rotate(1.5, resample=Image.BICUBIC, expand=True, fillcolor=255)
    sk = np.array(im).astype(np.float32)
    sk += rng.normal(0, 12, sk.shape)
    Image.fromarray(np.clip(sk, 0, 255).astype(np.uint8)).save(ROOT / "test_skewed.png")

    print("generated test_noisy.png and test_skewed.png")


if __name__ == "__main__":
    main()
