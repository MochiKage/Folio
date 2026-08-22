import { useCallback, useEffect, useMemo, useReducer, useRef, memo } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { LayoutGrid } from 'lucide-react'
import { usePdfStore } from '../stores/pdfStore'
import Thumbnail from './Thumbnail'

const BUFFER = 2   // pages around the current one to pre-render
const DRAG_THRESHOLD = 4
const AUTO_SCROLL_IDLE_MS = 800

/**
 * Virtualized thumbnail list using IntersectionObserver.
 *
 * Simpler than the previous attempt:
 * - containerWidth read directly from the DOM (no useState timing issue)
 * - visibleSet starts seeded with the active page ± BUFFER
 * - IO only ADDS pages to visibleSet — never removes them
 * - no stagger, no cleanup race conditions
 */
const ThumbnailsPanel = memo(function ThumbnailsPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const visibleRef = useRef<Set<number>>(new Set())
  // Track container width with a simple ref + ResizeObserver.
  // Reading containerRef.current.clientWidth directly avoids stale closures.
  const containerWidthRef = useRef(0)
  const ioRef = useRef<IntersectionObserver | null>(null)
  // Track if we've seeded the initial set already this session.
  const seededRef = useRef(false)

  const activeDocId = usePdfStore((s) => s.activeDocId)
  const activePage = usePdfStore((s) => s.activePage)
  const totalPages = usePdfStore((s) => s.getActiveDoc()?.totalPages ?? 0)
  const pdfDoc = usePdfStore((s) => s.getActiveDoc()?.doc ?? null) as PDFDocumentProxy | null
  const rotation = usePdfStore((s) => s.rotation)
  const jumpToPage = usePdfStore((s) => s.jumpToPage)

  // ── Container width measurement ─────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    containerWidthRef.current = el.clientWidth
    const ro = new ResizeObserver((entries) => {
      containerWidthRef.current = Math.round(entries[0]?.contentRect.width ?? 0)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const targetRenderWidth = Math.max(80, (containerWidthRef.current || 240) - 16)

  // ── Visible set management ──────────────────────────────────────
  // Seed the visible set on first mount with the active page ± BUFFER.
  // IO will only expand this set — it never shrinks.
  const [, forceUpdate] = useReducer((n) => n + 1, 0)

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return
    const root = containerRef.current

    // Disconnect any previous observer.
    ioRef.current?.disconnect()

    const addRange = (center: number) => {
      let changed = false
      for (let i = Math.max(1, center - BUFFER); i <= Math.min(totalPages, center + BUFFER); i++) {
        if (!visibleRef.current.has(i)) {
          visibleRef.current.add(i)
          changed = true
        }
      }
      if (changed) forceUpdate()
    }

    // Initial seed.
    if (!seededRef.current) {
      seededRef.current = true
      addRange(activePage)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          const n = Number((entry.target as HTMLElement).dataset.thumbPage)
          if (!visibleRef.current.has(n)) {
            visibleRef.current.add(n)
            changed = true
            // Also add neighbours — they're likely next in scroll direction.
            for (let i = Math.max(1, n - BUFFER); i <= Math.min(totalPages, n + BUFFER); i++) {
              if (!visibleRef.current.has(i)) { visibleRef.current.add(i); changed = true }
            }
          }
        })
        if (changed) forceUpdate()
      },
      { root, rootMargin: '80px 0px', threshold: 0 },
    )
    ioRef.current = observer

    // Observe all currently mounted placeholder divs.
    root.querySelectorAll<HTMLElement>('[data-thumb-page]').forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  // Re-run when the document changes so we clear and reseed.
  }, [pdfDoc, totalPages, activeDocId])

  // ── Auto-scroll when main viewer changes active page ─────────────
  const lastScrollTsRef = useRef(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => { lastScrollTsRef.current = Date.now() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!activePage || !containerRef.current) return
    // Only auto-scroll if the target thumb is ALREADY in the visible set.
    // If it's still loading, scrollIntoView would land on the placeholder
    // position (≈ wrong page) and the sidebar would jump back to an earlier page.
    if (!visibleRef.current.has(activePage)) return
    if (Date.now() - lastScrollTsRef.current < AUTO_SCROLL_IDLE_MS) return
    requestAnimationFrame(() => {
      const el = containerRef.current
      if (!el) return
      const slot = el.querySelector<HTMLElement>(`[data-thumb-page="${activePage}"]`)
      slot?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [activePage])

  // When the active page finally loads into the visible set, scroll it
  // into view. Handles clicks on far pages that weren't pre-rendered yet.
  useEffect(() => {
    if (!activePage) return
    if (visibleRef.current.has(activePage)) return
    const interval = setInterval(() => {
      if (visibleRef.current.has(activePage)) {
        clearInterval(interval)
        const el = containerRef.current
        if (!el) return
        const slot = el.querySelector<HTMLElement>(`[data-thumb-page="${activePage}"]`)
        slot?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }, 200)
    return () => clearInterval(interval)
  }, [activePage])

  // ── Click vs drag ─────────────────────────────────────────────
  const handleActivate = useCallback(
    (n: number, e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      try { target.setPointerCapture(e.pointerId) } catch {}
      const startY = e.clientY
      let moved = false

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return
        if (!moved && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return
        moved = true
        const row = target.parentElement
        const rowH = row?.offsetHeight ?? 160
        const delta = Math.round((ev.clientY - startY) / rowH)
        const total = usePdfStore.getState().getActiveDoc()?.totalPages ?? 0
        if (!total) return
        const next = Math.min(total, Math.max(1, n + delta))
        if (next !== usePdfStore.getState().activePage) jumpToPage(next)
      }

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        try { target.releasePointerCapture(ev.pointerId) } catch {}
        if (!moved) jumpToPage(n)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [jumpToPage],
  )

  // ── Keyboard ─────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const total = usePdfStore.getState().getActiveDoc()?.totalPages ?? 0
      const cur = usePdfStore.getState().activePage
      if (!total) return
      const step = e.shiftKey ? 10 : 1
      let next: number | undefined
      if (e.key === 'ArrowDown') next = cur + step
      else if (e.key === 'ArrowUp') next = cur - step
      else if (e.key === 'PageDown') next = cur + 5
      else if (e.key === 'PageUp') next = cur - 5
      else if (e.key === 'Home') next = 1
      else if (e.key === 'End') next = total
      if (next == null) return
      e.preventDefault()
      jumpToPage(Math.min(total, Math.max(1, next)))
    },
    [jumpToPage],
  )

  // ── Empty state ──────────────────────────────────────────────
  if (!activeDocId || !pdfDoc || !totalPages) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <LayoutGrid size={32} className="text-[var(--text)] opacity-15" />
          <p className="text-xs text-[var(--text)] opacity-40">Open a PDF to view pages</p>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────
  const pageNumbers = useMemo(
    () => Array.from({ length: totalPages }, (_, i) => i + 1),
    [totalPages],
  )

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="navigation"
      aria-label="Page thumbnails"
      className="h-full overflow-y-auto outline-none focus-visible:bg-[var(--border)]/10"
      onKeyDown={onKeyDown}
    >
      {pageNumbers.map((n) => {
        const visible = visibleRef.current.has(n)
        return (
          <div
            key={n}
            data-thumb-page={n}
            className="flex items-center justify-center"
          >
            {visible ? (
              <Thumbnail
                pageNum={n}
                pdfDoc={pdfDoc}
                targetRenderWidth={targetRenderWidth}
                rotation={rotation}
                isActive={n === activePage}
                onActivate={handleActivate}
              />
            ) : (
              // Placeholder so the IO observer has something to watch.
              <div className="h-[140px] w-full" aria-hidden />
            )}
          </div>
        )
      })}
    </div>
  )
})

export default ThumbnailsPanel