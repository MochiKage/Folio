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
  /** Rotation-0 viewport — spans are laid out in unrotated space. */
  viewport0: PageViewport,
  /** The displayed (rotated) viewport — used for 90°/270° layouts. */
  viewportRot: PageViewport,
  debug = false,
): void {
  container.innerHTML = ''

  const rot = ((viewportRot.rotation % 360) + 360) % 360
  if (rot === 180) {
    // 180°: lay out in rotation-0 space and flip the whole layer about
    // its center — the canvas has the same dimensions, and horizontal
    // selection keeps working at 180°.
    const w0 = viewport0.width
    const h0 = viewport0.height
    container.style.width = `${w0}px`
    container.style.height = `${h0}px`
    container.style.left = '0px'
    container.style.top = '0px'
    container.style.transform = 'rotate(180deg)'
    container.style.transformOrigin = 'center'
  } else {
    // 0°: plain layout. 90°/270°: vertical-writing spans laid out
    // DIRECTLY in rotated space (no container rotation) — the browser's
    // native vertical-text selection maps drags and ranges exactly,
    // whereas selecting inside a CSS-rotated container drops characters
    // between the highlight and the copied text.
    container.style.width = ''
    container.style.height = ''
    container.style.left = ''
    container.style.top = ''
    container.style.transform = ''
    container.style.transformOrigin = ''
  }

  if (boxes.length === 0) {
    console.warn('[OCR] renderOcrTextLayer: 0 boxes to render')
    return
  }

  const vertical = rot === 90 || rot === 270
  for (const box of boxes) {
    if (vertical) {
      renderVerticalLine(container, box, viewportRot, debug, rot)
      continue
    }
    const hasTight =
      (box.tx0 ?? 0) < (box.tx1 ?? 0) && (box.ty0 ?? 0) < (box.ty1 ?? 0)
    const hasChars = (box.chars?.length ?? 0) > 0 && box.chars!.length === box.text.length
    if (hasTight && hasChars) {
      renderWordSpans(container, box, viewport0, debug)
    } else {
      renderLineSpan(container, box, viewport0, debug)
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
  /** Vertical-writing-mode span (90°/270° rotation) */
  vertical = false,
  /** Flip for 270° (text flows bottom-to-top) */
  flip = false,
  /** Tilt angle in degrees (display clockwise-positive) — the span
   *  rotates with skewed text. */
  tilt = 0,
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
  if (!vertical) span.style.lineHeight = `${Math.max(height, 1)}px`
  span.style.position = 'absolute'
  if (vertical) {
    // Vertical flow: the word runs top-to-bottom (90°) / flipped for
    // 270° — glyph orientation matches the page's rotation.
    span.style.writingMode = 'vertical-rl'
    if (flip) {
      span.style.transform = 'rotate(180deg)'
      span.style.transformOrigin = 'center'
    }
  }
  if (debug) {
    // Debug: the text stays transparent (it is rendered with a browser
    // font fitted into the box, so it never matches the page's own
    // glyphs — showing it invites false "misalignment" reports). The
    // selection highlight still covers the fitted glyphs; the TRUE
    // boundary is drawn on a separate non-transformed element below.
    span.style.color = 'transparent'
  }
  container.appendChild(span)

  // Fit the browser-font text to the box with letter-spacing, NOT
  // scaleX: letter-spacing is part of layout, so the selection highlight
  // covers the fitted text exactly. Chromium does not reflect CSS scale
  // transforms in selection-highlight painting — stretched text left
  // gaps between the highlight and the box (bold/large text where the
  // browser font is narrower than the page font).
  const range = document.createRange()
  range.selectNodeContents(span)
  const rect = range.getBoundingClientRect()
  const natural = vertical ? rect.height : rect.width
  const boxLen = vertical ? height : width
  if (natural > 0 && boxLen > 0) {
    if (text.length > 1) {
      // n-1 gaps between n glyphs (the trailing space included)
      const spacing = (boxLen - natural) / (text.length - 1)
      span.style.letterSpacing = `${spacing}px`
    } else {
      // Single glyph: letter-spacing has no effect — fall back to a
      // scale along the flow direction (highlight may lag here).
      const k = Math.min(Math.max(boxLen / natural, 0.3), 3.0)
      const scale = vertical ? `scaleY(${k})` : `scaleX(${k})`
      span.style.transform = flip ? `rotate(180deg) ${scale}` : scale
    }
  }

  // Tilt with the text on skewed pages (rotates about the span center).
  if (tilt && text.length > 1) {
    span.style.transform = `rotate(${tilt}deg)`
  }

  if (debug) {
    // True boundary outline on a separate, non-transformed element —
    // an outline on the span itself would be stretched by the scaleX
    // above and misrepresent the word boundary.
    const box = document.createElement('div')
    box.className = 'ocr-debug-box'
    box.style.position = 'absolute'
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    box.style.width = `${Math.max(width, 1)}px`
    box.style.height = `${Math.max(height, 1)}px`
    box.style.outline = '1px dashed rgba(255, 0, 0, 0.45)'
    box.style.pointerEvents = 'none'
    if (tilt) box.style.transform = `rotate(${tilt}deg)`
    container.appendChild(box)
  }
  return span
}

interface WordRect {
  text: string
  /** Word extent in PDF pt (y-range = the line's anchor band) */
  rect: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * Split a box into per-word PDF-space rects. Returns null when the box
 * lacks per-word data (tight box + char emissions) — the caller falls
 * back to a whole-line span.
 *
 * Word x-extents come from `word_bounds` (pixel-gap evidence) when
 * available; otherwise the CTC peak-midpoint scheme mapped through the
 * calibrated anchor margins (mL=0.30em, mR=0.05em — the tight box is a
 * shrunken view of the glyphs, the 0.3 contour starts late on thin
 * strokes like "T"). Margins are relative to the em-equivalent
 * inkH × 1.27, matching the rendered font size.
 */
function extractWordRects(box: OcrBox): WordRect[] | null {
  const text = box.text
  const n = text.length
  if (n === 0) return null
  const hasTight =
    (box.tx0 ?? 0) < (box.tx1 ?? 0) && (box.ty0 ?? 0) < (box.ty1 ?? 0)
  const hasChars = (box.chars?.length ?? 0) > 0 && box.chars!.length === n
  if (!hasTight || !hasChars) return null

  const tx0 = box.tx0!
  const ty0 = box.ty0!
  const tx1 = box.tx1!
  const ty1 = box.ty1!
  const tightW = tx1 - tx0
  const inkH = box.line_h && box.line_h > 0 ? box.line_h : ty1 - ty0
  const em = inkH * 1.27
  const mL = em * 0.3
  const mR = em * 0.05
  const mY = em * 0.1
  const rectY0 = ty0 - mY
  const rectY1 = ty1 + mY

  // Word boundaries from pixel evidence: gaps in the detection mask
  // locate the words directly (v4 caches).
  const wb = box.word_bounds
  const hasWb =
    !!wb && wb.length === text.split(/\s+/).filter((s) => s.length > 0).length

  // Character boundaries = midpoints between adjacent emission PEAKS.
  // Averaging adjacent noisy estimates is statistically the most stable
  // boundary available (vs raw first-emission edges used previously).
  const chars = box.chars!
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
  const anchorL = tx0 - mL
  const anchorW = tightW + mL + mR
  const xAt = (f: number) => anchorL + ((f - b0) / bSpan) * anchorW

  const words: WordRect[] = []
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
    const x0 = hasWb ? tx0 + wb![w][0] * tightW : xAt(boundaries[i])
    const x1 = hasWb ? tx0 + wb![w][1] * tightW : xAt(boundaries[j + 1])
    words.push({ text: wordText, rect: { x0, y0: rectY0, x1, y1: rectY1 } })
    i = j + 1
    w++
  }
  return words
}

/**
 * Word-level rendering (preferred): each word gets its own span placed
 * by `extractWordRects` (pixel-gap evidence, CTC midpoints as fallback).
 */
function renderWordSpans(
  container: HTMLDivElement,
  box: OcrBox,
  viewport: PageViewport,
  debug: boolean,
): void {
  const words = extractWordRects(box)
  if (!words) {
    renderLineSpan(container, box, viewport, debug)
    return
  }
  const { height } = pdfRectToViewport(viewport, box)
  const scalePxPerPt = height / Math.max(box.y1 - box.y0, 1e-6)
  const inkH = box.line_h && box.line_h > 0 ? box.line_h : box.ty1! - box.ty0!
  const fontSize = inkH * 1.27 * scalePxPerPt
  // Expand the hit region generously (CTC boundary noise is ±0.25em).
  // In debug mode the outline shows the TRUE pixel-gap span instead.
  const pad = debug ? 0 : fontSize * 0.25
  const tilt = box.angle ?? 0
  for (const w of words) {
    const r = pdfRectToViewport(viewport, w.rect)
    if (Math.abs(tilt) < 0.05) {
      createFittedSpan(
        container,
        w.text,
        r.left - pad,
        r.top,
        r.width + 2 * pad,
        r.height,
        fontSize,
        debug,
        true,
      )
    } else {
      // Tilted line: the tight box is the drift band whose mid-y sits on
      // the line at every x. Center a word-height box at the word's
      // axis-aligned center and rotate it with the line so the span hugs
      // the tilted glyphs.
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const wd = r.width + 2 * pad
      const h = fontSize * 1.2
      createFittedSpan(
        container,
        w.text,
        cx - wd / 2,
        cy - h / 2,
        wd,
        h,
        fontSize,
        debug,
        true,
        false,
        false,
        tilt,
      )
    }
  }
}

/**
 * 90°/270° rotation: render words as vertical-writing-mode spans laid
 * out DIRECTLY in rotated space (no container rotation). The browser's
 * native vertical-text selection maps drags and ranges exactly, whereas
 * selecting inside a CSS-rotated container loses characters between the
 * highlight and the copied text.
 */
function renderVerticalLine(
  container: HTMLDivElement,
  box: OcrBox,
  viewportRot: PageViewport,
  debug: boolean,
  rot: number,
): void {
  const words = extractWordRects(box)
  const items: WordRect[] = words
    ? words
    : [{ text: box.text, rect: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 } }]
  const inkH = box.line_h && box.line_h > 0 ? box.line_h : box.ty1! - box.ty0!
  const fontSize = Math.max(inkH * 1.27 * viewportRot.scale, 6)
  const pad = debug ? 0 : fontSize * 0.25

  for (const w of items) {
    const r = pdfRectToViewport(viewportRot, w.rect)
    createFittedSpan(
      container,
      w.text,
      r.left,
      r.top - pad,
      r.width,
      r.height + 2 * pad,
      fontSize,
      debug,
      !!words,
      true, // vertical
      rot === 270, // flip for 270°
    )
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
  /** Raw RGB pixels (width*height*3 bytes, row-major) */
  pixels: Uint8Array
  width: number
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

  // Raw RGB transfer: the PNG encode/decode round trip costs ~2s/page in
  // debug builds (the Rust-side PNG decode alone was 2.2s at 300 DPI).
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const src = imgData.data
  const pixels = new Uint8Array(canvas.width * canvas.height * 3)
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    pixels[j] = src[i]
    pixels[j + 1] = src[i + 1]
    pixels[j + 2] = src[i + 2]
  }

  return {
    pixels,
    width: canvas.width,
    height: canvas.height,
    viewBox: viewport.viewBox as [number, number, number, number],
  }
}
