import { memo, useEffect, useRef } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * Single-page thumbnail. Pure canvas — no text layer, no annotations,
 * no right-click menu. The render pipeline mirrors PdfPage.tsx (cancel
 * + await + genRef) so a fast-scrolling sidebar doesn't leak tasks.
 *
 * The parent owns jumpToPage semantics; this component only reports
 * pointer-down onActivate(n, e). Drag tracking lives in the parent
 * so it can persist across the thumb being unmounted by virtualization.
 */
interface ThumbnailProps {
  pageNum: number
  pdfDoc: PDFDocumentProxy
  /** Display width in CSS px — used to back-derive a low-DPI scale. */
  targetRenderWidth: number
  rotation: number
  isActive: boolean
  onActivate: (n: number, e: React.PointerEvent<HTMLCanvasElement>) => void
}

const Thumbnail = memo(function Thumbnail({
  pageNum,
  pdfDoc,
  targetRenderWidth,
  rotation,
  isActive,
  onActivate,
}: ThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<{ cancel(): void; promise: Promise<void> } | null>(null)
  const pageProxyRef = useRef<PDFPageProxy | null>(null)
  const genRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    genRef.current++
    const gen = genRef.current

    // Cancel any in-flight render before swapping page proxy.
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      try { renderTaskRef.current.promise.catch(() => {}) } catch {}
      renderTaskRef.current = null
    }
    pageProxyRef.current?.cleanup?.()
    pageProxyRef.current = null

    pdfDoc.getPage(pageNum).then((page) => {
      if (cancelled) {
        page.cleanup()
        return
      }
      pageProxyRef.current = page
      const canvas = canvasRef.current
      if (!canvas || genRef.current !== gen) return
      // Use viewport.scale as the actual pixel scale (NOT zoom × dpr) —
      // matches the main viewer per PdfPage.tsx:312-316.
      const pageVp1 = page.getViewport({ scale: 1, rotation })
      // Smaller scale = faster render. At targetRenderWidth ~100px (narrow sidebar),
      // 0.06 gives ~150×200px thumbnails which look crisp enough at thumb size.
      const scale = Math.max(0.06, targetRenderWidth / pageVp1.width)
      const vp = page.getViewport({ scale, rotation })
      canvas.width = vp.width
      canvas.height = vp.height
      canvas.style.width = '100%'
      canvas.style.height = 'auto'
      canvas.style.aspectRatio = `${vp.width} / ${vp.height}`
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const task = page.render({ canvas, viewport: vp }) as unknown as {
        cancel(): void
        promise: Promise<void>
      }
      renderTaskRef.current = task
      task.promise.catch((err: Error) => {
        if (err?.name === 'RenderingCancelledException' || err?.message === 'cancelled') return
        console.error('[Thumbnail] render failed:', err)
      }).finally(() => {
        if (renderTaskRef.current === task) renderTaskRef.current = null
      })
    }).catch((err) => {
      if (cancelled) return
      console.error('[Thumbnail] getPage failed:', err)
    })

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        try { renderTaskRef.current.promise.catch(() => {}) } catch {}
        renderTaskRef.current = null
      }
    }
    // pageProxy changes are tracked via genRef + pdfDoc.getPage chain.
    // targetRenderWidth / rotation prop changes re-trigger the effect.
  }, [pageNum, pdfDoc, targetRenderWidth, rotation])

  return (
    <div
      className={`relative mx-1 my-1 cursor-pointer overflow-hidden rounded transition-all ${
        isActive
          ? 'ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--surface)]'
          : 'hover:ring-1 hover:ring-[var(--border)]'
      }`}
      data-thumb-page={pageNum}
    >
      <canvas
        ref={canvasRef}
        className="block w-full select-none touch-none"
        onPointerDown={(e) => onActivate(pageNum, e)}
      />
      <div
        className={`pointer-events-none absolute bottom-1 left-1 rounded px-1 py-0.5 text-[9px] tabular-nums ${
          isActive
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--bg)]/80 text-[var(--text)] opacity-70'
        }`}
      >
        {pageNum}
      </div>
    </div>
  )
})

export default Thumbnail