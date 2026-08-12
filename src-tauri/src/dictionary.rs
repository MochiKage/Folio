use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ─── Types ──────────────────────────────────────

/// A single dictionary lookup result returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct DictEntry {
    pub word: String,
    pub phonetic: Option<String>,
    pub definition_en: String,
    pub translation_zh: String,
    pub tags: Option<String>,
    /// Which dictionary this result came from
    pub source_dict_id: String,
    pub source_dict_name: String,
}

/// Internal row from the ecdict table.
#[allow(dead_code)]
struct EcdictRow {
    word: String,
    phonetic: Option<String>,
    definition: String,
    translation: String,
    tag: Option<String>,
    exchange: Option<String>,
}

/// Metadata about a dictionary, stored in folio.db and exposed to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryMeta {
    pub id: String,
    pub name: String,
    pub source_lang: String,
    pub target_lang: String,
    pub format: String,
    pub file_path: String,
    pub enabled: bool,
    pub priority: i32,
    pub entry_count: i32,
    pub is_builtin: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Validation result returned by `validate_dictionary`.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationError>,
    pub warnings: Vec<String>,
    pub entry_count: Option<i32>,
    pub sample_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
}

// ─── Backend enum ───────────────────────────────

/// Supported dictionary backend implementations.
enum BackendImpl {
    Ecdict(EcdictBackend),
}

impl BackendImpl {
    fn metadata(&self) -> &DictionaryMeta {
        match self {
            BackendImpl::Ecdict(b) => b.metadata(),
        }
    }

    fn lookup(&self, word: &str) -> Result<Option<DictEntry>, String> {
        match self {
            BackendImpl::Ecdict(b) => b.lookup(word),
        }
    }

    #[allow(dead_code)]
    fn entry_count(&self) -> usize {
        match self {
            BackendImpl::Ecdict(b) => b.entry_count(),
        }
    }
}

// ─── ECDICT Backend ────────────────────────────

/// Check whether a table exists in the SQLite database.
fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        rusqlite::params![name],
        |row| row.get::<_, i64>(0),
    )
    .map(|c| c > 0)
    .unwrap_or(false)
}

struct EcdictBackend {
    meta: DictionaryMeta,
    conn: Mutex<Connection>,
    /// Detected table name — "ecdict" or "stardict"
    table_name: String,
    /// Whether the exchange column exists (for reverse lookup)
    has_exchange: bool,
}

impl EcdictBackend {
    fn open(meta: DictionaryMeta) -> Result<Self, String> {
        let conn = Connection::open_with_flags(
            &meta.file_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("Failed to open dictionary file: {}", e))?;

        // Performance pragmas
        if let Err(e) = conn.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA journal_mode = OFF;
             PRAGMA synchronous = OFF;
             PRAGMA cache_size = 8000;
             PRAGMA temp_store = MEMORY;",
        ) {
            log::warn!("Failed to set dictionary pragmas: {}", e);
        }

        // Auto-detect table name: prefer "stardict", fall back to "ecdict"
        let table_name = if table_exists(&conn, "stardict") {
            "stardict".to_string()
        } else if table_exists(&conn, "ecdict") {
            "ecdict".to_string()
        } else {
            return Err(
                "Dictionary file has neither 'ecdict' nor 'stardict' table".into()
            );
        };

        // Detect whether the exchange column exists
        let has_exchange: bool = conn
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('{}') WHERE name = 'exchange'",
                table_name
            ))
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);

        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {}", table_name), [], |row| row.get(0))
            .map_err(|e| format!("Failed to count dictionary entries: {}", e))?;

        let mut meta = meta;
        meta.entry_count = count as i32;

        log::info!(
            "ECDICT backend opened: {} (table={}, {} entries, exchange={})",
            meta.name,
            table_name,
            count,
            has_exchange,
        );

        Ok(Self {
            meta,
            conn: Mutex::new(conn),
            table_name,
            has_exchange,
        })
    }

    fn metadata(&self) -> &DictionaryMeta {
        &self.meta
    }

    #[allow(dead_code)]
    fn entry_count(&self) -> usize {
        self.meta.entry_count as usize
    }

    fn lookup(&self, word: &str) -> Result<Option<DictEntry>, String> {
        let word = word.trim().to_lowercase();
        if word.is_empty() || word.len() > 64 {
            return Ok(None);
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let dict_id = &self.meta.id;
        let dict_name = &self.meta.name;

        // Stage 1: Direct lookup
        if let Some(row) = self.query_word(&conn, &word)? {
            return Ok(Some(self.row_to_entry(row, dict_id, dict_name)));
        }

        // Stage 2: Reverse exchange lookup
        if self.has_exchange {
            if let Some(row) = self.reverse_exchange_lookup(&conn, &word)? {
                return Ok(Some(self.row_to_entry(row, dict_id, dict_name)));
            }
        }

        // Stage 3: Rule-based lemmatisation
        for candidate in lemma_candidates(&word) {
            if candidate == word {
                continue;
            }
            if let Some(row) = self.query_word(&conn, &candidate)? {
                return Ok(Some(self.row_to_entry(row, dict_id, dict_name)));
            }
        }

        Ok(None)
    }

    fn query_word(
        &self,
        conn: &Connection,
        word: &str,
    ) -> Result<Option<EcdictRow>, String> {
        let sql = format!(
            "SELECT word, phonetic, definition, translation, tag \
             FROM {} WHERE word = ?1",
            self.table_name
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let result = stmt
            .query_row(rusqlite::params![word], |row| {
                Ok(EcdictRow {
                    word: row.get(0)?,
                    phonetic: row.get(1)?,
                    definition: row.get::<_, String>(2).unwrap_or_default(),
                    translation: row.get::<_, String>(3).unwrap_or_default(),
                    tag: row.get(4)?,
                    exchange: None,
                })
            })
            .ok();

        Ok(result)
    }

    fn reverse_exchange_lookup(
        &self,
        conn: &Connection,
        word: &str,
    ) -> Result<Option<EcdictRow>, String> {
        let pattern = format!("%/{}%", word);
        let sql = format!(
            "SELECT word, phonetic, definition, translation, tag \
             FROM {} WHERE exchange LIKE ?1 LIMIT 1",
            self.table_name
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Reverse exchange prepare error: {}", e))?;

        let result = stmt
            .query_row(rusqlite::params![pattern], |row| {
                Ok(EcdictRow {
                    word: row.get(0)?,
                    phonetic: row.get(1)?,
                    definition: row.get::<_, String>(2).unwrap_or_default(),
                    translation: row.get::<_, String>(3).unwrap_or_default(),
                    tag: row.get(4)?,
                    exchange: None,
                })
            })
            .ok();

        Ok(result)
    }

    fn row_to_entry(
        &self,
        row: EcdictRow,
        dict_id: &str,
        dict_name: &str,
    ) -> DictEntry {
        DictEntry {
            word: row.word,
            phonetic: row.phonetic,
            definition_en: row.definition,
            translation_zh: row.translation,
            tags: row.tag,
            source_dict_id: dict_id.to_string(),
            source_dict_name: dict_name.to_string(),
        }
    }
}

// ─── Dictionary Manager ────────────────────────

/// Owns all dictionary backends. Managed as Tauri state.
pub struct DictionaryManager {
    backends: Mutex<Vec<BackendImpl>>,
}

impl DictionaryManager {
    pub fn new() -> Self {
        Self {
            backends: Mutex::new(Vec::new()),
        }
    }

    /// Load a dictionary from its metadata. Returns an error if the file
    /// can't be opened or has a bad schema — the caller should handle
    /// this gracefully (skip the dictionary, log a warning).
    pub fn load(&self, meta: DictionaryMeta) -> Result<(), String> {
        let backend = match meta.format.as_str() {
            "ecdict" => BackendImpl::Ecdict(EcdictBackend::open(meta)?),
            other => return Err(format!("Unsupported dictionary format: {}", other)),
        };
        self.backends.lock().unwrap().push(backend);
        Ok(())
    }

    /// Remove a backend from the in-memory list. Returns false if not found.
    pub fn unload(&self, id: &str) -> bool {
        let mut backends = self.backends.lock().unwrap();
        if let Some(pos) = backends.iter().position(|b| b.metadata().id == id) {
            backends.remove(pos);
            true
        } else {
            false
        }
    }

    /// Look up a word across all enabled backends in priority order.
    /// Returns the first match (short-circuit).
    pub fn lookup(&self, word: &str) -> Result<Option<DictEntry>, String> {
        let backends = self.backends.lock().unwrap();

        // Collect enabled backends sorted by priority
        let mut enabled: Vec<&BackendImpl> = backends
            .iter()
            .filter(|b| b.metadata().enabled)
            .collect();
        enabled.sort_by_key(|b| b.metadata().priority);

        for backend in enabled {
            if let Some(entry) = backend.lookup(word)? {
                return Ok(Some(entry));
            }
        }
        Ok(None)
    }

    /// Return metadata for all registered dictionaries.
    pub fn list_metas(&self) -> Vec<DictionaryMeta> {
        self.backends
            .lock()
            .unwrap()
            .iter()
            .map(|b| b.metadata().clone())
            .collect()
    }

    /// Update the priority of a dictionary. Also triggers reorder
    /// of other dictionaries to avoid conflicts.
    pub fn set_priority(&self, id: &str, new_priority: i32) {
        let mut backends = self.backends.lock().unwrap();
        // Find the target and its current priority
        let current = backends.iter().find(|b| b.metadata().id == id).map(|b| b.metadata().priority);
        let current = match current {
            Some(p) => p,
            None => return,
        };

        // Shift other backends' priorities to make room
        for b in backends.iter_mut() {
            let meta = b.metadata_mut();
            if meta.id == id {
                meta.priority = new_priority;
            } else if current < new_priority {
                // Moving down: shift those between current+1..=new_priority up
                if meta.priority > current && meta.priority <= new_priority {
                    meta.priority -= 1;
                }
            } else if current > new_priority {
                // Moving up: shift those between new_priority..=current-1 down
                if meta.priority >= new_priority && meta.priority < current {
                    meta.priority += 1;
                }
            }
        }
    }

    /// Rename a dictionary (in-memory only — caller must also update the database).
    pub fn rename(&self, id: &str, new_name: &str) -> bool {
        let mut backends = self.backends.lock().unwrap();
        if let Some(b) = backends.iter_mut().find(|b| b.metadata().id == id) {
            b.metadata_mut().name = new_name.to_string();
            true
        } else {
            false
        }
    }

    /// Toggle a dictionary's enabled state (in-memory only — caller
    /// must also update the database).
    pub fn set_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut backends = self.backends.lock().unwrap();
        if let Some(b) = backends.iter_mut().find(|b| b.metadata().id == id) {
            b.metadata_mut().enabled = enabled;
            true
        } else {
            false
        }
    }
}

impl BackendImpl {
    fn metadata_mut(&mut self) -> &mut DictionaryMeta {
        match self {
            BackendImpl::Ecdict(b) => &mut b.meta,
        }
    }
}

// ─── Dictionary Validation ─────────────────────

/// Validate a dictionary file before importing it.
/// Checks file readability, schema, and content quality.
pub fn validate_dictionary(file_path: &str, format: &str) -> ValidationResult {
    match format {
        "ecdict" => validate_ecdict(file_path),
        _ => ValidationResult {
            valid: false,
            errors: vec![ValidationError {
                field: "format".into(),
                message: format!("Unsupported dictionary format: {}", format),
            }],
            warnings: vec![],
            entry_count: None,
            sample_columns: vec![],
        },
    }
}

fn validate_ecdict(file_path: &str) -> ValidationResult {
    let mut errors: Vec<ValidationError> = vec![];
    let mut warnings: Vec<String> = vec![];
    let mut sample_columns: Vec<String> = vec![];
    let mut entry_count: Option<i32> = None;

    // 1. Open the file as SQLite
    let conn = match Connection::open_with_flags(file_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => {
            errors.push(ValidationError {
                field: "file".into(),
                message: format!("Cannot open file as SQLite database: {}", e),
            });
            return ValidationResult {
                valid: false,
                errors,
                warnings,
                entry_count: None,
                sample_columns,
            };
        }
    };

    // 2. Auto-detect table: prefer "stardict", then "ecdict"
    let table_name = if table_exists(&conn, "stardict") {
        "stardict"
    } else if table_exists(&conn, "ecdict") {
        "ecdict"
    } else {
        // List existing tables for the error message
        let existing: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .ok();
            stmt.as_mut()
                .and_then(|s| {
                    s.query_map([], |row| row.get::<_, String>(0))
                        .ok()
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        };
        errors.push(ValidationError {
            field: "table".into(),
            message: if existing.is_empty() {
                "Dictionary file contains no tables.".into()
            } else {
                format!(
                    "Dictionary file has neither 'ecdict' nor 'stardict' table. \
                     Found table(s): {}. \
                     Expected schema: (ecdict|stardict)(word, translation, ...)",
                    existing.join(", ")
                )
            },
        });
        return ValidationResult {
            valid: false,
            errors,
            warnings,
            entry_count: None,
            sample_columns,
        };
    };

    // 3. Collect column info
    let mut columns: Vec<(String, String)> = vec![];
    let pragma_sql = format!("SELECT name, type FROM pragma_table_info('{}')", table_name);
    if let Ok(mut stmt) = conn.prepare(&pragma_sql) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, String>(1).unwrap_or_default(),
            ))
        }) {
            for row in rows.flatten() {
                sample_columns.push(row.0.clone());
                columns.push(row);
            }
        }
    }

    // 4. Required columns
    let col_names: Vec<&str> = columns.iter().map(|(n, _)| n.as_str()).collect();
    for required in &["word", "translation"] {
        if !col_names.contains(required) {
            errors.push(ValidationError {
                field: "column".into(),
                message: format!(
                    "Required column '{}' is missing. Found columns: {}",
                    required,
                    col_names.join(", ")
                ),
            });
        }
    }

    // 5. Check optional columns and report warnings
    let optional_cols = ["phonetic", "definition", "tag", "exchange"];
    for col in &optional_cols {
        if !col_names.contains(col) {
            warnings.push(format!(
                "Optional column '{}' not found — related features will be disabled",
                col
            ));
        }
    }

    // 6. Count entries
    let count_sql = format!("SELECT COUNT(*) FROM {}", table_name);
    if let Ok(count) = conn.query_row(&count_sql, [], |row| row.get::<_, i64>(0)) {
        entry_count = Some(count as i32);
        if count < 100 {
            errors.push(ValidationError {
                field: "entries".into(),
                message: format!(
                    "Dictionary contains only {} entries (minimum 100 required). \
                     The file may be empty or corrupted.",
                    count
                ),
            });
        } else if count < 1000 {
            warnings.push(format!(
                "Dictionary has only {} entries — coverage may be limited",
                count
            ));
        }
    }

    // 7. Sample-check encoding (read a few rows to verify UTF-8)
    let sample_sql = format!("SELECT word, translation FROM {} LIMIT 5", table_name);
    if let Ok(mut stmt) = conn.prepare(&sample_sql) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, String>(1).unwrap_or_default(),
            ))
        }) {
            for (i, row) in rows.enumerate() {
                if let Ok((word, translation)) = row {
                    if translation.is_empty() {
                        warnings.push(format!(
                            "Row {} ('{}') has empty translation — some entries may be incomplete",
                            i + 1, word
                        ));
                    }
                }
            }
        }
    }

    let valid = errors.is_empty();

    ValidationResult {
        valid,
        errors,
        warnings,
        entry_count,
        sample_columns,
    }
}

// ─── Lemmatisation ─────────────────────────────

/// Generate candidate base forms by stripping common suffixes.
fn lemma_candidates(word: &str) -> Vec<String> {
    let mut candidates = Vec::with_capacity(12);

    // -ies → -y  (studies → study, carries → carry)
    if word.ends_with("ies") && word.len() > 4 {
        candidates.push(format!("{}y", &word[..word.len() - 3]));
    }
    // -ves → -f / -fe  (wives → wife, wolves → wolf)
    if word.ends_with("ves") && word.len() > 4 {
        let stem = &word[..word.len() - 3];
        candidates.push(format!("{}f", stem));
        candidates.push(format!("{}fe", stem));
    }
    // -ses / -zes / -ches / -shes / -xes → remove -es
    if word.ends_with("es") && word.len() > 4 {
        let stem = &word[..word.len() - 2];
        if stem.ends_with('s')
            || stem.ends_with('z')
            || stem.ends_with("ch")
            || stem.ends_with("sh")
            || stem.ends_with('x')
        {
            candidates.push(stem.to_string());
        }
    }
    // Plain -s suffix (cats → cat, walks → walk)
    if word.ends_with('s') && !word.ends_with("ss") && word.len() > 3 {
        candidates.push(word[..word.len() - 1].to_string());
    }

    // -ing (making → make, running → run, swimming → swim)
    if word.ends_with("ing") && word.len() > 5 {
        let stem = &word[..word.len() - 3];
        candidates.push(format!("{}e", stem));
        if stem.len() >= 3 {
            let chars: Vec<char> = stem.chars().collect();
            let last = chars[chars.len() - 1];
            let prev = chars[chars.len() - 2];
            if last == prev && last.is_alphabetic() {
                candidates.push(stem[..stem.len() - 1].to_string());
            }
        }
        candidates.push(stem.to_string());
    }

    // -ed (walked → walk, studied → study)
    if word.ends_with("ed") && word.len() > 4 {
        let stem = &word[..word.len() - 2];
        if stem.ends_with('i') && word.len() > 4 {
            candidates.push(format!("{}y", &stem[..stem.len() - 1]));
        }
        candidates.push(format!("{}e", stem));
        if stem.len() >= 3 {
            let chars: Vec<char> = stem.chars().collect();
            let last = chars[chars.len() - 1];
            let prev = chars[chars.len() - 2];
            if last == prev && last.is_alphabetic() {
                candidates.push(stem[..stem.len() - 1].to_string());
            }
        }
        candidates.push(stem.to_string());
    }

    // Comparative / superlative: -er, -est
    for suffix in &["er", "est"] {
        if word.ends_with(suffix) && word.len() > 4 {
            let stem = &word[..word.len() - suffix.len()];
            candidates.push(format!("{}e", stem));
            if stem.len() >= 3 {
                let chars: Vec<char> = stem.chars().collect();
                let last = chars[chars.len() - 1];
                let prev = chars[chars.len() - 2];
                if last == prev && last.is_alphabetic() {
                    candidates.push(stem[..stem.len() - 1].to_string());
                }
            }
            candidates.push(stem.to_string());
        }
    }

    // -ly → drop (quickly → quick)
    if word.ends_with("ly") && word.len() > 4 {
        let stem = &word[..word.len() - 2];
        if stem.ends_with('i') {
            candidates.push(format!("{}y", &stem[..stem.len() - 1]));
        }
        candidates.push(stem.to_string());
    }

    // -tion → -te (create → creation)
    if word.ends_with("tion") && word.len() > 6 {
        let stem = &word[..word.len() - 4];
        candidates.push(format!("{}te", stem));
        candidates.push(format!("{}e", stem));
        candidates.push(stem.to_string());
    }

    // -ment (enjoyment → enjoy)
    if word.ends_with("ment") && word.len() > 6 {
        candidates.push(word[..word.len() - 4].to_string());
    }

    // -ness (happiness → happy)
    if word.ends_with("ness") && word.len() > 6 {
        let stem = &word[..word.len() - 4];
        if stem.ends_with('i') {
            candidates.push(format!("{}y", &stem[..stem.len() - 1]));
        }
        candidates.push(stem.to_string());
    }

    candidates
}

// ─── Tests ─────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lemma_plural() {
        let cs = lemma_candidates("studies");
        assert!(cs.contains(&"study".to_string()), "studies → study: {:?}", cs);
    }

    #[test]
    fn test_lemma_ing() {
        let cs = lemma_candidates("running");
        assert!(cs.contains(&"run".to_string()), "running → run: {:?}", cs);
    }

    #[test]
    fn test_lemma_ed() {
        let cs = lemma_candidates("walked");
        assert!(cs.contains(&"walk".to_string()), "walked → walk: {:?}", cs);
    }

    #[test]
    fn test_lemma_er() {
        let cs = lemma_candidates("bigger");
        assert!(cs.contains(&"big".to_string()), "bigger → big: {:?}", cs);
    }

    #[test]
    fn test_lemma_ly() {
        let cs = lemma_candidates("quickly");
        assert!(cs.contains(&"quick".to_string()), "quickly → quick: {:?}", cs);
    }
}
