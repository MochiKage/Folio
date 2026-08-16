import { Pause, Play, Search } from 'lucide-react'
import { useSearchStore } from '../stores/searchStore'
import { usePdfStore } from '../stores/pdfStore'

const SOURCE_LABEL: Record<string, string> = {
  'ocr-cached': 'OCR 缓存',
  'ocr-live': 'OCR 新识别',
  embedded: '文本层',
}

/** Sidebar search tab: query input + full result list with snippets,
 *  grouped by page. Click a row to jump; highlights render on the page
 *  via SearchHighlightOverlay. */
export default function SearchPanel() {
  const {
    query, searched, status, results, orderedPages, current, progress,
    setQuery, runSearch, togglePause, goTo,
  } = useSearchStore()

  const doSearch = () => {
    const pdf = usePdfStore.getState()
    const doc = pdf.getActiveDoc()
    const q = query.trim()
    if (!q || !doc || !pdf.activeDocId) return
    void runSearch(pdf.activeDocId, doc.doc)
  }

  const running = status === 'running'
  const stale = query.trim() !== searched

  return (
    <div className="flex h-full flex-col">
      {/* Query input + progress */}
      <div className="border-b border-[var(--border)] p-2">
        <div className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1">
          <Search size={13} className="shrink-0 text-[var(--text)] opacity-40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                doSearch()
              }
            }}
            placeholder="在当前文档中搜索…"
            className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder-[var(--text)]/30 outline-none"
          />
          <button
            onClick={doSearch}
            className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-xs text-white transition-opacity hover:opacity-90"
          >
            搜索
          </button>
        </div>
        {running && (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--text)] opacity-60">
            <span>
              检查 {progress.classified}/{progress.total} 页
            </span>
            {progress.ocrTotal > 0 && (
              <>
                <span>· OCR {progress.ocrDone}/{progress.ocrTotal}</span>
                <button
                  onClick={togglePause}
                  className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--border)]/30"
                >
                  {progress.paused ? (
                    <>
                      <Play size={11} /> 继续
                    </>
                  ) : (
                    <>
                      <Pause size={11} /> 暂停
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-1">
        {!searched && !running ? (
          <p className="p-4 text-center text-xs text-[var(--text)] opacity-40">
            输入关键词，搜索全部页面（文字层 + OCR）
          </p>
        ) : stale ? (
          <p className="p-4 text-center text-xs text-[var(--text)] opacity-40">
            按 Enter 重新搜索
          </p>
        ) : running && orderedPages.length === 0 ? (
          <p className="p-4 text-center text-xs text-[var(--text)] opacity-40">
            搜索中…
          </p>
        ) : orderedPages.length === 0 ? (
          <p className="p-4 text-center text-xs text-[var(--text)] opacity-40">
            无结果
          </p>
        ) : (
          orderedPages.map((page) => {
            const r = results[page]
            if (!r) return null
            const active = current?.page === page
            return (
              <button
                key={page}
                onClick={() => goTo(page)}
                className={`mb-0.5 block w-full rounded p-1.5 text-left transition-colors ${
                  active
                    ? 'bg-[var(--color-accent)]/10'
                    : 'hover:bg-[var(--border)]/30'
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <span
                    className={`font-medium ${
                      active
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--text)] opacity-70'
                    }`}
                  >
                    第 {page} 页
                  </span>
                  {r.matchCount > 0 && (
                    <span className="text-[var(--text)] opacity-40">
                      {r.matchCount} 处
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-[var(--text)] opacity-30">
                    {SOURCE_LABEL[r.source] ?? r.source}
                  </span>
                </div>
                {r.snippet && (
                  <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-[var(--text)] opacity-60">
                    {r.snippet}
                  </div>
                )}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
