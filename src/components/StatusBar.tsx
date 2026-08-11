import { useAppStore } from '../stores/appStore'
import { usePdfStore } from '../stores/pdfStore'
import { useOcrStore } from '../stores/ocrStore'

const presets = [
  { label: 'Fit',  zoom: -1 },
  { label: '100%', zoom: 1.0 },
  { label: '150%', zoom: 1.5 },
  { label: '200%', zoom: 2.0 },
  { label: '300%', zoom: 3.0 },
  { label: '400%', zoom: 4.0 },
]

const ocrStatusLabels: Record<string, string> = {
  idle: '',
  loading: 'OCR…',
  done: 'OCR ✓',
  error: 'OCR ✗',
}

export default function StatusBar() {
  const { focusMode } = useAppStore()
  const activePage = usePdfStore((s) => s.activePage)
  const zoom = usePdfStore((s) => s.zoom)
  const setZoom = usePdfStore((s) => s.setZoom)
  const activeDoc = usePdfStore((s) =>
    s.documents.find((d) => d.id === s.activeDocId)
  )
  const forceOcr = useOcrStore((s) => s.forceOcr)
  const toggleForceOcr = useOcrStore((s) => s.toggleForceOcr)
  const pageOcrStatus = useOcrStore((s) => {
    if (!activeDoc) return 'idle'
    return s.statuses[`${activeDoc.id}:${activePage}`] ?? 'idle'
  })

  if (focusMode) return null

  const totalPages = activeDoc?.totalPages ?? 0

  const handlePreset = (z: number) => {
    if (z === -1) {
      // Toggle between fit-width and fit-height
      setZoom(zoom === -1 ? -2 : -1)
    } else {
      setZoom(z)
    }
  }

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)]/50">
      <div className="flex items-center gap-3">
        <span>{activeDoc?.name ?? 'Ready'}</span>
        {/* OCR status */}
        {pageOcrStatus !== 'idle' && (
          <span
            className={`tabular-nums ${
              pageOcrStatus === 'loading'
                ? 'text-[var(--color-accent)] animate-pulse'
                : pageOcrStatus === 'done'
                  ? 'text-green-500'
                  : 'text-red-400'
            }`}
          >
            {ocrStatusLabels[pageOcrStatus]}
          </span>
        )}
        {/* Force OCR toggle */}
        {activeDoc && (
          <button
            onClick={toggleForceOcr}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              forceOcr
                ? 'bg-[var(--color-accent)]/10 font-medium text-[var(--color-accent)]'
                : 'hover:bg-[var(--border)]/30 hover:text-[var(--text)]/70 text-[var(--text)]/30'
            }`}
            title="Toggle OCR mode — use PDF text coordinates to render selectable text layer"
          >
            OCR
          </button>
        )}
      </div>

      {/* Zoom slider bar */}
      <div className="flex items-center gap-2">
        <span className="w-16 text-right tabular-nums text-[var(--text)]/40">
          Page {activePage}/{totalPages || '—'}
        </span>
        <span className="text-[var(--border)]">|</span>

        <button
          onClick={() => setZoom(Math.max(0.25, (zoom > 0 ? zoom : 1.5) - 0.25))}
          className="text-[var(--text)]/30 hover:text-[var(--text)]/60"
          title="-25%"
        >−</button>

        {/* Slider track */}
        <input
          type="range"
          min="25"
          max="400"
          step="25"
          value={zoom > 0 ? Math.round(zoom * 100) : 150}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          className="h-1 w-28 cursor-pointer appearance-none rounded bg-[var(--border)] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--color-accent)]"
        />

        <button
          onClick={() => setZoom(Math.min(4, (zoom > 0 ? zoom : 1.5) + 0.25))}
          className="text-[var(--text)]/30 hover:text-[var(--text)]/60"
          title="+25%"
        >+</button>

        {/* Current zoom percentage */}
        <span className="w-10 text-center tabular-nums text-[var(--text)]/60">
          {zoom > 0 ? `${Math.round(zoom * 100)}%` : 'Fit'}
        </span>

        {/* Presets */}
        <span className="text-[var(--border)]">|</span>
        {presets.map(({ label, zoom: z }) => (
          <button
            key={label}
            onClick={() => handlePreset(z)}
            className={`rounded px-1.5 py-0.5 transition-colors ${
              (z === -1 && zoom < 0) || (z > 0 && Math.abs(z - zoom) < 0.02)
                ? 'bg-[var(--color-accent)]/10 font-medium text-[var(--color-accent)]'
                : 'hover:bg-[var(--border)]/30 hover:text-[var(--text)]/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </footer>
  )
}
