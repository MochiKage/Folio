# Bundled Dictionary Resources

Place your ECDICT SQLite dictionary file here:

```
ecdict.db
```

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
