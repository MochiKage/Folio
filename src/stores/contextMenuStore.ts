import { create } from 'zustand'

export interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  selectedText: string
  /** Exact word at the click position, read directly from the PDF text
   *  span's textContent.  More reliable than extracting from selectedText
   *  when the browser selection misses edge characters. */
  clickedWord: string
  pageNumber: number
  /** PDF-space bounding box for the selection (merged from client rects) */
  pdfRect: [number, number, number, number] | null
  /** IDs of annotations that overlap the current selection — shown as "Remove Highlight" */
  overlappingAnnIds: string[]

  show: (opts: {
    x: number
    y: number
    selectedText: string
    clickedWord?: string
    pageNumber: number
    pdfRect: [number, number, number, number] | null
    overlappingAnnIds?: string[]
  }) => void
  hide: () => void
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  visible: false,
  x: 0,
  y: 0,
  selectedText: '',
  clickedWord: '',
  pageNumber: 1,
  pdfRect: null,
  overlappingAnnIds: [],

  show: (opts) => set({ clickedWord: '', ...opts, visible: true }),
  hide: () => set({ visible: false }),
}))
