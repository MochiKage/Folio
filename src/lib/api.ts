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

// ─── OCR ───────────────────────────────────────────
export interface OcrBox {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  confidence: number
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
  image: number[],
  dpi: number,
  imageHeight: number,
  viewBox: [number, number, number, number]
): Promise<OcrPageData> {
  return invoke('run_ocr', {
    docId,
    page,
    image,
    dpi,
    imageHeight,
    viewBox,
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
