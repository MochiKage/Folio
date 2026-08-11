import type { TextContent, TextItem } from 'pdfjs-dist'

/**
 * Minimum number of non-whitespace characters required to consider a page
 * as having embedded text. Scanned PDFs sometimes have tiny OCR remnants
 * (a few garbled chars); this threshold filters those out.
 */
const MIN_EMBEDDED_CHARS = 8

/**
 * Check whether a page has meaningful embedded text content.
 * Returns false for pure-scanned pages (no text layer in the PDF).
 */
export function hasEmbeddedText(tc: TextContent): boolean {
  const chars = tc.items
    .filter((it): it is TextItem => 'str' in it)
    .reduce((n, it) => n + it.str.trim().length, 0)
  return chars >= MIN_EMBEDDED_CHARS
}

// ─── Paragraph merging ───────────────────────────

/**
 * Script categories used to decide whether a space is needed when joining
 * two consecutive lines into flowing text.
 */
type ScriptCategory = 'space-separated' | 'no-space'

/**
 * Returns the script category for a Unicode code point.
 * CJK characters, Japanese kana, and Korean hangul are "no-space";
 * everything else defaults to "space-separated" (Latin, Cyrillic, etc.).
 */
function scriptCategory(cp: number): ScriptCategory {
  if (
    (cp >= 0x4e00  && cp <= 0x9fff)  || // CJK Unified Ideographs
    (cp >= 0x3400  && cp <= 0x4dbf)  || // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
    (cp >= 0xf900  && cp <= 0xfaff)  || // CJK Compatibility Ideographs
    (cp >= 0x3040  && cp <= 0x309f)  || // Hiragana
    (cp >= 0x30a0  && cp <= 0x30ff)  || // Katakana
    (cp >= 0xac00  && cp <= 0xd7af)     // Hangul Syllables
  ) {
    return 'no-space'
  }
  return 'space-separated'
}

/**
 * Decide what to insert when merging two lines whose last/first characters
 * are `prevLast` and `nextFirst`.  Returns a space for Latin-like scripts
 * and an empty string for CJK scripts.
 *
 * An explicit `language` hint (ISO 639-1) can force the category:
 *   "zh" "ja" "ko" → no space; everything else → space.
 * When `language` is not provided (or `"auto"`), detection is based on the
 * actual character content, which handles mixed-script documents correctly.
 */
function lineJoinSeparator(
  prevLast: string,
  nextFirst: string,
  language?: string,
): string {
  if (language) {
    const lang = language.toLowerCase()
    if (lang === 'zh' || lang === 'ja' || lang === 'ko') return ''
    if (lang !== 'auto') return ' '
  }

  // Auto-detect: if EITHER adjacent character is no-space script, omit space.
  const prevCat = prevLast ? scriptCategory(prevLast.codePointAt(0)!) : 'space-separated'
  const nextCat = nextFirst ? scriptCategory(nextFirst.codePointAt(0)!) : 'space-separated'
  if (prevCat === 'no-space' || nextCat === 'no-space') return ''
  return ' '
}

/**
 * PDF.js inserts a `<br>` for every item with `hasEOL`, which in many PDFs
 * means *every* visual line — even within the same paragraph.  This makes
 * copied text come out line-by-line instead of as flowing paragraphs.
 *
 * This function walks all `<br>` elements in the container, measures the
 * vertical gap between the lines they separate, and removes BRs where the
 * gap is consistent with same-paragraph line spacing (keeping only paragraph
 * breaks where the gap is significantly larger).
 *
 * Must be called **after** `textLayer.render()` so the spans have correct
 * layout positions from `getBoundingClientRect()`.
 *
 * @param container  The text layer DOM container.
 * @param language   Optional ISO 639-1 language code (e.g. "en", "zh").
 *                   Used to decide whether to insert a space between merged
 *                   lines.  Pass `"auto"` or omit for character-based detection.
 */
export function mergeParagraphLines(
  container: HTMLElement,
  language?: string,
): void {
  const brs = Array.from(container.querySelectorAll('br'))
  if (brs.length < 2) return

  // Collect gap + adjacent text for each BR between two visible spans.
  interface BrGap {
    br: HTMLBRElement
    gap: number
    prevText: string
    nextText: string
  }
  const entries: BrGap[] = []

  for (const br of brs) {
    let prev: Element | null = br.previousElementSibling
    let next: Element | null = br.nextElementSibling

    while (prev && prev.tagName !== 'SPAN') prev = prev.previousElementSibling
    while (next && next.tagName !== 'SPAN') next = next.nextElementSibling

    if (!prev || !next) continue

    const prevRect = (prev as HTMLElement).getBoundingClientRect()
    const nextRect = (next as HTMLElement).getBoundingClientRect()

    if (nextRect.top <= prevRect.bottom) continue

    entries.push({
      br,
      gap: nextRect.top - prevRect.bottom,
      prevText: (prev as HTMLElement).textContent || '',
      nextText: (next as HTMLElement).textContent || '',
    })
  }

  if (entries.length < 2) return

  // ── Gap-based paragraph detection ──
  const gaps = entries.map(e => e.gap)
  const sorted = [...gaps].sort((a, b) => a - b)

  // Use the mean of the bottom 80% as the typical intra-paragraph gap.
  // This naturally excludes the largest gaps (paragraph breaks).
  const bottom80 = sorted.slice(0, Math.ceil(sorted.length * 0.8))
  const typicalGap = bottom80.reduce((a, b) => a + b, 0) / bottom80.length

  // Use the top 10% mean as the paragraph-break reference.
  const top10 = sorted.slice(-Math.ceil(sorted.length * 0.1))
  const largeGap = top10.reduce((a, b) => a + b, 0) / top10.length

  // If the page's gaps are essentially all the same (no paragraph breaks),
  // merge every line into one flowing block.
  const isUniform = sorted[sorted.length - 1] - sorted[0] <= typicalGap * 0.3

  // Threshold: pick the midpoint between typical line-spacing and the
  // paragraph-break gap, but never lower than 2.2× the typical gap.
  // The high multiplier avoids false positives on pages with subtle
  // spacing variation (justified text, inline math, etc.).
  const threshold = isUniform
    ? Infinity
    : Math.max(typicalGap * 2.2, (typicalGap + largeGap) / 2)

  for (const { br, gap, prevText, nextText } of entries) {
    if (gap <= threshold) {
      const joiner = lineJoinSeparator(
        prevText.slice(-1),
        nextText.slice(0, 1),
        language,
      )

      // Append the separator to the previous span's textContent rather
      // than inserting a bare text node.  A bare text node between
      // absolutely-positioned spans lands at (0, 0) in the container
      // and is invisible to browser text selection — the space is lost.
      const prevSpan = br.previousElementSibling
      if (prevSpan && prevSpan.tagName === 'SPAN' && joiner) {
        prevSpan.textContent = (prevSpan.textContent || '') + joiner
      }
      br.remove()
    }
    // else: gap > threshold → genuine paragraph break, keep the BR.
  }
}
