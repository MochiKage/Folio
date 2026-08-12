import { create } from 'zustand'
import * as api from '../lib/api'

interface DictionaryState {
  /** All installed dictionaries (from DB) */
  dicts: api.DictionaryMeta[]
  /** Whether the dict list is loading */
  loading: boolean
  /** Error message if load/import fails */
  error: string | null

  /** Fetch the dictionary list from the backend */
  refresh: () => Promise<void>
  /** Validate a dictionary file without adding it */
  validate: (filePath: string, format: string) => Promise<api.ValidationResult>
  /** Add a dictionary (validates + loads + persists) */
  add: (meta: api.DictionaryMeta) => Promise<void>
  /** Remove a non-builtin dictionary */
  remove: (dictId: string) => Promise<void>
  /** Toggle enabled state */
  toggle: (dictId: string, enabled: boolean) => Promise<void>
  /** Change priority order */
  reorder: (dictId: string, newPriority: number) => Promise<void>
  /** Rename a dictionary */
  rename: (dictId: string, newName: string) => Promise<void>
  /** Clear error */
  clearError: () => void
}

export const useDictionaryStore = create<DictionaryState>((set, get) => ({
  dicts: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const dicts = await api.listDictionaries()
      set({ dicts, loading: false })
    } catch (err) {
      set({ error: String(err), loading: false })
    }
  },

  validate: async (filePath, format) => {
    return api.validateDictionary(filePath, format)
  },

  add: async (meta) => {
    set({ error: null })
    try {
      await api.addDictionary(meta)
      await get().refresh()
    } catch (err) {
      set({ error: String(err) })
      throw err
    }
  },

  remove: async (dictId) => {
    set({ error: null })
    try {
      await api.removeDictionary(dictId)
      set((s) => ({ dicts: s.dicts.filter((d) => d.id !== dictId) }))
    } catch (err) {
      set({ error: String(err) })
    }
  },

  toggle: async (dictId, enabled) => {
    set({ error: null })
    try {
      await api.toggleDictionary(dictId, enabled)
      set((s) => ({
        dicts: s.dicts.map((d) =>
          d.id === dictId ? { ...d, enabled } : d
        ),
      }))
    } catch (err) {
      set({ error: String(err) })
    }
  },

  reorder: async (dictId, newPriority) => {
    set({ error: null })
    try {
      await api.reorderDictionary(dictId, newPriority)
      await get().refresh()
    } catch (err) {
      set({ error: String(err) })
    }
  },

  rename: async (dictId, newName) => {
    set({ error: null })
    try {
      await api.renameDictionary(dictId, newName)
      set((s) => ({
        dicts: s.dicts.map((d) =>
          d.id === dictId ? { ...d, name: newName } : d
        ),
      }))
    } catch (err) {
      set({ error: String(err) })
    }
  },

  clearError: () => set({ error: null }),
}))
