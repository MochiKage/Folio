import type { PageViewport } from 'pdfjs-dist'

/**
 * Convert a DOM Selection to PDF-space rectangles.
 *
 * The text layer spans are absolutely positioned in viewport coordinates.
 * We collect all client rects from the selection, map them back to PDF
 * space via viewport.convertToPdfPoint(), and optionally merge adjacent
 * rects into a single bounding box.
 *
 * Returns an array of [x0, y0, x1, y1] in PDF user-space coordinates.
 */
export function selectionToPdfRects(
  selection: Selection,
  pageElement: HTMLElement,
  viewport: PageViewport,
): Array<{ rect: [number, number, number, number]; text: string }> {
  if (selection.isCollapsed || selection.rangeCount === 0) return []

  const pageRect = pageElement.getBoundingClientRect()
  const range = selection.getRangeAt(0)
  const clientRects = Array.from(range.getClientRects())

  return clientRects
    .map((cr) => {
      // Convert client-space rect to viewport-space (relative to page element)
      const vx0 = cr.left - pageRect.left
      const vy0 = cr.top - pageRect.top
      const vx1 = cr.right - pageRect.left
      const vy1 = cr.bottom - pageRect.top

      // Convert viewport coordinates to PDF user-space
      const [px0, py0] = viewport.convertToPdfPoint(vx0, vy0)
      const [px1, py1] = viewport.convertToPdfPoint(vx1, vy1)

      return {
        rect: [px0, py0, px1, py1] as [number, number, number, number],
        text: '',
      }
    })
    .filter((r) => {
      const [x0, y0, x1, y1] = r.rect
      return Math.abs(x1 - x0) > 0.5 || Math.abs(y1 - y0) > 0.5
    })
}

/**
 * Get the word under the current cursor / selection.
 * If there's a non-collapsed selection, returns the selected text.
 * Otherwise, expands the caret to the nearest word boundary.
 */
export function getWordAtSelection(): string {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return ''

  if (!selection.isCollapsed) {
    return selection.toString().trim()
  }

  // Try to expand to word boundary
  const range = selection.getRangeAt(0)
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return ''

  const text = range.startContainer.textContent || ''
  let start = range.startOffset
  let end = range.startOffset

  // Expand backward
  while (start > 0 && /\w/.test(text[start - 1])) start--
  // Expand forward
  while (end < text.length && /\w/.test(text[end])) end++

  return text.slice(start, end).trim()
}

/**
 * Get the exact word at a client-space point using the browser's caret
 * hit-testing (caretPositionFromPoint) and word-boundary expansion.
 *
 * Unlike span-level hit-testing, this returns the *word* under the cursor
 * even when one span contains a whole text line — which is how OCR text
 * layers are rendered (one `.ocr-span` per recognized box).
 *
 * Temporarily moves the DOM selection; the previous selection is saved and
 * restored before returning, so callers can still read it afterwards.
 */
export function getWordAtCaretPoint(x: number, y: number): string | null {
  const sel = window.getSelection()
  if (!sel) return null

  // Save the current selection (cloned ranges survive removeAllRanges)
  const saved: Range[] = []
  for (let i = 0; i < sel.rangeCount; i++) {
    saved.push(sel.getRangeAt(i).cloneRange())
  }

  try {
    let range: Range | null = null
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y)
      if (pos) {
        range = document.createRange()
        range.setStart(pos.offsetNode, pos.offset)
        range.collapse(true)
      }
    } else {
      // Safari/old-WebKit fallback
      const doc = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
      }
      range = doc.caretRangeFromPoint?.(x, y) ?? null
    }
    if (!range) return null

    sel.removeAllRanges()
    sel.addRange(range)
    // Select the enclosing word: move the caret to the word start, then
    // extend forward to its end ([click] → [wordStart] → [wordStart, wordEnd]).
    // Note: extend-backward + extend-forward does NOT work — after the
    // backward extend the focus sits at the word start and a forward extend
    // only returns it to the click position.
    sel.modify('move', 'backward', 'word')
    sel.modify('extend', 'forward', 'word')
    return sel.toString().trim() || null
  } catch {
    return null
  } finally {
    // Restore the user's selection
    sel.removeAllRanges()
    for (const r of saved) {
      sel.addRange(r)
    }
  }
}

/**
 * Merge multiple PDF-space rectangles into a single bounding box.
 */
export function mergeRects(
  rects: Array<[number, number, number, number]>,
): [number, number, number, number] | null {
  if (rects.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [rx0, ry0, rx1, ry1] of rects) {
    if (rx0 < x0) x0 = rx0
    if (ry0 < y0) y0 = ry0
    if (rx1 > x1) x1 = rx1
    if (ry1 > y1) y1 = ry1
  }
  return [x0, y0, x1, y1]
}

/**
 * Check if two PDF-space rectangles overlap.
 * Handles inverted Y-axis from convertToPdfPoint (PDF Y-up vs screen Y-down).
 */
export function rectsOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  const ax0 = Math.min(a[0], a[2]), ax1 = Math.max(a[0], a[2])
  const ay0 = Math.min(a[1], a[3]), ay1 = Math.max(a[1], a[3])
  const bx0 = Math.min(b[0], b[2]), bx1 = Math.max(b[0], b[2])
  const by0 = Math.min(b[1], b[3]), by1 = Math.max(b[1], b[3])
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0
}

/**
 * Generate a simple unique ID for annotations, bookmarks, etc.
 * Uses crypto.randomUUID() when available (WebView2 / modern browsers).
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}
