import { useState, useEffect } from 'react'
import { Search, BookOpen, Trash2, RefreshCw } from 'lucide-react'
import * as api from '../lib/api'
import { usePdfStore } from '../stores/pdfStore'

/** Parse the definition JSON — handles both old `{en, zh}` and new format. */
function parseDef(raw: string): { en?: string; zh?: string } {
  try { return JSON.parse(raw) } catch { return {} }
}

/** Parse tags JSON array. */
function parseTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export default function VocabularyPanel() {
  const [words, setWords] = useState<api.VocabWord[]>([])
  const [search, setSearch] = useState('')
  const [selectedWord, setSelectedWord] = useState<api.VocabWord | null>(null)
  const refreshKey = usePdfStore((s) => s.refreshKey)
  const triggerRefresh = usePdfStore((s) => s.triggerRefresh)

  useEffect(() => {
    api.getVocabulary().then(setWords)
  }, [refreshKey])

  const handleDelete = async (id: string) => {
    await api.removeVocabulary(id)
    setWords((prev) => prev.filter((w) => w.id !== id))
    if (selectedWord?.id === id) setSelectedWord(null)
  }

  const handleReview = async (id: string) => {
    await api.updateReview(id)
    triggerRefresh()
  }

  const filtered = search
    ? words.filter((w) => w.word.toLowerCase().includes(search.toLowerCase()))
    : words

  // ─── Detail view ───
  if (selectedWord) {
    const def = parseDef(selectedWord.definition)
    const tags = parseTags(selectedWord.tags)

    return (
      <div className="flex flex-col gap-3 p-3">
        <button
          onClick={() => setSelectedWord(null)}
          className="self-start text-xs text-[var(--color-accent)] hover:underline"
        >
          ← Back to list
        </button>

        <div>
          <h3 className="text-lg font-semibold text-[var(--text)]">
            {selectedWord.word}
          </h3>
          {selectedWord.phonetic && (
            <p className="text-xs text-[var(--text)] opacity-50">
              /{selectedWord.phonetic}/
            </p>
          )}
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-[var(--color-accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]"
              >
                {tag.toUpperCase()}
              </span>
            ))}
          </div>
        )}

        <div className="space-y-2 text-xs">
          {def.zh && (
            <div>
              <p className="text-[10px] font-medium uppercase text-[var(--text)] opacity-30 mb-0.5">
                中文
              </p>
              <p className="text-[var(--text)] opacity-80">{def.zh}</p>
            </div>
          )}
          {def.en && (
            <div>
              <p className="text-[10px] font-medium uppercase text-[var(--text)] opacity-30 mb-0.5">
                English
              </p>
              <p className="text-[var(--text)] opacity-60">{def.en}</p>
            </div>
          )}
          {selectedWord.sentence && (
            <div>
              <p className="text-[10px] font-medium uppercase text-[var(--text)] opacity-30 mb-0.5">
                Source
              </p>
              <div className="rounded bg-[var(--bg)] p-2 italic text-[var(--text)] opacity-70">
                &ldquo;{selectedWord.sentence}&rdquo;
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10px] text-[var(--text)] opacity-30">
          <span>Reviewed: {selectedWord.review_count}x</span>
          <span>•</span>
          <span>
            Added:{' '}
            {selectedWord.created_at
              ? new Date(selectedWord.created_at).toLocaleDateString()
              : '—'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleReview(selectedWord.id)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          >
            <RefreshCw size={12} />
            Review
          </button>
          <button
            onClick={() => handleDelete(selectedWord.id)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            Remove
          </button>
        </div>
      </div>
    )
  }

  // ─── Word list ───
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1">
        <Search size={12} className="text-[var(--text)] opacity-30" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search vocabulary..."
          className="flex-1 bg-transparent text-xs text-[var(--text)] outline-none placeholder:text-[var(--text)]/30"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-4 text-center">
          <BookOpen size={24} className="mx-auto mb-2 text-[var(--text)] opacity-15" />
          <p className="text-xs text-[var(--text)] opacity-40">
            {words.length === 0
              ? 'Select a word in the PDF and add it here'
              : 'No words match your search'}
          </p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {filtered.map((w) => {
            const def = parseDef(w.definition)
            return (
              <div
                key={w.id}
                className="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-[var(--border)]/30 group"
              >
                <button
                  onClick={() => setSelectedWord(w)}
                  className="flex-1 text-left text-xs min-w-0"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-[var(--text)] truncate">{w.word}</span>
                    {w.review_count > 0 && (
                      <span className="shrink-0 text-[10px] text-[var(--color-accent)] opacity-50">
                        {w.review_count}x
                      </span>
                    )}
                  </div>
                  {def.zh && (
                    <p className="text-[10px] text-[var(--text)] opacity-40 truncate mt-0.5">
                      {def.zh}
                    </p>
                  )}
                </button>
                <button
                  onClick={() => handleDelete(w.id)}
                  className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-50"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
