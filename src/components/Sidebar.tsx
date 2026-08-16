import { useRef } from 'react'
import { useAppStore, type SidebarTab } from '../stores/appStore'
import OutlinePanel from './OutlinePanel'
import BookmarksPanel from './BookmarksPanel'
import AnnotationsPanel from './AnnotationsPanel'
import VocabularyPanel from './VocabularyPanel'
import LibraryPanel from './LibraryPanel'
import DictionaryManager from './DictionaryManager'
import SearchPanel from './SearchPanel'

export default function Sidebar() {
  const sidebarRef = useRef<HTMLElement>(null)
  const { sidebarOpen, sidebarWidth, activeSidebarTab, setSidebarWidth } = useAppStore()

  if (!sidebarOpen) return null

  return (
    <aside
      ref={sidebarRef}
      className="relative flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]"
      style={{ width: sidebarWidth }}
    >
      {/* Panel content — no tabs, they're in TitleBar now */}
      <div className="flex-1 overflow-y-auto">
        <SidebarPanel tab={activeSidebarTab} />
      </div>

      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-[var(--color-accent)]/40 active:bg-[var(--color-accent)]/60"
        style={{ right: -2 }}
        onMouseDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startWidth = sidebarRef.current?.offsetWidth ?? 280
          const onMove = (ev: MouseEvent) => {
            const next = Math.max(140, Math.min(500, startWidth + ev.clientX - startX))
            if (sidebarRef.current) sidebarRef.current.style.width = `${next}px`
          }
          const onUp = (ev: MouseEvent) => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            setSidebarWidth(Math.max(140, Math.min(500, startWidth + ev.clientX - startX)))
          }
          document.addEventListener('mousemove', onMove, { passive: true })
          document.addEventListener('mouseup', onUp)
        }}
      />
    </aside>
  )
}

function SidebarPanel({ tab }: { tab: SidebarTab | null }) {
  switch (tab) {
    case 'outline':      return <OutlinePanel />
    case 'bookmarks':    return <BookmarksPanel />
    case 'annotations':  return <AnnotationsPanel />
    case 'vocabulary':   return <VocabularyPanel />
    case 'dictionary':   return <DictionaryManager />
    case 'library':      return <LibraryPanel />
    case 'search':       return <SearchPanel />
    default:
      return <p className="p-4 text-center text-xs text-[var(--text)] opacity-40">Select a tab to view</p>
  }
}
