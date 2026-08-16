import type { PDFPageProxy } from 'pdfjs-dist'
import type { OcrBox } from './api'
import { extractWordRects } from './ocr'
import { scriptCategory, type TextContent } from './textLayer'

/** A text-bearing content item (pdf.js TextItem) — items without `str`
 *  are marked-content markers. */
type PageTextItem = Extract<TextContent['items'][number], { str: string }>

/**
 * Full-text search matching on the frontend side. Covers the two text
 * sources the Rust backend can't see:
 *   - embedded-text pages: PDF.js getTextContent items
 *   - live OCR results: OcrBox[] from runOcrPageIfNeeded
 * (OCR-cache pages are searched by the Rust command `search_document`.)
 */

/** Highlight rect in PDF space (y-up) — converted to viewport px at
 *  render time, so zoom/rotation are handled by the viewport transform. */
export interface SearchRect { x0: number; y0: number; x1: number; y1: number }

export interface PageResult {
  page: number
  source: 'ocr-cached' | 'embedded' | 'ocr-live'
  snippet: string
  /** 0 for ocr-cached pages until their boxes load in the store. */
  matchCount: number
  /** Match rects in text order (empty for ocr-cached pages — the overlay
   *  computes them from store boxes once they arrive). */
  rects: SearchRect[]
}

export interface MatchResult {
  rects: SearchRect[]
  matchCount: number
  snippet: string
}

const SNIPPET_WINDOW = 40

// ─── Session text-content cache ────────────────────
// Shared with PdfPage: page renders and the search classification pass
// reuse one getTextContent result per page instead of re-parsing.

const textContentCache = new Map<string, TextContent>()

function cacheKey(docId: string, pageNum: number): string {
  return `${docId}:${pageNum}`
}

export async function getEmbeddedPageText(
  docId: string,
  pageNum: number,
  page: PDFPageProxy,
): Promise<TextContent> {
  const key = cacheKey(docId, pageNum)
  const hit = textContentCache.get(key)
  if (hit) return hit
  const tc = await page.getTextContent()
  textContentCache.set(key, tc)
  return tc
}

export function clearEmbeddedTextCache(docId: string): void {
  const prefix = `${docId}:`
  for (const k of textContentCache.keys()) {
    if (k.startsWith(prefix)) textContentCache.delete(k)
  }
}

// ─── Case-insensitive normalization ────────────────
// Char-by-char toLowerCase keeps a 1:1 norm-index → item-index mapping.
// Characters whose folded form isn't exactly one code unit (e.g. 'İ' →
// 'i̇') are skipped so the mapping stays valid — matches can't start at
// those positions, which is fine for English academic text.

function isTextItem(
  it: TextContent['items'][number],
): it is PageTextItem {
  return 'str' in it
}

interface NormalizedPage {
  /** Lowercased concatenation of all item strings. */
  norm: string
  /** norm index → item index in `items`. */
  itemIdx: Uint32Array
  /** norm index → char offset (UTF-16 units) inside the item's str. */
  charOff: Uint32Array
  items: PageTextItem[]
}

function buildNormalized(tc: TextContent): NormalizedPage | null {
  const items: PageTextItem[] = []
  const itemIdx: number[] = []
  const charOff: number[] = []
  let norm = ''
  for (const it of tc.items) {
    if (!isTextItem(it) || !it.str) continue
    const itemIndex = items.length
    items.push(it)
    const str = it.str
    // Iterate UTF-16 units (not code points) so charOff maps directly
    // into item.str indices — used for sub-item rect slicing.
    for (let k = 0; k < str.length; k++) {
      const lowered = str[k].toLowerCase()
      if (lowered.length === 1) {
        norm += lowered
        itemIdx.push(itemIndex)
        charOff.push(k)
      }
    }
  }
  if (items.length === 0) return null
  return {
    norm,
    itemIdx: Uint32Array.from(itemIdx),
    charOff: Uint32Array.from(charOff),
    items,
  }
}

/** AABB of an item's glyph band in PDF space, from its text transform.
 *
 *  The transform maps TEXT space → user space with the font scale baked
 *  in (t[0]/t[1] = advance direction × font size, t[2]/t[3] = ascent
 *  direction × font size), and `item.width` is ALREADY in user space.
 *  So: walk along the UNIT direction vectors and add the user-space
 *  band offsets directly — multiplying by the raw scale components
 *  again (the original bug) blew rects up by the font size and sent
 *  them far off their text. */
function itemSubRect(it: PageTextItem, o0: number, o1: number): SearchRect {
  const t = it.transform
  const h = Math.hypot(t[2], t[3]) || 8
  const w = it.width ?? it.str.length * h * 0.5
  const len = Math.max(it.str.length, 1)
  // Char range [o0, o1) → proportional slice along the text axis.
  const f0 = o0 / len
  const f1 = o1 / len
  // Unit direction vectors in user space.
  const ux = t[0] / h
  const uy = t[1] / h
  const vx = t[2] / h
  const vy = t[3] / h
  const yB = -0.25 * h
  const yT = 0.75 * h
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [f, off] of [[f0, yB], [f1, yB], [f0, yT], [f1, yT]] as const) {
    const x = ux * (w * f) + vx * off + t[4]
    const y = uy * (w * f) + vy * off + t[5]
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1 }
}

/** Cap highlight rects per page — a common query can hit hundreds of
 *  times per page; rendering all of them lags zoom/resize. */
const MAX_HIGHLIGHT_RECTS = 200

/** Case-insensitive substring match across all text items of a page.
 *  MVP rect granularity = the whole item's bounding box (CJK items can
 *  be a full line); a phrase spanning items yields the union of the
 *  involved item rects. */
export function matchEmbedded(query: string, tc: TextContent): MatchResult {
  const q = query.toLowerCase()
  const np = buildNormalized(tc)
  if (!np || q.length === 0) return { rects: [], matchCount: 0, snippet: '' }

  const rects: SearchRect[] = []
  let count = 0
  let from = 0
  while (true) {
    const i = np.norm.indexOf(q, from)
    if (i < 0) break
    count++
    from = i + Math.max(q.length, 1)
    const end = Math.min(i + q.length, np.norm.length)
    // Per-item char ranges covered by this occurrence → sub-item rects
    // (char-proportional), so a whole-line item highlights only the
    // matched word instead of the entire line.
    const spans = new Map<number, { min: number; max: number }>()
    for (let k = i; k < end; k++) {
      const idx = np.itemIdx[k]
      const off = np.charOff[k]
      const s = spans.get(idx)
      if (s) {
        s.min = Math.min(s.min, off)
        s.max = Math.max(s.max, off)
      } else {
        spans.set(idx, { min: off, max: off })
      }
    }
    for (const [idx, s] of spans) {
      rects.push(itemSubRect(np.items[idx], s.min, s.max + 1))
    }
  }
  if (rects.length > MAX_HIGHLIGHT_RECTS) rects.length = MAX_HIGHLIGHT_RECTS
  return { rects, matchCount: count, snippet: makeEmbeddedSnippet(q, tc) }
}

/** Flowing text of all items with script-aware joins (Latin gets a
 *  space, CJK none), whitespace collapsed for display, windowed around
 *  the first match. */
function makeEmbeddedSnippet(q: string, tc: TextContent): string {
  let flow = ''
  let prevLast = ''
  for (const it of tc.items) {
    if (!isTextItem(it) || !it.str) continue
    const s = it.str
    if (flow) {
      const prev = prevLast || ' '
      const next = s.trimStart()[0] ?? ' '
      const prevCat = scriptCategory(prev.codePointAt(0)!)
      const nextCat = scriptCategory(next.codePointAt(0)!)
      if (prevCat !== 'no-space' && nextCat !== 'no-space') flow += ' '
    }
    flow += s
    prevLast = s.trimEnd().slice(-1)
  }
  const collapsed = flow.replace(/\s+/g, ' ')
  const i = collapsed.toLowerCase().indexOf(q)
  if (i < 0) return collapsed.slice(0, SNIPPET_WINDOW * 2)
  return windowAround(collapsed, i, i + q.length)
}

// ─── OCR boxes matching ────────────────────────────

/**
 * Case-insensitive match over one page's OCR boxes (line texts joined
 * with '\n', same shape as ocr_cache.text). Match spans are mapped to
 * word rects via extractWordRects; stale-format boxes (no word data)
 * fall back to the whole padded box so "a hit always has a rect".
 */
export function matchInOcrBoxes(query: string, boxes: OcrBox[]): MatchResult {
  const q = query.toLowerCase()
  const rects: SearchRect[] = []
  let count = 0
  const lines: string[] = []
  let first: { line: number; start: number } | null = null

  for (const box of boxes) {
    const lower = box.text.toLowerCase()
    let from = 0
    while (true) {
      const i = lower.indexOf(q, from)
      if (i < 0) break
      count++
      if (first === null) first = { line: lines.length, start: i }
      from = i + Math.max(q.length, 1)
      rects.push(...matchRectsInBox(box, i, i + q.length))
    }
    lines.push(box.text)
  }

  let snippet = ''
  if (first) {
    const joined = lines.join('\n')
    const offset =
      lines.slice(0, first.line).reduce((n, l) => n + l.length + 1, 0) +
      first.start
    snippet = windowAround(joined, offset, offset + q.length)
  }
  if (rects.length > MAX_HIGHLIGHT_RECTS) rects.length = MAX_HIGHLIGHT_RECTS
  return { rects, matchCount: count, snippet }
}

/** Map a match span inside one box's text to the overlapping word
 *  rects. Walks words in text order (the same loop shape as
 *  extractWordRects) to recover each word's span in box.text. */
function matchRectsInBox(box: OcrBox, spanStart: number, spanEnd: number): SearchRect[] {
  const words = extractWordRects(box)
  if (!words) {
    return [{ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 }]
  }
  const rects: SearchRect[] = []
  let pos = 0
  for (const w of words) {
    while (pos < box.text.length && /\s/.test(box.text[pos])) pos++
    const wStart = pos
    const wEnd = pos + w.text.trimEnd().length
    if (wStart < spanEnd && wEnd > spanStart) rects.push(w.rect)
    pos += w.text.length
  }
  return rects
}

function windowAround(text: string, start: number, end: number): string {
  const s = Math.max(0, start - SNIPPET_WINDOW)
  const e = Math.min(text.length, end + SNIPPET_WINDOW)
  return (s > 0 ? '…' : '') + text.slice(s, e) + (e < text.length ? '…' : '')
}
