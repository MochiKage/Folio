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
  box: { x0: number; y0: number; x1: number; y1: number },
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
    const hasTight =
      (box.tx0 ?? 0) < (box.tx1 ?? 0) && (box.ty0 ?? 0) < (box.ty1 ?? 0)
    const hasChars = (box.chars?.length ?? 0) > 0 && box.chars!.length === box.text.length
    if (hasTight && hasChars) {
      renderWordSpans(container, box, viewport, debug)
    } else {
      renderLineSpan(container, box, viewport, debug)
    }
  }
}

// ─── OCR text layer rendering ────────────────────

/**
 * Create an ocr-span for a piece of text inside a box region, fitting the
 * rendered glyphs to the region (scaleX when overflowing, centering when
 * narrower — the region margins are symmetric around the image glyphs).
 */
function createFittedSpan(
  container: HTMLDivElement,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fontSize: number,
  debug: boolean,
  isWord: boolean,
): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'ocr-span'
  if (isWord) span.dataset.word = '1'
  span.textContent = text
  span.style.left = `${left}px`
  span.style.top = `${top}px`
  span.style.width = `${Math.max(width, 1)}px`
  span.style.height = `${Math.max(height, 1)}px`
  span.style.fontSize = `${Math.max(fontSize, 6)}px`
  span.style.lineHeight = `${Math.max(height, 1)}px`
  span.style.position = 'absolute'
  if (debug) {
    span.style.color = 'rgba(255, 0, 0, 0.5)'
    span.style.outline = '1px dashed rgba(255, 0, 0, 0.3)'
  }
  container.appendChild(span)

  const range = document.createRange()
  range.selectNodeContents(span)
  const textWidth = range.getBoundingClientRect().width
  if (textWidth > 0 && width > 0) {
    if (textWidth > width) {
      const scaleX = Math.min(Math.max(width / textWidth, 0.3), 3.0)
      span.style.transform = `scaleX(${scaleX})`
    } else {
      span.style.transform = `translateX(${(width - textWidth) / 2}px)`
    }
  }
  return span
}

/**
 * Word-level rendering (preferred): each word gets its own span. Primary
 * placement comes from `word_bounds` — word gaps located in the DETECTION
 * mask's column profile (pixel evidence, no CTC timing involved). Lines
 * whose gap structure is ambiguous fall back to the CTC peak-midpoint
 * scheme (`chars`), which is immune to browser font-metric drift but
 * accumulates per-word error on variable-width glyphs.
 */
function renderWordSpans(
  container: HTMLDivElement,
  box: OcrBox,
  viewport: PageViewport,
  debug: boolean,
): void {
  const { height } = pdfRectToViewport(viewport, box)
  const tight = pdfRectToViewport(viewport, {
    x0: box.tx0!,
    y0: box.ty0!,
    x1: box.tx1!,
    y1: box.ty1!,
  })
  const scalePxPerPt = height / Math.max(box.y1 - box.y0, 1e-6)
  const tightH = box.ty1! - box.ty0!
  const fontSize = tightH * 1.27 * scalePxPerPt

  // The tight box (DB mask extent) is a *shrunken* view of the glyphs.
  // Calibrated at 300 DPI with the peak-midpoint boundary scheme:
  // the left edge needs a larger margin than the right (the 0.3 contour
  // starts late on thin strokes like "T"). Sweep result: mL=0.30em,
  // mR=0.05em → word boundary errors ≤ 10px (≈0.25 char).
  const mL = fontSize * 0.3
  const mR = fontSize * 0.05
  const mY = fontSize * 0.1
  const anchor = {
    left: tight.left - mL,
    top: tight.top - mY,
    width: tight.width + mL + mR,
    height: tight.height + 2 * mY,
  }

  const text = box.text
  const chars = box.chars!
  const n = text.length
  if (n === 0) return

  // Word boundaries from pixel evidence (v2 caches): gaps in the
  // detection mask locate the words directly.
  const wb = box.word_bounds
  const hasWb =
    !!wb && wb.length === text.split(/\s+/).filter((s) => s.length > 0).length

  // Character boundaries = midpoints between adjacent emission PEAKS.
  // Averaging adjacent noisy estimates is statistically the most stable
  // boundary available (vs raw first-emission edges used previously).
  const boundaries: number[] = new Array(n + 1)
  if (n === 1) {
    boundaries[0] = chars[0] - 0.5
    boundaries[1] = chars[0] + 0.5
  } else {
    boundaries[0] = chars[0] - (chars[1] - chars[0]) / 2
    for (let k = 1; k < n; k++) {
      boundaries[k] = (chars[k - 1] + chars[k]) / 2
    }
    boundaries[n] = chars[n - 1] + (chars[n - 1] - chars[n - 2]) / 2
  }
  const b0 = boundaries[0]
  const bSpan = Math.max(boundaries[n] - b0, 1e-6)
  const xAt = (f: number) => anchor.left + ((f - b0) / bSpan) * anchor.width

  let i = 0
  let w = 0
  while (i < n) {
    // skip whitespace between words
    while (i < n && /\s/.test(text[i])) i++
    if (i >= n) break
    let j = i
    while (j + 1 < n && !/\s/.test(text[j + 1])) j++
    // Trailing space joins the word so cross-word selection keeps spaces
    const wordText = text.slice(i, j + 1) + (j + 1 < n ? ' ' : '')
    const wordLeft = hasWb
      ? tight.left + wb![w][0] * tight.width
      : xAt(boundaries[i])
    const wordRight = hasWb
      ? tight.left + wb![w][1] * tight.width
      : xAt(boundaries[j + 1])
    // Expand the hit region generously (CTC boundary noise is ±0.25em);
    // the rendered glyphs stay centered inside, so expanded margins only
    // make clicking more forgiving. Adjacent spans overlap in the margins,
    // and getWordAtPosition picks the nearest-center word on a hit.
    const pad = fontSize * 0.25
    createFittedSpan(
      container,
      wordText,
      wordLeft - pad,
      anchor.top,
      wordRight - wordLeft + 2 * pad,
      anchor.height,
      fontSize,
      debug,
      true,
    )
    i = j + 1
    w++
  }
}

/**
 * Line-level fallback (stale caches without per-char emission data):
 * render the whole line in one span, centered in the padded box.
 */
function renderLineSpan(
  container: HTMLDivElement,
  box: OcrBox,
  viewport: PageViewport,
  debug: boolean,
): void {
  const { left, top, width, height } = pdfRectToViewport(viewport, box)
  const fontSize = height * 0.85
  createFittedSpan(container, box.text, left, top, width, height, fontSize, debug, false)
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
