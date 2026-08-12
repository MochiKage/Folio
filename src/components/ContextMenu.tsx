import { useEffect, useRef } from 'react'
import { Bookmark, BookOpen, Copy, Trash2 } from 'lucide-react'
import { useContextMenuStore } from '../stores/contextMenuStore'
import { usePdfStore } from '../stores/pdfStore'
import { useAnnotationStore } from '../stores/annotationStore'
import { generateId } from '../lib/selection'
import * as api from '../lib/api'

const HIGHLIGHT_COLORS = [
  { label: 'Yellow', value: '#ffeb3b', ring: 'ring-yellow-400' },
  { label: 'Green', value: '#a5d6a7', ring: 'ring-green-400' },
  { label: 'Blue', value: '#90caf9', ring: 'ring-blue-400' },
  { label: 'Pink', value: '#f48fb1', ring: 'ring-pink-400' },
]

export default function ContextMenu() {
  const menuRef = useRef<HTMLDivElement>(null)
  const { visible, x, y, selectedText, pageNumber, pdfRect, overlappingAnnIds, hide } = useContextMenuStore()
  const activeDocId = usePdfStore((s) => s.activeDocId)
  const triggerRefresh = usePdfStore((s) => s.triggerRefresh)
  const addAnnotation = useAnnotationStore((s) => s.add)
  const removeAnnotation = useAnnotationStore((s) => s.remove)

  // Close on click outside or Escape
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hide()
      }
    }
    // Delay listener to avoid immediate close from the right-click event
    const id = setTimeout(() => {
      window.addEventListener('keydown', onKey)
      window.addEventListener('mousedown', onClick)
    }, 0)
    return () => {
      clearTimeout(id)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [visible, hide])

  if (!visible || !activeDocId) return null

  const handleHighlight = async (color: string) => {
    // Remove any existing highlights that overlap this selection,
    // so new highlights replace old ones instead of stacking.
    for (const id of overlappingAnnIds) {
      await removeAnnotation(id)
    }
    const ann: api.Annotation = {
      id: generateId(),
      document_id: activeDocId,
      page: pageNumber,
      annot_type: 'highlight',
      color,
      rect: JSON.stringify(pdfRect ?? []),
      content: selectedText.slice(0, 500),
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await addAnnotation(ann)
    hide()
  }

  const handleAddVocabulary = async () => {
    const word = selectedText.trim().split(/\s+/)[0].replace(/[^a-zA-Z-]/g, '')
    if (!word) return
    const vocab: api.VocabWord = {
      id: generateId(),
      word,
      phonetic: null,
      definition: '{}',
      sentence: selectedText.slice(0, 500),
      source_doc_id: activeDocId,
      source_page: pageNumber,
      tags: '[]',
      review_count: 0,
      last_review_at: null,
      created_at: new Date().toISOString(),
    }
    try {
      await api.addVocabulary(vocab)
      triggerRefresh()
    } catch (err) {
      console.error('[ContextMenu] addVocabulary failed:', err)
    }
    hide()
  }

  const handleBookmark = async () => {
    const bm: api.Bookmark = {
      id: generateId(),
      document_id: activeDocId,
      page: pageNumber,
      label: selectedText.slice(0, 100) || `Page ${pageNumber}`,
      created_at: new Date().toISOString(),
    }
    try {
      await api.addBookmark(bm)
      triggerRefresh()
    } catch (err) {
      console.error('[ContextMenu] addBookmark failed:', err)
    }
    hide()
  }

  const handleRemoveHighlights = async () => {
    for (const id of overlappingAnnIds) {
      await removeAnnotation(id)
    }
    triggerRefresh()
    hide()
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(selectedText)
    } catch {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = selectedText
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    hide()
  }

  // Adjust position so menu doesn't overflow viewport
  const menuX = Math.min(x, window.innerWidth - 200)
  const menuY = Math.min(y, window.innerHeight - 280)

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl"
      style={{ left: menuX, top: menuY }}
    >
      {/* Highlight submenu */}
      <div className="px-2 py-1">
        <p className="text-[10px] font-medium uppercase text-[var(--text)] opacity-30">
          Highlight
        </p>
        <div className="mt-1 flex gap-1">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.value}
              onClick={() => handleHighlight(c.value)}
              className={`h-5 w-5 rounded-full border border-white/20 shadow-sm transition-transform hover:scale-110 ${c.ring}`}
              style={{ backgroundColor: c.value }}
              title={c.label}
            />
          ))}
        </div>
      </div>

      <div className="mx-2 my-1 border-t border-[var(--border)]" />

      {/* Remove Highlight — only shown when selection overlaps existing highlights */}
      {overlappingAnnIds.length > 0 && (
        <>
          <button
            onClick={handleRemoveHighlights}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-400 opacity-70 hover:bg-red-500/10 hover:opacity-100"
          >
            <Trash2 size={14} />
            Remove Highlight{overlappingAnnIds.length > 1 ? `s (${overlappingAnnIds.length})` : ''}
          </button>
          <div className="mx-2 my-1 border-t border-[var(--border)]" />
        </>
      )}

      {/* Actions */}
      <button
        onClick={handleAddVocabulary}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--text)] opacity-70 hover:bg-[var(--border)]/30 hover:opacity-100"
      >
        <BookOpen size={14} />
        Add to Vocabulary
      </button>
      <button
        onClick={handleBookmark}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--text)] opacity-70 hover:bg-[var(--border)]/30 hover:opacity-100"
      >
        <Bookmark size={14} />
        Bookmark Page
      </button>
      <button
        onClick={handleCopy}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--text)] opacity-70 hover:bg-[var(--border)]/30 hover:opacity-100"
      >
        <Copy size={14} />
        Copy
      </button>

      {/* Selected text preview */}
      <div className="mx-2 mt-1 border-t border-[var(--border)]" />
      <p className="mx-3 my-1 line-clamp-2 text-[10px] italic text-[var(--text)] opacity-30">
        &ldquo;{selectedText.slice(0, 100)}&rdquo;
      </p>
    </div>
  )
}
