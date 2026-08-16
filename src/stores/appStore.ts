import { create } from 'zustand'

export type Theme = 'light' | 'dark' | 'parchment'
export type SidebarTab = 'outline' | 'bookmarks' | 'annotations' | 'vocabulary' | 'library' | 'dictionary' | 'search'
export type LayoutMode = 'single' | 'scroll' | 'spread' | 'fit-width' | 'fit-height'

interface AppState {
  // Theme
  theme: Theme
  setTheme: (theme: Theme) => void

  // Sidebar
  sidebarOpen: boolean
  sidebarWidth: number
  activeSidebarTab: SidebarTab | null
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  setActiveSidebarTab: (tab: SidebarTab | null) => void

  // Layout
  layoutMode: LayoutMode
  setLayoutMode: (mode: LayoutMode) => void

  // Focus mode
  focusMode: boolean
  toggleFocusMode: () => void

  // TTS State
  ttsPlaying: boolean
  ttsRate: number
  ttsVoice: string
  setTtsPlaying: (playing: boolean) => void
  setTtsRate: (rate: number) => void
  setTtsVoice: (voice: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  // Theme
  theme: 'light',
  setTheme: (theme) => {
    const root = document.documentElement
    root.classList.remove('theme-dark', 'theme-parchment')
    if (theme === 'dark') root.classList.add('theme-dark')
    if (theme === 'parchment') root.classList.add('theme-parchment')
    set({ theme })
  },

  // Sidebar
  sidebarOpen: true,
  sidebarWidth: 280,
  activeSidebarTab: 'outline',
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setActiveSidebarTab: (tab) =>
    set((s) => ({
      activeSidebarTab: s.activeSidebarTab === tab ? null : tab,
      sidebarOpen: s.activeSidebarTab === tab ? false : true,
    })),

  // Layout
  layoutMode: 'fit-width',
  setLayoutMode: (mode) => set({ layoutMode: mode }),

  // Focus mode
  focusMode: false,
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),

  // TTS
  ttsPlaying: false,
  ttsRate: 1.0,
  ttsVoice: 'af_heart',
  setTtsPlaying: (playing) => set({ ttsPlaying: playing }),
  setTtsRate: (rate) => set({ ttsRate: rate }),
  setTtsVoice: (voice) => set({ ttsVoice: voice }),
}))
