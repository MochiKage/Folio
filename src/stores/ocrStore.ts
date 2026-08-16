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
  /** Debug text layer: draw OCR span bounds (red dashed outline) so
   *  alignment issues are visible without console digging. */
  debugTextLayer: boolean
  /** Per-page OCR statuses, keyed by "docId:pageNum" */
  statuses: Record<string, OcrStatus>
  /** Cached OCR boxes in PDF point space, keyed by "docId:pageNum" */
  boxes: Record<string, OcrBox[]>

  toggleForceOcr: () => void
  toggleDebugTextLayer: () => void
  setPageStatus: (docId: string, page: number, status: OcrStatus) => void
  setPageResult: (docId: string, page: number, boxes: OcrBox[]) => void
  clearPageOcr: (docId: string, page: number) => void
  clearAllOcr: (docId: string) => void
}

export const useOcrStore = create<OcrState>((set) => ({
  forceOcr: false,
  debugTextLayer: false,
  statuses: {},
  boxes: {},

  toggleForceOcr: () => set((s) => ({ forceOcr: !s.forceOcr })),
  toggleDebugTextLayer: () => set((s) => ({ debugTextLayer: !s.debugTextLayer })),

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
// Serializes OCR jobs so fast scrolling doesn't fire dozens of
// parallel 300-DPI renders. Visible-page jobs ('user') jump ahead of
// background prefetch jobs ('prefetch'); at most one job runs at a
// time. A request for a page already queued/in-flight returns the
// first request's promise (dedup) — a user request promotes that
// page's pending prefetch job to the front.

type OcrPriority = 'user' | 'prefetch'

interface PendingJob {
  key: string
  fn: () => Promise<OcrBox[]>
  priority: OcrPriority
  promise: Promise<OcrBox[]>
  resolve: (v: OcrBox[]) => void
  reject: (e: unknown) => void
}

const pending: PendingJob[] = []
/** Jobs currently queued or running, by page key (dedup map) */
const knownJobs = new Map<string, PendingJob>()
let running = false

function pump(): void {
  if (running) return
  const job = pending.shift()
  if (!job) return
  running = true
  void job
    .fn()
    .then(
      (boxes) => job.resolve(boxes),
      (err) => job.reject(err),
    )
    .finally(() => {
      knownJobs.delete(job.key)
      running = false
      pump()
    })
}

/**
 * Enqueue an OCR job. Dedups by page: a second request for the same
 * page returns the first request's promise. 'user' jobs are inserted
 * ahead of pending 'prefetch' jobs — an existing pending prefetch for
 * the same page is promoted instead of re-enqueued.
 */
export function enqueueOcrJob(
  docId: string,
  page: number,
  fn: () => Promise<OcrBox[]>,
  priority: OcrPriority = 'user',
): Promise<OcrBox[]> {
  const key = pageKey(docId, page)

  const existing = knownJobs.get(key)
  if (existing) {
    if (priority === 'user' && existing.priority === 'prefetch') {
      existing.priority = 'user'
      const i = pending.indexOf(existing)
      if (i > 0) {
        pending.splice(i, 1)
        pending.unshift(existing)
      }
    }
    return existing.promise
  }

  let resolve!: (v: OcrBox[]) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<OcrBox[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  const job: PendingJob = { key, fn, priority, promise, resolve, reject }
  if (priority === 'user') pending.unshift(job)
  else pending.push(job)
  knownJobs.set(key, job)
  pump()
  return promise
}
