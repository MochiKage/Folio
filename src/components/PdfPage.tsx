import { useRef, useEffect, useCallback, memo } from 'react'
import type { PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../lib/pdfjs'
import { renderOcrTextLayer } from '../lib/ocr'
import { mergeParagraphLines } from '../lib/textLayer'
import { useOcrStore } from '../stores/ocrStore'

interface PdfPageProps {
  page: PDFPageProxy
  pageNumber: number
  zoom: number
  rotation: number
  documentId: string | null
}

const { TextLayer } = pdfjsLib

const PdfPage = memo(function PdfPage({
  page,
  pageNumber,
  zoom,
  rotation,
  documentId,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<ReturnType<typeof page.render> | null>(null)
  const textLayerInstanceRef = useRef<InstanceType<typeof TextLayer> | null>(null)
  const genRef = useRef(0)

  const forceOcr = useOcrStore((s) => s.forceOcr)
  const cachedBoxes = useOcrStore(
    (s) => (documentId ? s.boxes[`${documentId}:${pageNumber}`] : undefined) ?? null,
  )

  const renderPage = useCallback(async () => {
    const canvas = canvasRef.current
    const textLayerDiv = textLayerRef.current
    if (!canvas) return

    // Cancel previous render and wait for canvas release.
    // React StrictMode double-invokes effects — without awaiting the
    // cancellation, the second call hits "canvas in use" error.
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      try { await renderTaskRef.current.promise } catch {}
    }
    textLayerInstanceRef.current?.cancel()

    genRef.current++
    const gen = genRef.current

    const viewport = page.getViewport({ scale: zoom, rotation })

    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    canvas.style.display = 'block'

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Fetch text content in parallel with canvas render
    const textContentPromise = page.getTextContent()
    const renderTask = page.render({ canvas, viewport })
    renderTaskRef.current = renderTask

    try {
      await renderTask.promise

      if (!textLayerDiv || genRef.current !== gen) return

      textLayerDiv.innerHTML = ''

      /*
       * Set CSS variables required by PDF.js TextLayer.
       *
       * PDF.js uses `--total-scale-factor` in setLayerDimensions() to compute
       * the container size, and the font-size/transform of every span depends
       * on the derived `--text-scale-factor` variable.  Without these, the
       * text layer is sized at 1× regardless of the actual zoom, causing the
       * selection-highlight vs copied-text mismatch described in DEVLOG.md.
       *
       * The official viewer updates `--scale-factor` so that
       * --total-scale-factor equals viewport.scale (zoom); it does NOT
       * include devicePixelRatio — that is handled separately inside
       * TextLayer.#scale for text measurement on the hidden canvas.
       */
      textLayerDiv.style.setProperty('--total-scale-factor', String(zoom))
      textLayerDiv.style.setProperty('--scale-round-x', '1px')
      textLayerDiv.style.setProperty('--scale-round-y', '1px')

      const hasCached = cachedBoxes !== null && cachedBoxes.length > 0

      if (hasCached) {
        // Real OCR cache hit (Phase 3): render from stored bounding boxes
        renderOcrTextLayer(textLayerDiv, cachedBoxes!, viewport)
      } else {
        // PDF.js TextLayer — works for both normal and forceOcr modes.
        // In forceOcr mode this uses the same text content; in Phase 3
        // real OCR boxes will use renderOcrTextLayer above.
        const textContent = await textContentPromise
        if (genRef.current !== gen) return

        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        })
        textLayerInstanceRef.current = textLayer
        await textLayer.render()

        // PDF.js inserts <br> for every hasEOL item, which in many PDFs
        // means every visual line — even within the same paragraph.
        // mergeParagraphLines detects paragraph breaks by measuring
        // vertical gaps between lines and collapses intra-paragraph BRs.
        // Pass "auto" for character-based CJK/Latin space detection;
        // change to an ISO 639-1 code (e.g. "zh", "ja") when the UI
        // exposes a document-language setting.
        mergeParagraphLines(textLayerDiv, 'auto')
      }
    } catch (err) {
      const e = err as Error
      if (e?.name !== 'RenderingCancelledException' && e?.message !== 'cancelled') {
        console.error('[PdfPage] render failed:', e)
      }
    }
  }, [page, zoom, rotation, forceOcr, cachedBoxes])

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
