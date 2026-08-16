import { useRef, useEffect, useCallback, memo } from 'react'
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'
import { pdfjsLib } from '../lib/pdfjs'
import { renderOcrTextLayer, runOcrPageIfNeeded } from '../lib/ocr'
import { mergeParagraphLines, hasEmbeddedText } from '../lib/textLayer'
import { useOcrStore } from '../stores/ocrStore'
import { useContextMenuStore } from '../stores/contextMenuStore'
import { useAnnotationStore } from '../stores/annotationStore'
import { selectionToPdfRects, mergeRects, rectsOverlap, getWordAtCaretPoint } from '../lib/selection'
import AnnotationOverlay from './AnnotationOverlay'
import type { Annotation } from '../lib/api'

/** Stable empty array to avoid re-renders from `?? []` (same pattern as AnnotationOverlay) */
const EMPTY_ANNOTATIONS: Annotation[] = []

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
  /** Cache the last viewport so AnnotationOverlay and context-menu handler can read it */
  const viewportRef = useRef<PageViewport>(page.getViewport({ scale: zoom, rotation }))

  const forceOcr = useOcrStore((s) => s.forceOcr)
  const debugTextLayer = useOcrStore((s) => s.debugTextLayer)
  const cachedBoxes = useOcrStore(
    (s) => (documentId ? s.boxes[`${documentId}:${pageNumber}`] : undefined) ?? null,
  )
  const pageStatus = useOcrStore(
    (s) => (documentId ? s.statuses[`${documentId}:${pageNumber}`] : undefined) ?? 'idle',
  )
  const showContextMenu = useContextMenuStore((s) => s.show)
  const pageAnnotations = useAnnotationStore(
    (s) => (documentId ? s.byPage[`${documentId}:${pageNumber}`] : undefined) ?? EMPTY_ANNOTATIONS,
  )

  /**
   * Find the word at a given position in the text layer.
   *
   * Two layers of hit-testing:
   * 1. PDF.js native spans are small text fragments (usually a single word),
   *    so the span's `textContent` IS the word.  Using it directly is more
   *    reliable than caret hit-testing — it survives the glyph-overhang
   *    problem (the original "astrophysics → astrophysic" bug), hence the
   *    +5px right tolerance.
   * 2. OCR spans contain a WHOLE LINE of text per span, so the span text
   *    must not be returned as-is (it would always resolve to the first
   *    word).  Instead use caret-based word extraction at the click point.
   *
   * Returns the word at (vx, vy) in page-local coordinates, or null.
   */
  const getWordAtPosition = useCallback(
    (clientX: number, clientY: number): string | null => {
      const div = textLayerRef.current
      if (!div) return null

      // Client-space hit-testing: getBoundingClientRect() includes the
      // layer's rotation transform, so this stays correct on rotated
      // pages (page-local coordinates would not).
      //
      // Word-level OCR spans have generous overlapping hit regions —
      // collect every span under the point and prefer the one whose
      // center is nearest to the click.
      let bestText: string | null = null
      let bestDist = Infinity

      const spans = div.querySelectorAll('span')
      for (const span of spans) {
        const el = span as HTMLElement
        const rect = el.getBoundingClientRect()

        // Right tolerance: +5 px accounts for the glyph-overhang problem
        // (the original "astrophysics → astrophysic" bug).
        if (
          rect.width > 0 &&
          clientX >= rect.left - 2 &&
          clientX <= rect.right + 5 &&
          clientY >= rect.top - 1 &&
          clientY <= rect.bottom + 1
        ) {
          const text = (el.textContent || '').trim()
          if (!el.classList.contains('ocr-span') || el.dataset.word === '1') {
            // Native fragment spans are precise — return immediately.
            // OCR word spans compete by center distance.
            if (el.dataset.word !== '1') return text
            const center = rect.left + rect.width / 2
            const dist = Math.abs(clientX - center)
            if (dist < bestDist) {
              bestDist = dist
              bestText = text
            }
          } else {
            // OCR line-span fallback: caret hit-testing
            const caretWord = getWordAtCaretPoint(clientX, clientY) ?? text
            return caretWord
          }
        }
      }
      return bestText
    },
    [],
  )

  /** Find highlight annotations that overlap a PDF-space point or rect */
  const findOverlappingHighlights = useCallback(
    (target: [number, number, number, number]) => {
      return pageAnnotations
        .filter((a) => a.annot_type === 'highlight')
        .filter((a) => {
          try {
            const r = JSON.parse(a.rect) as [number, number, number, number]
            return Array.isArray(r) && r.length === 4 && rectsOverlap(target, r)
          } catch { return false }
        })
    },
    [pageAnnotations],
  )

  // OCR word spans carry a trailing space ("word␣") so cross-word
  // selections keep the inter-word gaps — but a selection ending at a
  // word boundary then copies with a stray trailing space. Trim trailing
  // whitespace on native copy (interior spaces are preserved).
  const handleTextLayerCopy = useCallback((e: React.ClipboardEvent) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const text = selection.toString()
    if (text === text.trimEnd()) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', text.trimEnd())
  }, [])

  // Handle right-click on text layer → selection context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return // let browser show default menu

      e.preventDefault()
      e.stopPropagation()

      const pageEl = (e.target as HTMLElement).closest('[data-page-number]') as HTMLElement
      if (!pageEl) return

      const viewport = viewportRef.current

      // Exact word at the click position (client coordinates — the
      // hit-testing handles the layer's rotation transform)
      const clickedWord = getWordAtPosition(e.clientX, e.clientY) || ''

      const rects = selectionToPdfRects(selection, pageEl, viewport)
      const merged = mergeRects(rects.map((r) => r.rect))

      const overlapping = merged ? findOverlappingHighlights(merged) : []

      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        selectedText: selection.toString().trim().slice(0, 500),
        clickedWord,
        pageNumber,
        pdfRect: merged,
        overlappingAnnIds: overlapping.map((a) => a.id),
      })
    },
    [pageNumber, showContextMenu, findOverlappingHighlights, getWordAtPosition],
  )

  // Handle double-click on text layer → if over a highlight, select it and show actions
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const pageEl = (e.target as HTMLElement).closest('[data-page-number]') as HTMLElement
      if (!pageEl) return

      const pageRect = pageEl.getBoundingClientRect()
      const vx = e.clientX - pageRect.left
      const vy = e.clientY - pageRect.top

      const viewport = viewportRef.current
      const [px, py] = viewport.convertToPdfPoint(vx, vy)

      // Create a tiny rect around the click point for overlap detection
      const clickRect: [number, number, number, number] = [px - 1, py - 1, px + 1, py + 1]
      const overlapping = findOverlappingHighlights(clickRect)

      if (overlapping.length === 0) return // not on a highlight — let browser handle

      e.preventDefault()
      e.stopPropagation()

      // Collect the text content and rects from the overlapping highlights
      const mergedRects: Array<[number, number, number, number]> = []
      const contents: string[] = []
      for (const a of overlapping) {
        try {
          const r = JSON.parse(a.rect) as [number, number, number, number]
          if (Array.isArray(r) && r.length === 4) mergedRects.push(r)
        } catch {}
        if (a.content) contents.push(a.content)
      }
      const merged = mergeRects(mergedRects)

      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        selectedText: contents.join('; ') || '(highlight)',
        clickedWord: '',
        pageNumber,
        pdfRect: merged,
        overlappingAnnIds: overlapping.map((a) => a.id),
      })
    },
    [pageNumber, showContextMenu, findOverlappingHighlights],
  )

  /**
   * Run OCR on this page (scanned page or force-OCR mode).
   *
   * runOcrPageIfNeeded serializes jobs globally, dedups in-flight
   * requests (StrictMode double-effects / zoom changes during a run are
   * safe) and 'user' priority jumps ahead of background prefetch jobs.
   * On success it updates the store, which flips `cachedBoxes` and
   * re-runs renderPage → renderOcrTextLayer. Errors set the page status
   * to 'error' inside the job.
   */
  const runOcrForPage = useCallback(() => {
    if (!documentId) return
    runOcrPageIfNeeded(documentId, pageNumber, page, 'user').catch((err) => {
      console.error('[PdfPage] OCR failed:', err)
    })
  }, [documentId, pageNumber, page])

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
    viewportRef.current = viewport

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
      // Clear any OCR-layer rotation transform from a previous render
      // (renderOcrTextLayer re-applies it when the page is rotated).
      textLayerDiv.style.width = ''
      textLayerDiv.style.height = ''
      textLayerDiv.style.left = ''
      textLayerDiv.style.top = ''
      textLayerDiv.style.transform = ''
      textLayerDiv.style.transformOrigin = ''

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
        // OCR result (from store): render selectable spans from the
        // stored PDF-space bounding boxes. Layout happens in rotation-0
        // space; 90°/270° use vertical-writing spans laid out directly
        // in rotated space (browser vertical-text selection is exact,
        // CSS-rotated layers drop characters between highlight and copy).
        const viewport0 = page.getViewport({ scale: zoom, rotation: 0 })
        renderOcrTextLayer(textLayerDiv, cachedBoxes!, viewport0, viewport, debugTextLayer)
      } else {
        const textContent = await textContentPromise
        if (genRef.current !== gen) return

        // Scanned page (no embedded text) or force-OCR mode → PaddleOCR.
        // The text layer stays empty until the job completes; the store
        // update re-runs renderPage and takes the hasCached branch above.
        if (!hasEmbeddedText(textContent) || forceOcr) {
          if (pageStatus === 'idle') void runOcrForPage()
          return
        }

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
  }, [page, zoom, rotation, forceOcr, debugTextLayer, cachedBoxes, pageStatus, runOcrForPage])

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
      {documentId && (
        <AnnotationOverlay
          documentId={documentId}
          pageNumber={pageNumber}
          viewport={viewportRef.current}
        />
      )}
      <div
        ref={textLayerRef}
        className="pdf-text-layer absolute inset-0"
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onCopy={handleTextLayerCopy}
      />
    </div>
  )
})

export default PdfPage
