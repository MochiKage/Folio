import {
  Sun, Moon, BookOpen, Sidebar, Maximize2, Minimize2,
  ListTree, Bookmark, Highlighter, BookOpenText, LibraryBig,
  Globe, Search,
} from 'lucide-react'
import { useAppStore, type Theme, type SidebarTab } from '../stores/appStore'

const themeIcons = { light: Sun, dark: Moon, parchment: BookOpen } as const
const themeLabels = { light: 'Light', dark: 'Dark', parchment: 'Warm' } as const

const tabs: { id: SidebarTab; label: string; icon: typeof ListTree }[] = [
  { id: 'outline', label: 'Outline', icon: ListTree },
  { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark },
  { id: 'annotations', label: 'Annotations', icon: Highlighter },
  { id: 'vocabulary', label: 'Vocabulary', icon: BookOpenText },
  { id: 'dictionary', label: 'Dictionary', icon: Globe },
  { id: 'library', label: 'Library', icon: LibraryBig },
  { id: 'search', label: 'Search', icon: Search },
]

export default function TitleBar() {
  const {
    theme, setTheme, sidebarOpen, toggleSidebar,
    focusMode, toggleFocusMode, activeSidebarTab, setActiveSidebarTab,
  } = useAppStore()

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-2 select-none">
      {/* Left: sidebar toggle + app name + tab buttons */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleSidebar}
          className={`rounded p-1.5 transition-colors hover:bg-[var(--border)]/30 ${
            sidebarOpen ? 'text-[var(--color-accent)]' : 'text-[var(--text)] opacity-50'
          }`}
          title="Toggle Sidebar"
        >
          <Sidebar size={16} />
        </button>
        <span className="ml-1 text-sm font-semibold tracking-wide text-[var(--text)]">Folio</span>

        {/* Tab buttons — right next to Folio */}
        <div className="mx-1.5 h-4 w-px bg-[var(--border)]" />
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveSidebarTab(id)}
            className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors ${
              activeSidebarTab === id && sidebarOpen
                ? 'bg-[var(--color-accent)]/10 font-medium text-[var(--color-accent)]'
                : 'text-[var(--text)] opacity-50 hover:bg-[var(--border)]/30 hover:opacity-80'
            }`}
            title={label}
          >
            <Icon size={13} />
            <span className="hidden xl:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Right: theme + fullscreen */}
      <div className="flex items-center gap-1">
        {(Object.keys(themeIcons) as Theme[]).map((t) => {
          const Icon = themeIcons[t]
          return (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs transition-colors ${
                theme === t
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--text)] opacity-50 hover:bg-[var(--border)]/30 hover:opacity-80'
              }`}
              title={themeLabels[t]}
            >
              <Icon size={13} />
              <span className="hidden sm:inline">{themeLabels[t]}</span>
            </button>
          )
        })}
        <div className="mx-1 h-4 w-px bg-[var(--border)]" />
        <button
          onClick={toggleFocusMode}
          className={`rounded p-1.5 transition-colors hover:bg-[var(--border)]/30 ${
            focusMode ? 'text-[var(--color-accent)]' : 'text-[var(--text)] opacity-50'
          }`}
          title={focusMode ? 'Exit Focus Mode (Esc)' : 'Focus Mode (F11)'}
        >
          {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </header>
  )
}
