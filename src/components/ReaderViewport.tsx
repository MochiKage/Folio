import { useRef, useEffect, useCallback, useMemo, useState, memo } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { usePdfStore } from '../stores/pdfStore'
import { useAppStore } from '../stores/appStore'
import { useAnnotationStore } from '../stores/annotationStore'
import { useOcrStore } from '../stores/ocrStore'
import { usePdfLoader } from '../hooks/usePdfLoader'
import PdfPage from './PdfPage'
import { open } from '@tauri-apps/plugin-dialog'
import * as api from '../lib/api'
import { generateId } from '../lib/selection'
import { setRotationHandler } from '../lib/rotationBus'

// How many pages ABOVE and BELOW the viewport to pre-render
const PAGE_BUFFER = 2

export default function ReaderViewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const pendingDocRef = useRef<string | null>(null)
  const zoomRafRef = useRef<number | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  /** Reading anchor captured before a rotation — used to restore the
   *  scroll position once the pages re-render at the new rotation. */
  const pendingAnchorRef = useRef<{
    pageNum: number
    pdfX: number
    pdfY: number
    screenX: number
    screenY: number
    oldPageH: number
  } | null>(null)

  const focusMode = useAppStore((s) => s.focusMode)
  const toggleFocusMode = useAppStore((s) => s.toggleFocusMode)
  const { activePage, zoom, rotation, setPage, setZoom, setRotation, addDocument, activeDocId } = usePdfStore()
  const { pdfDoc, loading, error, loadPdfFromPath } = usePdfLoader()
  const fetchAnnotations = useAnnotationStore((s) => s.fetchForDocument)

  // Fetch annotations ONCE when document changes (not per-page)
  useEffect(() => {
    if (activeDocId) fetchAnnotations(activeDocId)
  }, [activeDocId, fetchAnnotations])

  // Page dimensions for fit-width / fit-page calculations
  const [pageDims, setPageDims] = useState({ w: 612, h: 792 })

  // Get actual page dimensions from first page
  useEffect(() => {
    if (!pdfDoc) return
    pdfDoc.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1 })
      setPageDims({ w: vp.width, h: vp.height })
      page.cleanup()
    })
  }, [pdfDoc])

  // Compute effective zoom: -1 = fit width, -2 = fit page, >0 = manual
  const effectiveZoom = useMemo(() => {
    if (zoom > 0) return zoom
    const container = containerRef.current
    if (!container) return 1.5
    const cw = container.clientWidth - 32
    const ch = container.clientHeight - 32
    if (zoom === -1) return Math.max(0.25, cw / pageDims.w)
    if (zoom === -2) return Math.max(0.25, Math.min(cw / pageDims.w, ch / pageDims.h))
    return 1.5
  }, [zoom, pageDims])

  // Recompute fit-width on resize via a simple listener
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    if (zoom > 0) return
    const container = containerRef.current
    if (!container) return
    const obs = new ResizeObserver(() => forceUpdate((n) => n + 1))
    obs.observe(container)
    return () => obs.disconnect()
  }, [zoom])

  // ─── Virtualized rendering: only show pages near viewport ───
  const [visiblePages, setVisiblePages] = useState<Set<number>>(
    () => new Set(Array.from({ length: PAGE_BUFFER * 2 + 1 }, (_, i) => i + 1))
  )
  const visibleRef = useRef(visiblePages)
  visibleRef.current = visiblePages
  const [pageHeights, setPageHeights] = useState<Map<number, number>>(new Map())

  const pages = useMemo(() => {
    if (!pdfDoc) return []
    return Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1)
  }, [pdfDoc])

  // Register pages with IntersectionObserver for lazy loading
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    observerRef.current?.disconnect()
    const observer = new IntersectionObserver(
      (entries) => {
        const current = visibleRef.current
        const newVisible = new Set(current)
        let changed = false
        entries.forEach((entry) => {
          const num = Number((entry.target as HTMLElement).dataset.pageNumber)
          if (!entry.isIntersecting) return
          if (!newVisible.has(num)) { newVisible.add(num); changed = true }
          for (let i = Math.max(1, num - PAGE_BUFFER); i <= Math.min(pages.length, num + PAGE_BUFFER); i++) {
            if (!newVisible.has(i)) { newVisible.add(i); changed = true }
          }
        })
        if (changed) setVisiblePages(newVisible)
      },
      { root: container, rootMargin: '300px 0px' }
    )

    // Observe all placeholder divs
    pageRefs.current.forEach((el) => observer.observe(el))
    observerRef.current = observer

    return () => observer.disconnect()
  }, [pages])

  // Scroll to target page (triggered by outline/bookmark navigation)
  const scrollTarget = usePdfStore((s) => s._scrollTarget)
  const clearScrollTarget = usePdfStore((s) => s.clearScrollTarget)

  useEffect(() => {
    if (!scrollTarget || !pdfDoc) return
    const page = scrollTarget

    // Force the target page into visible set so it mounts
    setVisiblePages((prev) => {
      const next = new Set(prev)
      next.add(page)
      for (let i = Math.max(1, page - PAGE_BUFFER); i <= Math.min(pages.length, page + PAGE_BUFFER); i++) {
        next.add(i)
      }
      return next
    })

    // Force target page to render, then scroll after canvas is done
    const tryScroll = () => {
      const el = document.querySelector(`[data-page-number="${page}"]`)
      if (el) {
        el.scrollIntoView({ block: 'start' })
        clearScrollTarget()
      }
    }
    // rAF x 2 = after React commit + layout; then 120ms for canvas render
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(tryScroll, 120)))
  }, [scrollTarget])

  // When pdfDoc changes after loading, register in store AND ensure DB record exists
  useEffect(() => {
    if (pdfDoc && pendingDocRef.current) {
      const filePath = pendingDocRef.current
      const name = filePath.split(/[/\\]/).pop() || 'Untitled'
      const totalPages = pdfDoc.numPages
      addDocument({
        id: filePath,
        name,
        path: filePath,
        doc: pdfDoc,
        currentPage: 1,
        zoom: 1.5,
        totalPages,
      })
      // Ensure a document record exists for FK constraints (annotations,
      // bookmarks, vocabulary all reference documents.id).
      // Fire-and-forget — failure is non-fatal (e.g. if the record already exists).
      api.upsertDocument({
        id: filePath,
        title: name,
        authors: '[]',
        file_path: filePath,
        doi: null,
        year: null,
        page_count: totalPages,
        last_page: 1,
        read_progress: 0,
        metadata: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch((err) => console.error('[ReaderViewport] upsertDocument failed:', err))
      pendingDocRef.current = null
    }
  }, [pdfDoc, addDocument])

  // Open file dialog
  const handleOpenFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
      })
      if (selected) {
        pendingDocRef.current = selected as string
        await loadPdfFromPath(selected as string)
      }
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }, [loadPdfFromPath])

  // Track current page based on scroll
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    let bestPage = activePage, bestVis = 0
    pageRefs.current.forEach((el, num) => {
      const r = el.getBoundingClientRect()
      const cr = container.getBoundingClientRect()
      const vis = (Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top)) / r.height
      if (vis > bestVis) { bestVis = vis; bestPage = num }
    })
    if (bestPage !== activePage) setPage(bestPage)

    // Debounced progress persistence
    const docId = usePdfStore.getState().activeDocId
    const total = usePdfStore.getState().getActiveDoc()?.totalPages ?? 1
    if (docId && bestPage > 0) {
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
      progressTimerRef.current = setTimeout(() => {
        api.updateReadingProgress(docId, bestPage, bestPage / Math.max(1, total))
      }, 1500)
    }
  }, [activePage, setPage])

  // Zoom with rAF debounce
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const current = usePdfStore.getState().zoom
    const next = Math.min(5, Math.max(0.25, current - e.deltaY * 0.01))
    if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current)
    zoomRafRef.current = requestAnimationFrame(() => {
      setZoom(Math.round(next * 100) / 100)
      zoomRafRef.current = null
    })
  }, [setZoom])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') { e.preventDefault(); useAppStore.getState().toggleFocusMode() }
      if (e.key === 'Escape') {
        const s = useAppStore.getState()
        if (s.focusMode) { e.preventDefault(); s.toggleFocusMode() }
      }
      if (e.ctrlKey && e.key === 'b') { e.preventDefault(); useAppStore.getState().toggleSidebar() }
      if (e.ctrlKey && e.key === 'o') { e.preventDefault(); handleOpenFile() }
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault()
        const { activeDocId, activePage, triggerRefresh } = usePdfStore.getState()
        if (activeDocId) {
          api.addBookmark({
            id: generateId(),
            document_id: activeDocId,
            page: activePage,
            label: `Page ${activePage}`,
            created_at: new Date().toISOString(),
          }).then(() => triggerRefresh())
        }
      }
      // Debug text layer: show OCR span bounds (Ctrl+Shift+D)
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        useOcrStore.getState().toggleDebugTextLayer()
      }
      // Zoom shortcuts
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); setZoom(1.5) }
      if (e.ctrlKey && e.key === '=') { e.preventDefault(); setZoom(Math.min(4, usePdfStore.getState().zoom + 0.25)) }
      if (e.ctrlKey && e.key === '-') { e.preventDefault(); setZoom(Math.max(0.25, usePdfStore.getState().zoom - 0.25)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleOpenFile, setZoom])

  // ─── Rotation with reading-position preservation ───
  // Before rotating, capture the PDF-space point at the viewport center
  // (rotation-invariant). After the pages re-render at the new rotation,
  // re-derive the point's content position and shift the scroll so the
  // point stays at the same screen position.
  const handleRotate = useCallback(
    async (next: number) => {
      const container = containerRef.current
      if (!container || !pdfDoc) {
        setRotation(next)
        return
      }
      const rect = container.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2

      // Find the page under the viewport center
      let pageNum = 0
      for (const [pn, el] of pageRefs.current) {
        const pr = el.getBoundingClientRect()
        if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
          pageNum = pn
          break
        }
      }
      if (!pageNum) {
        setRotation(next)
        return
      }

      const pageEl = pageRefs.current.get(pageNum)!
      const pr = pageEl.getBoundingClientRect()
      const page = await pdfDoc.getPage(pageNum)
      const vp = page.getViewport({ scale: effectiveZoom, rotation })
      const [pdfX, pdfY] = vp.convertToPdfPoint(cx - pr.left, cy - pr.top)

      pendingAnchorRef.current = {
        pageNum,
        pdfX,
        pdfY,
        screenX: cx - rect.left,
        screenY: cy - rect.top,
        oldPageH: pr.height,
      }
      setRotation(next)
    },
    [pdfDoc, effectiveZoom, rotation, setRotation],
  )

  useEffect(() => {
    setRotationHandler((next) => void handleRotate(next))
    return () => setRotationHandler(null)
  }, [handleRotate])

  // After a rotation, restore the reading position once the anchor page
  // has re-rendered at the new rotation (heights settle within a few
  // frames; poll with rAF until two consecutive frames agree).
  useEffect(() => {
    const anchor = pendingAnchorRef.current
    if (!anchor) return
    let raf = 0
    let frames = 0
    let prevH = 0
    let settled = 0
    const apply = () => {
      frames++
      const container = containerRef.current
      const pageEl = pageRefs.current.get(anchor.pageNum)
      if (!container || !pageEl) {
        if (frames < 90) raf = requestAnimationFrame(apply)
        return
      }
      const pr = pageEl.getBoundingClientRect()
      settled = Math.abs(pr.height - prevH) < 1 ? settled + 1 : 0
      prevH = pr.height
      if (frames < 3 || (settled < 2 && frames < 90)) {
        raf = requestAnimationFrame(apply)
        return
      }
      void (async () => {
        try {
          if (!pdfDoc) return
          const page = await pdfDoc.getPage(anchor.pageNum)
          const newVp = page.getViewport({ scale: effectiveZoom, rotation })
          const [nvx, nvy] = newVp.convertToViewportPoint(anchor.pdfX, anchor.pdfY)
          const rect2 = container.getBoundingClientRect()
          // Off-screen placeholders above the anchor still hold
          // pre-rotation heights; correct them with the per-page delta
          // (exact for uniform documents, approximate otherwise).
          const staleAbove = Array.from(pageRefs.current.keys()).filter(
            (pn) => pn < anchor.pageNum && !visiblePages.has(pn),
          ).length
          const delta = pr.height - anchor.oldPageH
          const newContentY =
            pr.top - rect2.top + container.scrollTop + nvy + staleAbove * delta
          container.scrollTop = newContentY - anchor.screenY
          const newContentX = pr.left - rect2.left + container.scrollLeft + nvx
          container.scrollLeft = newContentX - anchor.screenX
        } finally {
          pendingAnchorRef.current = null
        }
      })()
    }
    raf = requestAnimationFrame(apply)
    return () => cancelAnimationFrame(raf)
  }, [rotation, effectiveZoom, visiblePages, pdfDoc])

  // ─── Empty state ───
  if (!pdfDoc || loading) {
    return (
      <main className={`flex flex-1 items-center justify-center bg-[var(--bg)] ${focusMode ? 'absolute inset-0 z-50' : ''}`}>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="text-7xl opacity-15">📄</div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--text)] opacity-60">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
              Loading document...
            </div>
          ) : (
            <>
              <p className="text-lg font-medium text-[var(--text)] opacity-50">Open a PDF to start reading</p>
              <p className="mt-1 text-sm text-[var(--text)] opacity-30">Ctrl+O or drag & drop a PDF file</p>
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
              <button onClick={handleOpenFile} className="mt-4 rounded-lg bg-[var(--color-accent)] px-8 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90">
                Open a PDF File
              </button>
            </>
          )}
        </div>
      </main>
    )
  }

  // ─── Document loaded ───
  return (
    <main
      ref={containerRef}
      className={`flex-1 overflow-auto bg-[var(--bg)] ${focusMode ? 'absolute inset-0 z-50' : ''}`}
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      {/* Floating fullscreen button — bottom-right, flat */}
      <button
        onClick={toggleFocusMode}
        className="fixed bottom-6 right-6 z-50 rounded-lg bg-[var(--surface)]/90 p-2 text-[var(--text)]/30 shadow-sm backdrop-blur-sm transition-all hover:text-[var(--text)]/60 hover:shadow-md"
        title={focusMode ? 'Exit (Esc)' : 'Fullscreen (F11)'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          {focusMode ? (
            <path d="M3 8h3l-2-2 2-2M8 3V2h4l-2 2M8 13v1h4l-2-2M13 8v3l-2-2M3 8v-3l2 2" />
          ) : (
            <path d="M1 5V2h3M15 11v3h-3M15 5V2h-3M1 11v3h3" />
          )}
        </svg>
      </button>

      <div className="flex flex-col items-center py-6">
        {pages.map((pageNum) => {
          const height = pageHeights.get(pageNum)
          return (
            <div
              key={pageNum}
              ref={(el) => { if (el) pageRefs.current.set(pageNum, el); else pageRefs.current.delete(pageNum) }}
              data-page-number={pageNum}
              style={height ? { minHeight: height } : undefined}
              className="flex w-full items-center justify-start"
            >
              {visiblePages.has(pageNum) ? (
                <PdfPageLazy
                  pageNum={pageNum}
                  pdfDoc={pdfDoc}
                  zoom={effectiveZoom}
                  rotation={rotation}
                  documentId={activeDocId}
                  onHeight={(h) => setPageHeights((prev) => new Map(prev).set(pageNum, h))}
                />
              ) : (
                <div style={{ height: height || 800, width: '100%' }} />
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}

// ─── Memoized per-page loader ───
const PdfPageLazy = memo(function PdfPageLazy({
  pageNum, pdfDoc, zoom, rotation, documentId, onHeight,
}: {
  pageNum: number
  pdfDoc: PDFDocumentProxy
  zoom: number
  rotation: number
  documentId: string | null
  onHeight: (h: number) => void
}) {
  const [pageProxy, setPageProxy] = useState<Awaited<ReturnType<typeof pdfDoc.getPage>> | null>(null)

  useEffect(() => {
    let cancelled = false
    setPageProxy(null)
    pdfDoc.getPage(pageNum).then((page) => {
      if (cancelled) { page.cleanup(); return }
      setPageProxy(page)
      const vp = page.getViewport({ scale: zoom, rotation })
      onHeight(vp.height)
    })
    return () => { cancelled = true }
  }, [pageNum, pdfDoc, zoom, rotation])

  if (!pageProxy) {
    return <div className="flex items-center justify-center text-xs text-[var(--text)] opacity-10" style={{ height: 600 }}>...</div>
  }

  return <PdfPage page={pageProxy} pageNumber={pageNum} zoom={zoom} rotation={rotation} documentId={documentId} />
})
