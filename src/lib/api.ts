import { invoke } from '@tauri-apps/api/core'

// ─── Documents ────────────────────────────────────
export interface Document {
  id: string
  title: string | null
  authors: string
  file_path: string
  doi: string | null
  year: number | null
  page_count: number
  last_page: number
  read_progress: number
  metadata: string
  created_at: string | null
  updated_at: string | null
}

export function getAllDocuments(): Promise<Document[]> {
  return invoke('get_all_documents')
}

export function upsertDocument(doc: Document): Promise<void> {
  return invoke('upsert_document', { doc })
}

export function updateReadingProgress(
  docId: string,
  page: number,
  progress: number
): Promise<void> {
  return invoke('update_reading_progress', {
    docId,
    page,
    progress,
  })
}

export function deleteDocument(docId: string): Promise<void> {
  return invoke('delete_document', { docId })
}

// ─── Annotations ──────────────────────────────────
export interface Annotation {
  id: string
  document_id: string
  page: number
  annot_type: string
  color: string | null
  rect: string
  content: string | null
  metadata: string
  created_at: string | null
  updated_at: string | null
}

export function getAnnotations(documentId: string): Promise<Annotation[]> {
  return invoke('get_annotations', { documentId })
}

export function upsertAnnotation(ann: Annotation): Promise<void> {
  return invoke('upsert_annotation', { ann })
}

export function deleteAnnotation(annId: string): Promise<void> {
  return invoke('delete_annotation', { annId })
}

// ─── Bookmarks ────────────────────────────────────
export interface Bookmark {
  id: string
  document_id: string
  page: number
  label: string | null
  created_at: string | null
}

export function getBookmarks(documentId: string): Promise<Bookmark[]> {
  return invoke('get_bookmarks', { documentId })
}

export function addBookmark(bm: Bookmark): Promise<void> {
  return invoke('add_bookmark', { bm })
}

export function removeBookmark(bmId: string): Promise<void> {
  return invoke('remove_bookmark', { bmId })
}

// ─── Vocabulary ───────────────────────────────────
export interface VocabWord {
  id: string
  word: string
  phonetic: string | null
  definition: string
  sentence: string | null
  source_doc_id: string | null
  source_page: number | null
  tags: string
  review_count: number
  last_review_at: string | null
  created_at: string | null
}

export function getVocabulary(): Promise<VocabWord[]> {
  return invoke('get_vocabulary')
}

export function addVocabulary(word: VocabWord): Promise<void> {
  return invoke('add_vocabulary', { word })
}

export function updateReview(wordId: string): Promise<void> {
  return invoke('update_review', { wordId })
}

export function removeVocabulary(wordId: string): Promise<void> {
  return invoke('remove_vocabulary', { wordId })
}

// ─── Tags ─────────────────────────────────────────
export interface Tag {
  id: string
  namespace: string
  value: string
  color: string | null
}

export interface TagWithCount {
  tag: Tag
  count: number
}

export function getAllTags(): Promise<TagWithCount[]> {
  return invoke('get_all_tags')
}

export function upsertTag(tag: Tag): Promise<void> {
  return invoke('upsert_tag', { tag })
}

export function addDocumentTag(documentId: string, tagId: string): Promise<void> {
  return invoke('add_document_tag', { documentId, tagId })
}

export function removeDocumentTag(documentId: string, tagId: string): Promise<void> {
  return invoke('remove_document_tag', { documentId, tagId })
}

export function getDocumentTags(documentId: string): Promise<Tag[]> {
  return invoke('get_document_tags', { documentId })
}

export function searchDocumentsByTags(tagIds: string[]): Promise<string[]> {
  return invoke('search_documents_by_tags', { tagIds })
}

// ─── Dictionary ────────────────────────────────────
export interface DictEntry {
  word: string
  phonetic: string | null
  definition_en: string
  translation_zh: string
  tags: string | null
  /** Which dictionary matched this entry */
  source_dict_id: string
  source_dict_name: string
}

export function lookupWord(word: string): Promise<DictEntry | null> {
  return invoke('lookup_word', { word })
}

/** Metadata about an installed dictionary. */
export interface DictionaryMeta {
  id: string
  name: string
  source_lang: string
  target_lang: string
  format: string
  file_path: string
  enabled: boolean
  priority: number
  entry_count: number
  is_builtin: boolean
  created_at: string | null
  updated_at: string | null
}

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: string[]
  entry_count: number | null
  sample_columns: string[]
}

export function listDictionaries(): Promise<DictionaryMeta[]> {
  return invoke('list_dictionaries')
}

export function validateDictionary(
  filePath: string,
  format: string
): Promise<ValidationResult> {
  return invoke('validate_dictionary', { filePath, format })
}

export function addDictionary(meta: DictionaryMeta): Promise<void> {
  return invoke('add_dictionary', { meta })
}

export function removeDictionary(dictId: string): Promise<void> {
  return invoke('remove_dictionary', { dictId })
}

export function toggleDictionary(
  dictId: string,
  enabled: boolean
): Promise<void> {
  return invoke('toggle_dictionary', { dictId, enabled })
}

export function reorderDictionary(
  dictId: string,
  newPriority: number
): Promise<void> {
  return invoke('reorder_dictionary', { dictId, newPriority })
}

export function renameDictionary(
  dictId: string,
  newName: string
): Promise<void> {
  return invoke('rename_dictionary', { dictId, newName })
}

// ─── OCR ───────────────────────────────────────────
export interface OcrBox {
  text: string
  /** Padded box (PDF space) — used for recognition cropping */
  x0: number
  y0: number
  x1: number
  y1: number
  confidence: number
  /** Tight bounding box of the detected text pixels (PDF space, y-up).
   *  Used to position the rendered text layer precisely on the page.
   *  Absent (0) for older cached results — fall back to x0..y1. */
  tx0?: number
  ty0?: number
  tx1?: number
  ty1?: number
  /** Per-character CTC emission fractions (0..1, aligned with `text`).
   *  Char k of `text` reached its probability peak at timestep chars[k]×T.
   *  Used for word-level span positioning — absent in older cached results. */
  chars?: number[]
  /** Per-word horizontal spans as fractions (0..1) of the tight box width,
   *  aligned with the whitespace-separated words of `text`. Extracted from
   *  the source image's column profile — pixel evidence, preferred over
   *  `chars` (CTC timing) for word placement. For skewed lines the profile
   *  runs along the line direction and fractions are converted back to
   *  tight-box x. Empty when gaps are ambiguous. */
  word_bounds?: [number, number][]
  /** The line's ink height (skew-independent), PDF pt. The tight height
   *  inflates on skewed lines, so the rendered font size derives from
   *  this. Absent (0) in caches older than v4. */
  line_h?: number
  /** The page's text tilt angle in degrees (display clockwise-positive,
   *  0 = level) — word spans rotate with the text on skewed pages.
   *  Refined two-pass estimate (v7): first-pass median + the residual
   *  measured after deskewing — errors ≤ 0.1°. Absent (0) in older
   *  caches. */
  angle?: number
  /** Cache format version — entries with v < 7 predate the refined
   *  two-pass tilt estimate. */
  v?: number
}

export interface OcrPageData {
  document_id: string
  page: number
  text: string
  confidence: number
  boxes: OcrBox[]
}

export function getOcrResult(
  docId: string,
  page: number
): Promise<OcrPageData | null> {
  return invoke('get_ocr_result', { docId, page })
}

export function runOcr(
  docId: string,
  page: number,
  /** Raw RGB pixels (width*height*3 bytes, row-major) */
  image: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  viewBox: [number, number, number, number],
  /** Frontend time spent rendering/extracting the 300-DPI pixels (ms) —
   *  passed through so the backend can log a per-stage breakdown. */
  renderMs: number
): Promise<OcrPageData> {
  return invoke('run_ocr', {
    docId,
    page,
    image,
    imageWidth,
    imageHeight,
    viewBox,
    renderMs,
  })
}

export function deleteOcrResult(
  docId: string,
  page: number
): Promise<void> {
  return invoke('delete_ocr_result', { docId, page })
}

export function ocrModelStatus(): Promise<{
  det: string
  rec: string
  ready: boolean
}> {
  return invoke('ocr_model_status')
}

// ─── Full-text search ──────────────────────────────
export interface OcrSearchHit {
  page: number
  snippet: string
}

export interface OcrSearchResult {
  /** Every page that has an ocr_cache row — lets the frontend tell
   *  "already OCR'd" apart from "embedded text / not yet OCR'd". */
  cached_pages: number[]
  hits: OcrSearchHit[]
}

export function searchDocument(
  docId: string,
  query: string
): Promise<OcrSearchResult> {
  return invoke('search_document', { docId, query })
}
