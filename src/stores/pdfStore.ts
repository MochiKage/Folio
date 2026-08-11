import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface OpenDocument {
  id: string
  name: string
  path: string
  doc: PDFDocumentProxy
  currentPage: number
  zoom: number
  totalPages: number
}

interface PdfState {
  documents: OpenDocument[]
  activeDocId: string | null
  activePage: number
  zoom: number
  rotation: number

  addDocument: (doc: OpenDocument) => void
  removeDocument: (id: string) => void
  setActiveDoc: (id: string | null) => void
  setPage: (page: number) => void
  setZoom: (zoom: number) => void
  setRotation: (deg: number) => void

  getActiveDoc: () => OpenDocument | undefined
  jumpToPage: (page: number) => void
  _scrollTarget: number | null
  clearScrollTarget: () => void
}

export const usePdfStore = create<PdfState>((set, get) => ({
  documents: [],
  activeDocId: null,
  activePage: 1,
  zoom: 1.5,
  rotation: 0,

  addDocument: (doc) =>
    set((s) => ({
      documents: [...s.documents.filter((d) => d.id !== doc.id), doc],
      activeDocId: doc.id,
      activePage: doc.currentPage,
      zoom: doc.zoom,
    })),

  removeDocument: (id) =>
    set((s) => {
      const docs = s.documents.filter((d) => d.id !== id)
      return {
        documents: docs,
        activeDocId:
          s.activeDocId === id
            ? docs.length > 0
              ? docs[docs.length - 1].id
              : null
            : s.activeDocId,
      }
    }),

  setActiveDoc: (id) => {
    const doc = get().documents.find((d) => d.id === id)
    if (doc) {
      set({ activeDocId: id, activePage: doc.currentPage, zoom: doc.zoom })
    }
  },

  setPage: (page) => {
    const activeId = get().activeDocId
    if (!activeId) return
    set((s) => ({
      activePage: page,
      documents: s.documents.map((d) =>
        d.id === activeId ? { ...d, currentPage: page } : d
      ),
    }))
  },

  setZoom: (zoom) => {
    const activeId = get().activeDocId
    if (!activeId) return
    set((s) => ({
      zoom,
      documents: s.documents.map((d) =>
        d.id === activeId ? { ...d, zoom } : d
      ),
    }))
  },

  setRotation: (deg) => set({ rotation: deg }),

  // Jump to page — triggers scroll in ReaderViewport
  jumpToPage: (page: number) => {
    set({ activePage: page, _scrollTarget: page })
  },
  _scrollTarget: null as number | null,
  clearScrollTarget: () => set({ _scrollTarget: null }),

  getActiveDoc: () => {
    const { documents, activeDocId } = get()
    return documents.find((d) => d.id === activeDocId)
  },
}))
