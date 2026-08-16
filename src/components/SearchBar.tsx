import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Pause, Play, Search, X } from 'lucide-react'
import { useSearchStore } from '../stores/searchStore'
import { usePdfStore } from '../stores/pdfStore'

/**
 * Floating search bar (Ctrl+F). Compact: input + page counter +
 * prev/next + pause for batch OCR. The full result list lives in the
 * Search sidebar panel — both read the same store.
 */
export default function SearchBar() {
  const barOpen = useSearchStore((s) => s.barOpen)
  const query = useSearchStore((s) => s.query)
  const searched = useSearchStore((s) => s.searched)
  const status = useSearchStore((s) => s.status)
  const orderedPages = useSearchStore((s) => s.orderedPages)
  const current = useSearchStore((s) => s.current)
  const progress = useSearchStore((s) => s.progress)
  const setQuery = useSearchStore((s) => s.setQuery)
  const closeBar = useSearchStore((s) => s.closeBar)
  const runSearch = useSearchStore((s) => s.runSearch)
  const next = useSearchStore((s) => s.next)
  const prev = useSearchStore((s) => s.prev)
  const togglePause = useSearchStore((s) => s.togglePause)

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (barOpen) inputRef.current?.focus()
  }, [barOpen])

  if (!barOpen) return null

  const running = status === 'running'
  const stale = query.trim() !== searched
  const idx = current ? orderedPages.indexOf(current.page) + 1 : 0
  const denom = progress.total + progress.ocrTotal
  const pct =
    denom > 0
      ? Math.min(100, Math.round(((progress.classified + progress.ocrDone) / denom) * 100))
      : 0

  const onEnter = () => {
    const pdf = usePdfStore.getState()
    const doc = pdf.getActiveDoc()
    if (!doc || !pdf.activeDocId) return
    const q = query.trim()
    if (!q) return
    if (q !== searched) void runSearch(pdf.activeDocId, doc.doc)
    else if (status === 'done' && orderedPages.length > 0) next()
  }

  const iconBtn =
    'rounded p-1 text-[var(--text)] opacity-50 transition-colors hover:bg-[var(--border)]/30 hover:opacity-80'

  return (
    <div className="fixed right-4 top-12 z-50 flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]/95 px-2 py-1.5 shadow-lg backdrop-blur-sm">
      <Search size={14} className="ml-1 shrink-0 text-[var(--text)] opacity-40" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            closeBar()
          }
        }}
        placeholder="搜索当前文档…"
        className="w-48 bg-transparent text-sm text-[var(--text)] placeholder-[var(--text)]/30 outline-none"
      />
      <span className="w-16 text-center text-xs tabular-nums text-[var(--text)] opacity-50">
        {running && progress.ocrTotal > 0
          ? `OCR ${progress.ocrDone}/${progress.ocrTotal}`
          : stale
            ? '⏎ 搜索'
            : orderedPages.length > 0
              ? `${idx}/${orderedPages.length}`
              : running
                ? `${progress.classified}/${progress.total}`
                : ''}
      </span>
      {running && progress.ocrTotal > 0 && (
        <button
          onClick={togglePause}
          title={progress.paused ? '恢复批量 OCR' : '暂停批量 OCR'}
          className={iconBtn}
        >
          {progress.paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
      )}
      <button onClick={prev} title="上一个结果" className={iconBtn}>
        <ChevronUp size={14} />
      </button>
      <button onClick={next} title="下一个结果" className={iconBtn}>
        <ChevronDown size={14} />
      </button>
      <button onClick={closeBar} title="关闭 (Esc)" className={iconBtn}>
        <X size={14} />
      </button>
      {running && (
        <div className="absolute -bottom-1 left-2 right-2 h-0.5 overflow-hidden rounded bg-[var(--border)]/40">
          <div
            className="h-full bg-[var(--color-accent)] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}
