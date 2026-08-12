import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'
import type { OcrBox } from './api'

/** DPI used when rendering a page for OCR input (pixels per inch) */
export const OCR_DPI = 300

// ─── Matrix math (replicating pdfjsLib.Util.transform) ───

function multiplyTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export function pdfRectToViewport(
  viewport: PageViewport,
  box: OcrBox,
): { left: number; top: number; width: number; height: number } {
  const [blX, blY] = viewport.convertToViewportPoint(box.x0, box.y0)
  const [trX, trY] = viewport.convertToViewportPoint(box.x1, box.y1)

  const left = Math.min(blX, trX)
  const top = Math.min(blY, trY)
  const width = Math.abs(trX - blX)
  const height = Math.abs(trY - blY)

  return { left, top, width, height }
}

// ─── Debug text layer (synthetic, PDF.js-compatible positioning) ───

interface TextSpan {
  item: { str: string; width?: number; fontName?: string }
  tx: number[]
  fontHeight: number
  fontAscent: number
  lineTop: number   // top of glyph in viewport px
  baseline: number  // baseline y in viewport px — same for all items on one line
}

export function renderDebugTextLayer(
  container: HTMLDivElement,
  textContent: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: PageViewport,
): void {
  container.innerHTML = ''

  const vpT = viewport.transform as number[]
  const pageW = viewport.width
  const pageH = viewport.height

  const ascentCache = new Map<string, number>()
  const getAscent = (fontName: string): number => {
    const cached = ascentCache.get(fontName)
    if (cached !== undefined) return cached
    const v = /serif|times/i.test(fontName) ? 0.82 : 0.8
    ascentCache.set(fontName, v)
    return v
  }

  // Build transformed spans
  const spans: TextSpan[] = []
  for (const item of textContent.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const tx = multiplyTransform(vpT, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    const fontAscent = fontHeight * getAscent(item.fontName ?? '')
    spans.push({
      item: item as TextSpan['item'],
      tx, fontHeight, fontAscent,
      lineTop: tx[5] - fontAscent,    // top of glyph
      baseline: tx[5],                 // baseline y in viewport px
    })
  }

  // Sort by baseline (primary) then left-to-right (secondary).
  // Baseline is the same for ALL items on the same visual line,
  // regardless of font size or style differences.
  spans.sort((a, b) => {
    const dy = a.baseline - b.baseline
    if (Math.abs(dy) > 1) return dy > 0 ? 1 : -1
    return a.tx[4] - b.tx[4]
  })

  // Group into lines by baseline proximity.
  // 2 px tolerance — handles imprecise PDF baseline positioning without
  // merging distinct lines (minimum line spacing is ~10px at typical zoom).
  const BASELINE_TOLERANCE = 2
  const lines: TextSpan[][] = []
  for (const s of spans) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(s.baseline - last[0].baseline) < BASELINE_TOLERANCE) {
      last.push(s)
    } else {
      lines.push([s])
    }
  }

  for (const line of lines) {
    line.sort((a, b) => a.tx[4] - b.tx[4])
    const lineTop = Math.min(...line.map((s) => s.lineTop))
    const lineLeft = line[0].tx[4]
    const lineRight = line[line.length - 1].tx[4]

    const lineDiv = document.createElement('div')
    lineDiv.className = 'ocr-line'
    lineDiv.style.position = 'absolute'
    lineDiv.style.left = `${lineLeft.toFixed(2)}px`
    lineDiv.style.top = `${lineTop.toFixed(2)}px`
    // Set explicit width so inline spans can use pixel margins
    lineDiv.style.width = `${(lineRight - lineLeft + 100).toFixed(0)}px`
    lineDiv.style.whiteSpace = 'nowrap'
    lineDiv.style.pointerEvents = 'auto'

    for (const s of line) {
      const span = document.createElement('span')
      span.className = 'ocr-span'
      span.textContent = s.item.str
      span.style.display = 'inline'
      span.style.position = 'static'
      span.style.fontSize = `${s.fontHeight.toFixed(2)}px`

      // Exact pixel offset from line start
      const offsetPx = s.tx[4] - lineLeft
      if (offsetPx > 0.5) {
        span.style.marginLeft = `${offsetPx.toFixed(2)}px`
      }

      lineDiv.appendChild(span)
    }

    container.appendChild(lineDiv)
  }

  console.log(`[OCR] renderDebugTextLayer: ${spans.length} spans in ${lines.length} lines, page=${pageW.toFixed(0)}×${pageH.toFixed(0)} scale=${viewport.scale}`)
}

// ─── Real OCR rendering (Phase 3) ───

export function renderOcrTextLayer(
  container: HTMLDivElement,
  boxes: OcrBox[],
  viewport: PageViewport,
  debug = false,
): void {
  container.innerHTML = ''

  if (boxes.length === 0) {
    console.warn('[OCR] renderOcrTextLayer: 0 boxes to render')
    return
  }

  for (const box of boxes) {
    const { left, top, width, height } = pdfRectToViewport(viewport, box)
    const span = document.createElement('span')
    span.className = 'ocr-span'
    span.textContent = box.text
    span.style.left = `${left}px`
    span.style.top = `${top}px`
    span.style.width = `${Math.max(width, 1)}px`
    span.style.height = `${Math.max(height, 1)}px`
    span.style.fontSize = `${Math.max(height * 0.85, 6)}px`
    span.style.position = 'absolute'
    if (debug) {
      span.style.color = 'rgba(255, 0, 0, 0.5)'
      span.style.outline = '1px dashed rgba(255, 0, 0, 0.3)'
    }
    container.appendChild(span)
  }
}

// ─── OCR page rendering (Phase 3) ───

export async function renderPageForOcr(
  page: PDFPageProxy,
  dpi: number = OCR_DPI,
): Promise<{
  bytes: Uint8Array
  height: number
  viewBox: [number, number, number, number]
}> {
  const scale = dpi / 72
  const viewport = page.getViewport({ scale, rotation: 0 })

  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvas, viewport }).promise

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    ),
  )
  const bytes = new Uint8Array(await blob.arrayBuffer())

  return {
    bytes,
    height: viewport.height,
    viewBox: viewport.viewBox as [number, number, number, number],
  }
}
