import { useState, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { usePdfStore } from '../stores/pdfStore'
import * as api from '../lib/api'

export default function BookmarksPanel() {
  const { activeDocId, jumpToPage } = usePdfStore()
  const refreshKey = usePdfStore((s) => s.refreshKey)
  const [bookmarks, setBookmarks] = useState<api.Bookmark[]>([])

  useEffect(() => {
    if (!activeDocId) {
      setBookmarks([])
      return
    }
    api.getBookmarks(activeDocId).then(setBookmarks)
  }, [activeDocId, refreshKey])

  const handleDelete = async (id: string) => {
    await api.removeBookmark(id)
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }

  if (bookmarks.length === 0) {
    return (
      <div className="space-y-4 p-2">
        <p className="text-center text-xs text-[var(--text)] opacity-40">
          No bookmarks yet
        </p>
        <p className="text-center text-xs text-[var(--text)] opacity-25">
          Press Ctrl+D to bookmark the current page
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-0.5 py-1">
      {bookmarks.map((bm) => (
        <div
          key={bm.id}
          className="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-[var(--border)]/30 group"
        >
          <button
            onClick={() => jumpToPage(bm.page)}
            className="flex-1 text-left text-xs text-[var(--text)] opacity-70 hover:opacity-100"
          >
            <span className="font-mono text-[10px] text-[var(--color-accent)]">
              p.{bm.page}
            </span>
            <span className="ml-2">{bm.label || 'Bookmark'}</span>
          </button>
          <button
            onClick={() => handleDelete(bm.id)}
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-50"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
