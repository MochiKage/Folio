import { useState, useEffect } from 'react'
import { Search, BookOpen, Trash2 } from 'lucide-react'
import * as api from '../lib/api'
import { usePdfStore } from '../stores/pdfStore'

export default function VocabularyPanel() {
  const [words, setWords] = useState<api.VocabWord[]>([])
  const [search, setSearch] = useState('')
  const [selectedWord, setSelectedWord] = useState<api.VocabWord | null>(null)
  const refreshKey = usePdfStore((s) => s.refreshKey)

  useEffect(() => {
    api.getVocabulary().then(setWords)
  }, [refreshKey])

  const handleDelete = async (id: string) => {
    await api.removeVocabulary(id)
    setWords((prev) => prev.filter((w) => w.id !== id))
    if (selectedWord?.id === id) setSelectedWord(null)
  }

  const filtered = search
    ? words.filter((w) => w.word.toLowerCase().includes(search.toLowerCase()))
    : words

  // Show selected word detail
  if (selectedWord) {
    let definition: { en?: string; zh?: string } = {}
    try {
      definition = JSON.parse(selectedWord.definition)
    } catch {}

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
        <div className="space-y-2 text-xs">
          {definition.zh && (
            <p className="text-[var(--text)] opacity-80">{definition.zh}</p>
          )}
          {definition.en && (
            <p className="text-[var(--text)] opacity-60">{definition.en}</p>
          )}
          {selectedWord.sentence && (
            <div className="rounded bg-[var(--bg)] p-2 italic text-[var(--text)] opacity-70">
              "{selectedWord.sentence}"
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
        <button
          onClick={() => handleDelete(selectedWord.id)}
          className="flex items-center gap-1 self-start rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
        >
          <Trash2 size={12} />
          Remove
        </button>
      </div>
    )
  }

  // Word list view
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
          {filtered.map((w) => (
            <div
              key={w.id}
              className="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-[var(--border)]/30 group"
            >
              <button
                onClick={() => setSelectedWord(w)}
                className="flex-1 text-left text-xs"
              >
                <span className="font-medium text-[var(--text)]">{w.word}</span>
                {w.phonetic && (
                  <span className="ml-1.5 text-[10px] text-[var(--text)] opacity-40">
                    /{w.phonetic}/
                  </span>
                )}
              </button>
              <span className="text-[10px] text-[var(--text)] opacity-25">
                {w.review_count}x
              </span>
              <button
                onClick={() => handleDelete(w.id)}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
