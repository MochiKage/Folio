import { create } from 'zustand'
import type { OcrBox } from '../lib/api'

export type OcrStatus = 'idle' | 'loading' | 'done' | 'error'

function pageKey(docId: string, page: number): string {
  return `${docId}:${page}`
}

interface OcrState {
  /** User-forced OCR mode — run PaddleOCR even on pages with embedded
   *  text (scanned pages are OCR'd automatically). */
  forceOcr: boolean
  /** Per-page OCR statuses, keyed by "docId:pageNum" */
  statuses: Record<string, OcrStatus>
  /** Cached OCR boxes in PDF point space, keyed by "docId:pageNum" */
  boxes: Record<string, OcrBox[]>

  toggleForceOcr: () => void
  setPageStatus: (docId: string, page: number, status: OcrStatus) => void
  setPageResult: (docId: string, page: number, boxes: OcrBox[]) => void
  clearPageOcr: (docId: string, page: number) => void
  clearAllOcr: (docId: string) => void
}

export const useOcrStore = create<OcrState>((set) => ({
  forceOcr: false,
  statuses: {},
  boxes: {},

  toggleForceOcr: () => set((s) => ({ forceOcr: !s.forceOcr })),

  setPageStatus: (docId, page, status) =>
    set((s) => ({
      statuses: { ...s.statuses, [pageKey(docId, page)]: status },
    })),

  setPageResult: (docId, page, boxes) =>
    set((s) => ({
      boxes: { ...s.boxes, [pageKey(docId, page)]: boxes },
      statuses: { ...s.statuses, [pageKey(docId, page)]: 'done' as OcrStatus },
    })),

  clearPageOcr: (docId, page) =>
    set((s) => {
      const key = pageKey(docId, page)
      const { [key]: _b, ...restBoxes } = s.boxes
      const { [key]: _s, ...restStatuses } = s.statuses
      return { boxes: restBoxes, statuses: restStatuses }
    }),

  clearAllOcr: (docId) =>
    set((s) => {
      const prefix = `${docId}:`
      const boxes: Record<string, OcrBox[]> = {}
      const statuses: Record<string, OcrStatus> = {}
      for (const [k, v] of Object.entries(s.boxes)) {
        if (!k.startsWith(prefix)) boxes[k] = v
      }
      for (const [k, v] of Object.entries(s.statuses)) {
        if (!k.startsWith(prefix)) statuses[k] = v
      }
      return { boxes, statuses }
    }),
}))

// ─── Module-level OCR job queue ──────────────────────
// Ensures at most one OCR job runs at a time, preventing
// fast scrolling from firing dozens of parallel 300-DPI renders.

let queueTail: Promise<unknown> = Promise.resolve()
const inFlight = new Map<string, Promise<OcrBox[]>>()

/**
 * Enqueue an OCR job. If a job for the same page is already in-flight,
 * returns the existing promise (deduplication). Otherwise chains onto
 * the sequential queue so only one new OCR runs at a time.
 */
export function enqueueOcrJob(
  docId: string,
  page: number,
  fn: () => Promise<OcrBox[]>,
): Promise<OcrBox[]> {
  const key = pageKey(docId, page)

  const existing = inFlight.get(key)
  if (existing) return existing

  const job = queueTail.then(async () => {
    try {
      return await fn()
    } finally {
      inFlight.delete(key)
    }
  })

  inFlight.set(key, job)
  queueTail = job.catch(() => {})
  return job
}
