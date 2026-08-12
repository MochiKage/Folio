import { create } from 'zustand'
import * as api from '../lib/api'

/**
 * Annotation store — caches annotations per document, grouped by page.
 *
 * Key pattern mirrors ocrStore: "docId:page" → Annotation[].
 * The AnnotationOverlay in PdfPage subscribes to only its own page's
 * slice, avoiding re-renders when other pages change.
 */
interface AnnotationState {
  /** Annotations keyed by "documentId:pageNumber" */
  byPage: Record<string, api.Annotation[]>
  /** Set of document IDs whose annotations have been fetched */
  loadedDocs: Set<string>

  /** Fetch all annotations for a document (idempotent — skips if already loaded) */
  fetchForDocument: (docId: string) => Promise<void>

  /** Get annotations for a specific page (from cache) */
  forPage: (docId: string, page: number) => api.Annotation[]

  /** Add a new annotation (calls backend + updates cache) */
  add: (ann: api.Annotation) => Promise<void>

  /** Remove an annotation (calls backend + updates cache) */
  remove: (id: string) => Promise<void>

  /** Force reload for a document */
  reload: (docId: string) => Promise<void>
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  byPage: {},
  loadedDocs: new Set(),

  fetchForDocument: async (docId) => {
    if (get().loadedDocs.has(docId)) return
    try {
      const list = await api.getAnnotations(docId)
      set((s) => {
        const byPage = { ...s.byPage }
        // Group by page
        const grouped: Record<string, api.Annotation[]> = {}
        for (const ann of list) {
          const key = `${docId}:${ann.page}`
          if (!grouped[key]) grouped[key] = []
          grouped[key].push(ann)
        }
        // Clear old entries for this doc
        for (const key of Object.keys(byPage)) {
          if (key.startsWith(`${docId}:`)) delete byPage[key]
        }
        Object.assign(byPage, grouped)
        return { byPage, loadedDocs: new Set([...s.loadedDocs, docId]) }
      })
    } catch (err) {
      console.error('[annotationStore] fetch failed:', err)
    }
  },

  forPage: (docId, page) => {
    return get().byPage[`${docId}:${page}`] ?? []
  },

  add: async (ann) => {
    // Optimistic cache update
    const key = `${ann.document_id}:${ann.page}`
    set((s) => ({
      byPage: {
        ...s.byPage,
        [key]: [...(s.byPage[key] ?? []), ann],
      },
    }))
    try {
      await api.upsertAnnotation(ann)
    } catch (err) {
      console.error('[annotationStore] upsert failed:', err)
      // Rollback on failure
      set((s) => ({
        byPage: {
          ...s.byPage,
          [key]: (s.byPage[key] ?? []).filter((a) => a.id !== ann.id),
        },
      }))
    }
  },

  remove: async (id) => {
    // Find and remove from cache
    const state = get()
    let targetKey = ''
    for (const [key, list] of Object.entries(state.byPage)) {
      if (list.some((a) => a.id === id)) {
        targetKey = key
        break
      }
    }
    if (targetKey) {
      set((s) => ({
        byPage: {
          ...s.byPage,
          [targetKey]: s.byPage[targetKey].filter((a) => a.id !== id),
        },
      }))
    }
    try {
      await api.deleteAnnotation(id)
    } catch (err) {
      console.error('[annotationStore] delete failed:', err)
    }
  },

  reload: async (docId) => {
    set((s) => {
      const loadedDocs = new Set(s.loadedDocs)
      loadedDocs.delete(docId)
      return { loadedDocs }
    })
    await get().fetchForDocument(docId)
  },
}))
