import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import * as api from '../lib/api'
import {
  clearEmbeddedTextCache,
  getEmbeddedPageText,
  matchEmbedded,
  matchInOcrBoxes,
  type PageResult,
} from '../lib/search'
import { hasEmbeddedText, type TextContent } from '../lib/textLayer'
import { runOcrPageIfNeeded } from '../lib/ocr'
import { usePdfStore } from './pdfStore'

/**
 * Full-text search state + orchestration. Three text sources:
 *   1. ocr_cache (Rust `search_document` — instant, persistent)
 *   2. embedded-text pages (session getTextContent index, matched in JS)
 *   3. scanned pages not yet OCR'd — batch OCR via the shared queue,
 *      results stream in as each page completes.
 */

export interface SearchProgress {
  classified: number
  total: number
  ocrDone: number
  ocrTotal: number
  paused: boolean
}

interface SearchState {
  /** Input box content (live while typing). */
  query: string
  /** The trimmed query the current results were computed for. */
  searched: string
  barOpen: boolean
  status: 'idle' | 'running' | 'done'
  results: Record<number, PageResult>
  orderedPages: number[]
  current: { page: number; localIdx: number } | null
  progress: SearchProgress

  setQuery: (q: string) => void
  openBar: () => void
  closeBar: () => void
  runSearch: (docId: string, pdfDoc: PDFDocumentProxy) => Promise<void>
  togglePause: () => void
  goTo: (page: number) => void
  next: () => void
  prev: () => void
  clear: () => void
}

/** Generation token — bumped on clear / doc switch so async results
 *  from a stale search are dropped. */
let gen = 0

/** Concurrency for text-content classification and OCR scheduling
 *  chunks (OCR itself stays serial inside ocrStore's queue). */
const BATCH = 8

const emptyProgress = (total = 0): SearchProgress => ({
  classified: 0,
  total,
  ocrDone: 0,
  ocrTotal: 0,
  paused: false,
})

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  searched: '',
  barOpen: false,
  status: 'idle',
  results: {},
  orderedPages: [],
  current: null,
  progress: emptyProgress(),

  setQuery: (q) => set({ query: q }),

  openBar: () => set({ barOpen: true }),
  closeBar: () => set({ barOpen: false }),

  runSearch: async (docId, pdfDoc) => {
    const query = get().query.trim()
    const myGen = ++gen
    if (!query) {
      set({
        searched: '', status: 'idle', results: {}, orderedPages: [],
        current: null, progress: emptyProgress(),
      })
      return
    }

    const total = pdfDoc.numPages
    set({
      searched: query,
      status: 'running',
      results: {},
      orderedPages: [],
      current: null,
      progress: emptyProgress(total),
    })

    const apply = (result: PageResult) => {
      if (gen !== myGen) return
      set((s) => {
        const results = { ...s.results, [result.page]: result }
        return {
          results,
          orderedPages: Object.keys(results)
            .map(Number)
            .sort((a, b) => a - b),
        }
      })
    }

    const bumpClassified = (n: number) => {
      if (gen !== myGen) return
      set((s) => ({
        progress: {
          ...s.progress,
          classified: Math.min(s.progress.classified + n, total),
        },
      }))
    }
    const bumpOcrDone = () => {
      if (gen !== myGen) return
      set((s) => ({
        progress: { ...s.progress, ocrDone: s.progress.ocrDone + 1 },
      }))
    }

    try {
      // 1) OCR-cache pages — one SQL round trip, instant.
      const r = await api.searchDocument(docId, query)
      if (gen !== myGen) return
      const cached = new Set(r.cached_pages)
      for (const h of r.hits) {
        apply({
          page: h.page,
          source: 'ocr-cached',
          snippet: h.snippet,
          matchCount: 0,
          rects: [],
        })
      }

      // 2) Classification pass over non-cached pages (parallel batches):
      //    embedded text → index + match here; scanned → OCR pass.
      const toCheck: number[] = []
      for (let p = 1; p <= total; p++) if (!cached.has(p)) toCheck.push(p)

      const pendingOcr: { pageNum: number; tc: TextContent }[] = []
      for (let i = 0; i < toCheck.length; i += BATCH) {
        const batch = toCheck.slice(i, i + BATCH)
        const settled = await Promise.allSettled(
          batch.map(async (p) => ({
            p,
            tc: await getEmbeddedPageText(docId, p, await pdfDoc.getPage(p)),
          })),
        )
        for (const c of settled) {
          if (gen !== myGen) return
          if (c.status !== 'fulfilled') continue
          const { p, tc } = c.value
          if (hasEmbeddedText(tc)) {
            const m = matchEmbedded(query, tc)
            if (m.matchCount > 0) {
              apply({
                page: p,
                source: 'embedded',
                snippet: m.snippet,
                matchCount: m.matchCount,
                rects: m.rects,
              })
            }
          } else {
            pendingOcr.push({ pageNum: p, tc })
          }
        }
        bumpClassified(batch.length)
      }
      if (gen !== myGen) return

      // 3) Batch OCR pass — chunked scheduling so pause stops new pages
      //    within ~one batch. Pages the user scrolls to promote to
      //    'user' priority in ocrStore's queue, jumping the line.
      if (pendingOcr.length > 0) {
        set((s) => ({ progress: { ...s.progress, ocrTotal: pendingOcr.length } }))
        for (let i = 0; i < pendingOcr.length; i += BATCH) {
          await waitWhilePaused(myGen)
          if (gen !== myGen) return
          const batch = pendingOcr.slice(i, i + BATCH)
          await Promise.allSettled(
            batch.map(async ({ pageNum, tc }) => {
              try {
                const page = await pdfDoc.getPage(pageNum)
                const boxes = await runOcrPageIfNeeded(
                  docId, pageNum, page, 'prefetch', tc,
                )
                if (gen === myGen && boxes.length > 0) {
                  const m = matchInOcrBoxes(query, boxes)
                  if (m.matchCount > 0) {
                    apply({
                      page: pageNum,
                      source: 'ocr-live',
                      snippet: m.snippet,
                      matchCount: m.matchCount,
                      rects: m.rects,
                    })
                  }
                }
              } catch (err) {
                console.warn(`[search] OCR failed on page ${pageNum}:`, err)
              } finally {
                bumpOcrDone()
              }
            }),
          )
        }
      }
      if (gen === myGen) set({ status: 'done' })
    } catch (err) {
      console.error('[search] runSearch failed:', err)
      if (gen === myGen) set({ status: 'done' })
    }
  },

  togglePause: () =>
    set((s) => ({ progress: { ...s.progress, paused: !s.progress.paused } })),

  goTo: (page) => {
    set({ current: { page, localIdx: 0 } })
    usePdfStore.getState().jumpToPage(page)
  },

  next: () => {
    const { orderedPages, current } = get()
    if (orderedPages.length === 0) return
    let idx = 0
    if (current) {
      const i = orderedPages.indexOf(current.page)
      if (i >= 0) idx = (i + 1) % orderedPages.length
    }
    const page = orderedPages[idx]
    set({ current: { page, localIdx: 0 } })
    usePdfStore.getState().jumpToPage(page)
  },

  prev: () => {
    const { orderedPages, current } = get()
    if (orderedPages.length === 0) return
    let idx = orderedPages.length - 1
    if (current) {
      const i = orderedPages.indexOf(current.page)
      if (i >= 0) idx = (i - 1 + orderedPages.length) % orderedPages.length
    }
    const page = orderedPages[idx]
    set({ current: { page, localIdx: 0 } })
    usePdfStore.getState().jumpToPage(page)
  },

  clear: () => {
    gen++
    set({
      query: '', searched: '', status: 'idle', results: {}, orderedPages: [],
      current: null, progress: emptyProgress(),
    })
  },
}))

/** Resolve once the user resumes (or the search is invalidated). */
function waitWhilePaused(myGen: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (gen !== myGen || !useSearchStore.getState().progress.paused) {
        resolve()
      } else {
        setTimeout(tick, 200)
      }
    }
    tick()
  })
}

// Document switch guard: drop everything from the previous document.
usePdfStore.subscribe((state, prev) => {
  if (state.activeDocId !== prev.activeDocId) {
    if (prev.activeDocId) clearEmbeddedTextCache(prev.activeDocId)
    useSearchStore.getState().clear()
  }
})
