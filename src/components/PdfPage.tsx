import { useRef, useEffect, useCallback, memo } from 'react'
import type { PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../lib/pdfjs'

interface PdfPageProps {
  page: PDFPageProxy
  pageNumber: number
  zoom: number
  rotation: number
}

// Use TextLayer from the static import — NOT a dynamic import
// Dynamic import creates a separate module instance, breaking text positioning
const { TextLayer } = pdfjsLib

const PdfPage = memo(function PdfPage({
  page,
  pageNumber,
  zoom,
  rotation,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<ReturnType<typeof page.render> | null>(null)
  const textLayerInstanceRef = useRef<InstanceType<typeof TextLayer> | null>(null)

  const renderPage = useCallback(async () => {
    const canvas = canvasRef.current
    const textLayerDiv = textLayerRef.current
    if (!canvas) return

    // Cancel any in-progress render
    renderTaskRef.current?.cancel()
    // Cancel previous text layer
    textLayerInstanceRef.current?.cancel()

    // Small delay to let cancel propagate
    await new Promise((r) => setTimeout(r, 0))

    const viewport = page.getViewport({ scale: zoom, rotation })

    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    canvas.style.display = 'block'

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Render canvas first
    const renderTask = page.render({ canvas, viewport })
    renderTaskRef.current = renderTask

    try {
      await renderTask.promise

      // Render text layer — streamTextContent for proper font metric handling
      if (textLayerDiv) {
        textLayerDiv.innerHTML = ''
        textLayerDiv.style.width = `${viewport.width}px`
        textLayerDiv.style.height = `${viewport.height}px`

        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport,
        })
        textLayerInstanceRef.current = textLayer
        await textLayer.render()
      }
    } catch (err) {
      if (
        (err as Error)?.name !== 'RenderingCancelledException' &&
        (err as Error)?.message !== 'cancelled'
      ) {
        // Silently ignore render cancellations
      }
    }
  }, [page, zoom, rotation])

  useEffect(() => {
    renderPage()
    return () => {
      renderTaskRef.current?.cancel()
      textLayerInstanceRef.current?.cancel()
    }
  }, [renderPage])

  return (
    <div className="pdf-page relative mx-auto mb-4 shadow-lg" data-page-number={pageNumber}>
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="pdf-text-layer absolute inset-0" />
    </div>
  )
})

export default PdfPage
