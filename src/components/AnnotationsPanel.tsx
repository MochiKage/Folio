import { useState, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { usePdfStore } from '../stores/pdfStore'
import * as api from '../lib/api'

const typeIcons: Record<string, string> = {
  highlight: '🖍',
  underline: '⎁',
  strikethrough: '̶',
  text: '💬',
}

export default function AnnotationsPanel() {
  const { activeDocId, setPage } = usePdfStore()
  const [annotations, setAnnotations] = useState<api.Annotation[]>([])

  useEffect(() => {
    if (!activeDocId) {
      setAnnotations([])
      return
    }
    api.getAnnotations(activeDocId).then(setAnnotations)
  }, [activeDocId])

  const handleDelete = async (id: string) => {
    await api.deleteAnnotation(id)
    setAnnotations((prev) => prev.filter((a) => a.id !== id))
  }

  if (annotations.length === 0) {
    return (
      <p className="p-2 text-center text-xs text-[var(--text)] opacity-40">
        No annotations yet
      </p>
    )
  }

  return (
    <div className="space-y-1 py-1">
      {annotations.map((ann) => (
        <div
          key={ann.id}
          className="rounded px-2 py-1.5 hover:bg-[var(--border)]/30 group"
        >
          <div className="flex items-start gap-1.5">
            <span className="mt-0.5 text-xs">
              {typeIcons[ann.annot_type] || '📌'}
            </span>
            <button
              onClick={() => setPage(ann.page)}
              className="flex-1 text-left"
            >
              {ann.content ? (
                <p className="text-xs text-[var(--text)] opacity-70 line-clamp-2">
                  {ann.content}
                </p>
              ) : (
                <p className="text-xs text-[var(--text)] opacity-40 italic">
                  {ann.annot_type} annotation
                </p>
              )}
              <span className="text-[10px] text-[var(--color-accent)]">
                p.{ann.page}
              </span>
            </button>
            <button
              onClick={() => handleDelete(ann.id)}
              className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-50"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
