import { memo } from 'react'
import type { PageViewport } from 'pdfjs-dist'
import { useAnnotationStore } from '../stores/annotationStore'
import type { Annotation } from '../lib/api'

/** Stable empty array to avoid unnecessary re-renders from `?? []` */
const EMPTY_ARR: Annotation[] = []

interface Props {
  documentId: string
  pageNumber: number
  viewport: PageViewport
}

/**
 * Renders highlight annotation rectangles on top of the canvas
 * but below the text layer.  Converts PDF-space rects to viewport
 * coordinates so highlights scale correctly with zoom.
 */
const AnnotationOverlay = memo(function AnnotationOverlay({
  documentId,
  pageNumber,
  viewport,
}: Props) {
  const annotations = useAnnotationStore(
    (s) => s.byPage[`${documentId}:${pageNumber}`] ?? EMPTY_ARR,
  )

  const highlights = annotations.filter((a) => a.annot_type === 'highlight')

  if (highlights.length === 0) return null

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[1]"
      style={{ width: viewport.width, height: viewport.height }}
    >
      {highlights.map((ann) => (
        <HighlightRect key={ann.id} ann={ann} viewport={viewport} />
      ))}
    </div>
  )
})

/** Parse the stored rect JSON and render a single highlight */
function HighlightRect({
  ann,
  viewport,
}: {
  ann: Annotation
  viewport: PageViewport
}) {
  let rect: [number, number, number, number]
  try {
    rect = JSON.parse(ann.rect)
  } catch {
    return null
  }
  if (!Array.isArray(rect) || rect.length !== 4) return null

  const [x0, y0, x1, y1] = rect
  const [vx0, vy0] = viewport.convertToViewportPoint(x0, y0)
  const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1)

  const left = Math.min(vx0, vx1)
  const top = Math.min(vy0, vy1)
  const width = Math.abs(vx1 - vx0)
  const height = Math.abs(vy1 - vy0)

  if (width < 0.5 || height < 0.5) return null

  return (
    <div
      className="absolute"
      style={{
        left,
        top,
        width,
        height,
        backgroundColor: ann.color || '#ffeb3b',
        opacity: 0.25,
        borderRadius: 2,
      }}
    />
  )
}

export default AnnotationOverlay
