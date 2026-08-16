use rusqlite::Connection;
use serde::Serialize;
use tauri::State;
use crate::db::Database;

/// One page of `ocr_cache` whose text contains the query.
#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    pub page: i32,
    pub snippet: String,
}

/// Result of searching the OCR cache: every cached page (so the frontend
/// can tell "already OCR'd" apart from "embedded text / not yet OCR'd")
/// plus the pages that matched.
#[derive(Debug, Serialize, Clone)]
pub struct SearchOcrResult {
    pub cached_pages: Vec<i32>,
    pub hits: Vec<SearchHit>,
}

/// Escape LIKE wildcards (`%`, `_`) and the escape char itself so the
/// query matches literally.
fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 4);
    for ch in query.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// ±`window`-char window around the first case-insensitive match of
/// `query` in `text`, with ellipses at truncation points. UTF-8 safe —
/// computed on char boundaries, never sliced by byte offsets.
fn make_snippet(text: &str, query: &str, window: usize) -> String {
    let lower = text.to_lowercase();
    let q = query.to_lowercase();
    let Some(start_byte) = lower.find(&q) else {
        // Defensive (shouldn't happen for hit rows): take the head.
        let mut chars = text.chars();
        let head: String = chars.by_ref().take(window * 2).collect();
        return if chars.next().is_some() {
            format!("{head}…")
        } else {
            head
        };
    };
    let start_char = lower[..start_byte].chars().count();
    let q_chars = q.chars().count();
    let total = text.chars().count();

    let char_start = start_char.saturating_sub(window);
    let char_end = (start_char + q_chars + window).min(total);

    let slice: String = text
        .chars()
        .skip(char_start)
        .take(char_end - char_start)
        .collect();
    let prefix = if char_start > 0 { "…" } else { "" };
    let suffix = if char_end < total { "…" } else { "" };
    format!("{prefix}{slice}{suffix}")
}

/// Query `ocr_cache` for one document. Pure — takes `&Connection` so the
/// matching logic is unit-testable without Tauri state.
///
/// Case-insensitivity comes from SQLite's built-in ASCII folding in LIKE
/// (English academic text; no COLLATE clause — it can't combine with
/// ESCAPE in the grammar, and NOCASE would be ASCII-only anyway).
fn search_ocr_rows(
    conn: &Connection,
    doc_id: &str,
    query: &str,
) -> rusqlite::Result<SearchOcrResult> {
    let mut stmt =
        conn.prepare("SELECT page FROM ocr_cache WHERE document_id=?1 ORDER BY page")?;
    let cached_pages: Vec<i32> = stmt
        .query_map(rusqlite::params![doc_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchOcrResult {
            cached_pages,
            hits: Vec::new(),
        });
    }

    // Substring match: `%term%` — matches word stems too (circuit → circuits).
    let pattern = format!("%{}%", escape_like(trimmed));
    let mut stmt = conn.prepare(
        "SELECT page, text FROM ocr_cache \
         WHERE document_id=?1 AND text LIKE ?2 ESCAPE '\\' ORDER BY page",
    )?;
    let hits = stmt
        .query_map(rusqlite::params![doc_id, pattern], |row| {
            let page: i32 = row.get(0)?;
            let text: Option<String> = row.get(1)?;
            let snippet = make_snippet(text.as_deref().unwrap_or(""), trimmed, 40);
            Ok(SearchHit { page, snippet })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(SearchOcrResult { cached_pages, hits })
}

/// Full-text search over the OCR cache of one document (case-insensitive
/// literal substring). Text-layer pages are searched by the frontend via
/// PDF.js — see src/lib/search.ts.
#[tauri::command]
pub fn search_document(
    db: State<Database>,
    doc_id: String,
    query: String,
) -> Result<SearchOcrResult, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    search_ocr_rows(&conn, &doc_id, &query).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE ocr_cache (
                document_id TEXT NOT NULL,
                page INTEGER NOT NULL,
                text TEXT,
                confidence REAL,
                boxes TEXT DEFAULT '[]',
                created_at TEXT,
                PRIMARY KEY (document_id, page)
            );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, doc: &str, page: i32, text: &str) {
        conn.execute(
            "INSERT INTO ocr_cache (document_id, page, text) VALUES (?1, ?2, ?3)",
            rusqlite::params![doc, page, text],
        )
        .unwrap();
    }

    #[test]
    fn case_insensitive_substring_match() {
        let conn = test_conn();
        insert(&conn, "d1", 1, "The Circuit Design Handbook");
        insert(&conn, "d1", 2, "irrelevant");
        let r = search_ocr_rows(&conn, "d1", "CIRCUIT").unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].page, 1);
        assert!(r.hits[0].snippet.contains("Circuit"));
    }

    #[test]
    fn wildcards_are_literal() {
        let conn = test_conn();
        insert(&conn, "d1", 1, "100% correct");
        insert(&conn, "d1", 2, "not matching");
        let r = search_ocr_rows(&conn, "d1", "%").unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].page, 1);
        // Escaped underscore: "100_" appears nowhere.
        let r2 = search_ocr_rows(&conn, "d1", "100_").unwrap();
        assert_eq!(r2.hits.len(), 0);
    }

    #[test]
    fn cached_pages_include_non_hit_rows() {
        let conn = test_conn();
        insert(&conn, "d1", 3, "hello world");
        let r = search_ocr_rows(&conn, "d1", "zzz").unwrap();
        assert!(r.hits.is_empty());
        assert_eq!(r.cached_pages, vec![3]);
    }

    #[test]
    fn snippet_truncates_long_text() {
        let conn = test_conn();
        let long = format!("{}TARGET{}", "a".repeat(200), "b".repeat(200));
        insert(&conn, "d1", 5, &long);
        let r = search_ocr_rows(&conn, "d1", "target").unwrap();
        let s = &r.hits[0].snippet;
        assert!(s.starts_with('…'));
        assert!(s.ends_with('…'));
        assert!(s.contains("TARGET"));
        assert!(s.chars().count() <= 40 + "target".len() + 40 + 2);
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let conn = test_conn();
        insert(&conn, "d1", 1, "anything");
        let r = search_ocr_rows(&conn, "d1", "   ").unwrap();
        assert!(r.hits.is_empty());
        assert_eq!(r.cached_pages, vec![1]);
    }

    #[test]
    fn hits_ordered_by_page() {
        let conn = test_conn();
        insert(&conn, "d1", 9, "alpha match");
        insert(&conn, "d1", 2, "beta match");
        insert(&conn, "d1", 5, "gamma match");
        let r = search_ocr_rows(&conn, "d1", "match").unwrap();
        assert_eq!(
            r.hits.iter().map(|h| h.page).collect::<Vec<_>>(),
            vec![2, 5, 9]
        );
    }
}
