# Bundled Dictionary Resources

Place your ECDICT SQLite dictionary file here:

```
ecdict.db
```

## OCR Models & ONNX Runtime

The OCR feature (PaddleOCR PP-OCRv4) needs these files, which are **not tracked
in git** (they are large binaries). Install them with:

```powershell
powershell -ExecutionPolicy Bypass -File resources/models/download.ps1
```

Expected layout after download:

```
resources/
├── models/
│   ├── ch_PP-OCRv4_det_infer.onnx   # text detection (4.7MB)
│   ├── ch_PP-OCRv4_rec_infer.onnx   # text recognition (10.9MB)
│   ├── ppocr_keys_v1.txt            # CTC character table
│   └── download.ps1
└── lib/
    └── onnxruntime.dll              # ONNX Runtime 1.23.2 (14.2MB)
```

The models come from the RapidOCR 3.4.5 wheel (PyPI Tsinghua mirror) and the
DLL from the NuGet package `Microsoft.ML.OnnxRuntime` 1.23.2, matching the
`ort` crate 2.0.0-rc.11 (ORT API v23) used by the Rust backend.

## Obtaining ECDICT

ECDICT is an open-source English-Chinese dictionary by skywind3000.

### Option 1: Download pre-built (recommended)
Download the pre-built `ecdict.db` from the ECDICT releases page:
https://github.com/skywind3000/ECDICT/releases

### Option 2: Build from CSV
1. Download `ecdict.csv` from the ECDICT releases
2. Convert to SQLite:
```bash
sqlite3 ecdict.db <<EOF
CREATE TABLE ecdict (
    word TEXT,
    phonetic TEXT,
    definition TEXT,
    translation TEXT,
    pos TEXT,
    collins INTEGER,
    oxford INTEGER,
    tag TEXT,
    bnc INTEGER,
    frq INTEGER,
    exchange TEXT
);
.mode csv
.import ecdict.csv ecdict
CREATE INDEX idx_ecdict_word ON ecdict(word);
EOF
```

### Required schema
The `ecdict` table must contain at minimum these columns:
- `word` (TEXT) — the headword
- `translation` (TEXT) — Chinese translation

Optional columns (used when present):
- `phonetic` (TEXT)
- `definition` (TEXT) — English definition
- `tag` (TEXT) — POS tags / exam level tags
- `exchange` (TEXT) — inflected forms
