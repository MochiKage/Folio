import { useCallback, useRef, useState, memo } from 'react'
import { usePdfStore } from '../stores/pdfStore'
import { useAppStore } from '../stores/appStore'

/**
 * Custom reading progress bar.
 *
 * Why this exists: the native scrollbar only knows the container's
 * scrollWidth/scrollLeft — in single-page mode it has no notion of
 * "page N of M", so dragging it never lands the reader on the page
 * they want. This widget reads activePage directly from the store,
 * shows a page-number badge, and jumps on click/drag.
 */
const ReadingProgressBar = memo(function ReadingProgressBar() {
  const activePage = usePdfStore((s) => s.activePage)
  const totalPages = usePdfStore((s) => s.getActiveDoc()?.totalPages ?? 0)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const jumpToPage = usePdfStore((s) => s.jumpToPage)
  const horizontal = layoutMode === 'single'

  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)

  // Convert a client coordinate along the track into a page number.
  const pageFromClient = useCallback(
    (clientCoord: number): number => {
      const el = trackRef.current
      if (!el || totalPages <= 1) return 1
      const r = el.getBoundingClientRect()
      const len = horizontal ? r.width : r.height
      const pos = horizontal ? clientCoord - r.left : clientCoord - r.top
      const ratio = Math.min(1, Math.max(0, pos / len))
      return Math.max(1, Math.min(totalPages, Math.round(ratio * (totalPages - 1)) + 1))
    },
    [horizontal, totalPages],
  )

  // Pointer interactions on the track.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (totalPages <= 1) return
      e.preventDefault()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      setDragging(true)
      jumpToPage(pageFromClient(horizontal ? e.clientX : e.clientY))
    },
    [horizontal, jumpToPage, pageFromClient, totalPages],
  )
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const next = pageFromClient(horizontal ? e.clientX : e.clientY)
      setHoverRatio((next - 1) / Math.max(1, totalPages - 1))
      if (dragging) jumpToPage(next)
    },
    [dragging, horizontal, jumpToPage, pageFromClient, totalPages],
  )
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setDragging(false)
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    },
    [],
  )
  const onPointerLeave = useCallback(() => {
    setDragging(false)
    setHoverRatio(null)
  }, [])

  // Keyboard support — arrow keys nudge by a page while the track has
  // focus. Not bound to window because that would fight the global
  // ←/→ page-turn in single mode.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (totalPages <= 1) return
      const step = e.shiftKey ? 10 : 1
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        jumpToPage(Math.max(1, activePage - step))
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        jumpToPage(Math.min(totalPages, activePage + step))
      } else if (e.key === 'Home') {
        e.preventDefault()
        jumpToPage(1)
      } else if (e.key === 'End') {
        e.preventDefault()
        jumpToPage(totalPages)
      }
    },
    [activePage, jumpToPage, totalPages],
  )

  if (totalPages <= 1) return null

  const ratio = (activePage - 1) / (totalPages - 1)
  // Badge position when hovering (so the user sees which page they
  // would jump to before committing on drag).
  const badgePage =
    hoverRatio !== null ? Math.max(1, Math.min(totalPages, Math.round(hoverRatio * (totalPages - 1)) + 1)) : null

  // Track classes — fixed to the application viewport so it never
  // participates in flex / overflow layout (a flex sibling with
  // h-full / w-full would steal height from the scroll container and
  // break the PDF rendering — that was the original bug).
  const trackClasses = horizontal
    ? 'fixed bottom-[27px] left-0 right-0 z-40 h-3 cursor-pointer touch-none'
    : 'fixed right-0 top-10 bottom-[27px] z-40 w-3 cursor-pointer touch-none'

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={`Reading progress — page ${activePage} of ${totalPages}`}
      aria-valuemin={1}
      aria-valuemax={totalPages}
      aria-valuenow={activePage}
      className={`${trackClasses} z-40 shrink-0 bg-[var(--border)]/30 outline-none focus-visible:bg-[var(--border)]/50`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      style={horizontal ? { paddingTop: 4, paddingBottom: 4 } : { paddingLeft: 4, paddingRight: 4 }}
    >
      <div className="relative h-full w-full">
        {/* Filled portion up to the current page */}
        <div
          className="absolute bg-[var(--color-accent)]/60"
          style={
            horizontal
              ? { left: 0, top: 4, bottom: 4, width: `${ratio * 100}%` }
              : { top: 0, left: 4, right: 4, height: `${ratio * 100}%` }
          }
        />
        {/* Thumb */}
        <div
          className="absolute rounded-full bg-[var(--color-accent)] shadow-md"
          style={
            horizontal
              ? {
                  left: `calc(${ratio * 100}% - 5px)`,
                  top: 2,
                  width: 10,
                  height: 10,
                  transition: dragging ? 'none' : 'left 0.12s ease-out',
                }
              : {
                  top: `calc(${ratio * 100}% - 5px)`,
                  left: 2,
                  width: 10,
                  height: 10,
                  transition: dragging ? 'none' : 'top 0.12s ease-out',
                }
          }
        />
        {/* Hover badge — anchored OUTSIDE the track so adjacent UI
         *  (StatusBar / sidebar / page edges) never clips it. Uses
         *  high z-index so the badge stays above any container stacking
         *  context the progress bar sits in. */}
        {badgePage !== null && (
          <div
            className="pointer-events-none absolute z-50 rounded bg-[var(--text)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--bg)] shadow-md ring-1 ring-[var(--border)]"
            style={
              horizontal
                // Bottom bar — badge above the track, far enough to clear
                // the padding of the track itself.
                ? { left: `calc(${hoverRatio! * 100}% - 14px)`, bottom: 14 }
                // Right rail — badge to the LEFT of the track (toward the
                // PDF area) so it never collides with the page edge or
                // sidebar.
                : { top: `calc(${hoverRatio! * 100}% - 8px)`, right: 14 }
            }
          >
            {badgePage}
          </div>
        )}
      </div>
    </div>
  )
})

export default ReadingProgressBar