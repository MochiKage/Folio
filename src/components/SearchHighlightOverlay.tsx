import { memo, useMemo } from 'react'
import type { PageViewport } from 'pdfjs-dist'
import { useSearchStore } from '../stores/searchStore'
import { useOcrStore } from '../stores/ocrStore'
import { matchInOcrBoxes } from '../lib/search'

interface Props {
  documentId: string
  pageNumber: number
  viewport: PageViewport
}

/**
 * Renders search-match highlight rectangles between the canvas and the
 * text layer (same pattern as AnnotationOverlay). Rects are PDF-space
 * and converted with the live viewport, so zoom/rotation stay correct.
 *
 * Stored rects come from the search pass (embedded / live OCR); for
 * ocr-cached hit pages whose boxes only arrive after mounting, the
 * rects are computed here from the store boxes — self-healing.
 */
const SearchHighlightOverlay = memo(function SearchHighlightOverlay({
  documentId,
  pageNumber,
  viewport,
}: Props) {
  const query = useSearchStore((s) => s.query)
  const searched = useSearchStore((s) => s.searched)
  const result = useSearchStore((s) => s.results[pageNumber])
  const current = useSearchStore((s) => s.current)
  const cachedBoxes = useOcrStore(
    (s) => (documentId ? s.boxes[`${documentId}:${pageNumber}`] : undefined),
  )

  const rects = useMemo(() => {
    const q = query.trim()
    if (!q || q !== searched || !result) return []
    const stored = result.rects
    if (stored.length > 0) return stored
    if (cachedBoxes && cachedBoxes.length > 0) {
      return matchInOcrBoxes(q, cachedBoxes).rects
    }
    return []
  }, [query, searched, result, cachedBoxes])

  if (rects.length === 0) return null

  const isCurrentPage = current?.page === pageNumber

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[1]"
      style={{ width: viewport.width, height: viewport.height }}
    >
      {rects.map((r, k) => {
        const [vx0, vy0] = viewport.convertToViewportPoint(r.x0, r.y0)
        const [vx1, vy1] = viewport.convertToViewportPoint(r.x1, r.y1)
        const left = Math.min(vx0, vx1)
        const top = Math.min(vy0, vy1)
        const width = Math.abs(vx1 - vx0)
        const height = Math.abs(vy1 - vy0)
        if (width < 0.5 || height < 0.5) return null
        const isCurrent = isCurrentPage && current!.localIdx === k
        return (
          <div
            key={k}
            className={`search-highlight${isCurrent ? ' current' : ''}`}
            style={{ left, top, width, height }}
          />
        )
      })}
    </div>
  )
})

export default SearchHighlightOverlay
