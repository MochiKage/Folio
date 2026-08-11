import { useState, useEffect } from 'react'
import { Search, Filter } from 'lucide-react'
import * as api from '../lib/api'

const namespaceLabels: Record<string, string> = {
  discipline: 'Discipline',
  doctype: 'Type',
  source: 'Source',
  custom: 'Tags',
}

import { memo } from 'react'

const LibraryPanel = memo(function LibraryPanel() {
  const [documents, setDocuments] = useState<api.Document[]>([])
  const [tags, setTags] = useState<api.TagWithCount[]>([])
  const [search, setSearch] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])

  useEffect(() => {
    api.getAllDocuments().then(setDocuments)
    api.getAllTags().then(setTags)
  }, [])

  const handleToggleTag = (tagId: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    )
  }

  // Group tags by namespace
  const groupedTags = tags.reduce(
    (acc, { tag, count }) => {
      const ns = tag.namespace || 'custom'
      if (!acc[ns]) acc[ns] = []
      acc[ns].push({ ...tag, count })
      return acc
    },
    {} as Record<string, (api.Tag & { count: number })[]>
  )

  const filtered = documents.filter((d) => {
    const matchSearch =
      !search ||
      (d.title || '').toLowerCase().includes(search.toLowerCase()) ||
      (d.file_path || '').toLowerCase().includes(search.toLowerCase())
    return matchSearch
  })

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* Search */}
      <div className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1">
        <Search size={12} className="shrink-0 text-[var(--text)] opacity-30" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search documents..."
          className="flex-1 bg-transparent text-xs text-[var(--text)] outline-none placeholder:text-[var(--text)]/30"
        />
      </div>

      {/* Tag filters */}
      {Object.entries(groupedTags).length > 0 && (
        <div className="space-y-1.5">
          {Object.entries(groupedTags).map(([ns, tagList]) => (
            <div key={ns}>
              <p className="mb-0.5 text-[10px] font-medium uppercase text-[var(--text)] opacity-30">
                {namespaceLabels[ns] || ns}
              </p>
              <div className="flex flex-wrap gap-1">
                {tagList.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleToggleTag(t.id)}
                    className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                      selectedTags.includes(t.id)
                        ? 'bg-[var(--color-accent)] text-white'
                        : 'bg-[var(--border)]/30 text-[var(--text)] opacity-60 hover:opacity-100'
                    }`}
                  >
                    {t.value}
                    <span className="opacity-50">{t.count}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Document list */}
      {filtered.length === 0 ? (
        <div className="py-4 text-center">
          <Filter size={24} className="mx-auto mb-2 text-[var(--text)] opacity-15" />
          <p className="text-xs text-[var(--text)] opacity-40">
            {documents.length === 0
              ? 'Open a PDF to add it to your library'
              : 'No documents match'}
          </p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {filtered.map((doc) => (
            <div
              key={doc.id}
              className="rounded px-2 py-1.5 hover:bg-[var(--border)]/30"
            >
              <p className="text-xs font-medium text-[var(--text)] truncate">
                {doc.title || doc.file_path.split(/[/\\]/).pop() || 'Untitled'}
              </p>
              <p className="text-[10px] text-[var(--text)] opacity-40">
                {doc.page_count > 0 && `${doc.page_count} pages • `}
                Progress: {Math.round(doc.read_progress * 100)}%
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default LibraryPanel
