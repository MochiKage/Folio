import { useEffect, useState } from 'react'
import {
  BookOpen, Plus, Trash2, ToggleLeft, ToggleRight,
  AlertTriangle, Info, Loader2, CheckCircle2, XCircle,
  Pencil, ChevronUp, ChevronDown,
} from 'lucide-react'
import { useDictionaryStore } from '../stores/dictionaryStore'
import { generateId } from '../lib/selection'
import type { DictionaryMeta, ValidationResult } from '../lib/api'

/** Generate a display name from a file path. */
function fileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

export default function DictionaryManager() {
  const store = useDictionaryStore()
  const [importing, setImporting] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importFormat, setImportFormat] = useState('ecdict')
  const [importName, setImportName] = useState('')
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [importError, setImportError] = useState('')

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const startRename = (dict: DictionaryMeta) => {
    setRenamingId(dict.id)
    setRenameValue(dict.name)
  }

  const commitRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null)
      return
    }
    try {
      await store.rename(renamingId, renameValue.trim())
    } catch {
      // store.error will show the error
    }
    setRenamingId(null)
  }

  const cancelRename = () => {
    setRenamingId(null)
  }

  useEffect(() => {
    store.refresh()
  }, [])

  const handlePickFile = async () => {
    try {
      // Use Tauri dialog to pick a file
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        title: 'Select Dictionary File',
        filters: [
          { name: 'Dictionary Files', extensions: ['db', 'sqlite', 'sqlite3'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        multiple: false,
      })
      if (selected && typeof selected === 'string') {
        setImportPath(selected)
        setImportName('')
        setValidation(null)
        setImportError('')
      }
    } catch (err) {
      setImportError(`File picker error: ${err}`)
    }
  }

  const handleValidate = async () => {
    if (!importPath) return
    setValidating(true)
    setValidation(null)
    setImportError('')
    try {
      const result = await store.validate(importPath, importFormat)
      setValidation(result)
      if (result.valid && !importName) {
        // Auto-generate name from file path
        setImportName(fileName(importPath).replace(/\.(db|sqlite|sqlite3)$/, ''))
      }
    } catch (err) {
      setImportError(String(err))
    } finally {
      setValidating(false)
    }
  }

  const handleImport = async () => {
    if (!importPath || !validation?.valid) return
    setImporting(true)
    setImportError('')
    try {
      // Find the next available priority
      const maxPriority = store.dicts.reduce(
        (max, d) => Math.max(max, d.priority),
        0
      )
      const meta: DictionaryMeta = {
        id: generateId(),
        name: importName || fileName(importPath),
        source_lang: 'en',
        target_lang: 'zh',
        format: importFormat,
        file_path: importPath,
        enabled: true,
        priority: maxPriority + 1,
        entry_count: validation.entry_count ?? 0,
        is_builtin: false,
        created_at: new Date().toISOString(),
        updated_at: null,
      }
      await store.add(meta)
      // Reset form
      setImportPath('')
      setImportName('')
      setValidation(null)
    } catch (err) {
      setImportError(String(err))
    } finally {
      setImporting(false)
    }
  }

  const handleRemove = async (dict: DictionaryMeta) => {
    if (dict.is_builtin) return
    await store.remove(dict.id)
  }

  const handleToggle = async (dict: DictionaryMeta) => {
    await store.toggle(dict.id, !dict.enabled)
  }

  const handleMoveUp = async (dict: DictionaryMeta, index: number) => {
    if (index <= 0) return
    const above = store.dicts[index - 1]
    // Swap priorities: give this dict the priority of the one above
    await store.reorder(dict.id, above.priority)
  }

  const handleMoveDown = async (dict: DictionaryMeta, index: number) => {
    if (index >= store.dicts.length - 1) return
    const below = store.dicts[index + 1]
    await store.reorder(dict.id, below.priority)
  }

  // ─── Render ──────────────────────────────────

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BookOpen size={16} className="text-[var(--color-accent)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">Dictionaries</h2>
      </div>

      {/*─── Installed dictionaries ───*/}
      {store.dicts.length > 0 && (
        <p className="text-[10px] text-[var(--text)] opacity-25">
          Higher priority dictionaries are searched first. Use ↑↓ to reorder.
        </p>
      )}
      {store.loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={16} className="animate-spin text-[var(--text)] opacity-30" />
        </div>
      ) : store.dicts.length === 0 ? (
        <p className="text-xs text-[var(--text)] opacity-30 italic">
          No dictionaries installed. Import one below.
        </p>
      ) : (
        <div className="space-y-1">
          {store.dicts.map((dict, i) => (
            <div
              key={dict.id}
              className={`flex items-center gap-2 rounded p-2 text-xs transition-colors ${
                dict.enabled
                  ? 'bg-[var(--bg)]'
                  : 'bg-[var(--bg)] opacity-50'
              }`}
            >
              {/* Status dot */}
              <div
                className={`h-2 w-2 shrink-0 rounded-full ${
                  dict.enabled ? 'bg-green-400' : 'bg-gray-400'
                }`}
              />

              {/* Dict info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {renamingId === dict.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') cancelRename()
                      }}
                      onBlur={commitRename}
                      autoFocus
                      className="min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--text)] outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => startRename(dict)}
                      className="group flex items-center gap-1 font-medium text-[var(--text)] truncate hover:text-[var(--color-accent)] transition-colors"
                      title="Click to rename"
                    >
                      <span className="truncate">{dict.name}</span>
                      <Pencil size={10} className="shrink-0 opacity-0 group-hover:opacity-30 transition-opacity" />
                    </button>
                  )}
                  {dict.is_builtin && (
                    <span className="shrink-0 rounded bg-[var(--color-accent)]/10 px-1 py-px text-[9px] font-medium text-[var(--color-accent)]">
                      BUILT-IN
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[var(--text)] opacity-30 truncate">
                  {dict.format.toUpperCase()} · {dict.source_lang}→{dict.target_lang}
                  {dict.entry_count > 0 && ` · ${dict.entry_count.toLocaleString()} entries`}
                </p>
              </div>

              {/* Actions */}
              <div className="flex shrink-0 items-center gap-0.5">
                {/* Priority reorder */}
                <div className="flex flex-col -space-y-0.5">
                  <button
                    onClick={() => handleMoveUp(dict, i)}
                    disabled={i === 0}
                    className="rounded p-0.5 hover:bg-[var(--border)]/30 disabled:opacity-15 disabled:hover:bg-transparent transition-colors"
                    title="Move up (higher priority)"
                  >
                    <ChevronUp size={10} />
                  </button>
                  <button
                    onClick={() => handleMoveDown(dict, i)}
                    disabled={i === store.dicts.length - 1}
                    className="rounded p-0.5 hover:bg-[var(--border)]/30 disabled:opacity-15 disabled:hover:bg-transparent transition-colors"
                    title="Move down (lower priority)"
                  >
                    <ChevronDown size={10} />
                  </button>
                </div>
                <button
                  onClick={() => handleToggle(dict)}
                  className="rounded p-1 hover:bg-[var(--border)]/30 transition-colors"
                  title={dict.enabled ? 'Disable' : 'Enable'}
                >
                  {dict.enabled ? (
                    <ToggleRight size={14} className="text-[var(--color-accent)]" />
                  ) : (
                    <ToggleLeft size={14} className="text-[var(--text)] opacity-30" />
                  )}
                </button>
                {!dict.is_builtin && (
                  <button
                    onClick={() => handleRemove(dict)}
                    className="rounded p-1 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                    title="Remove dictionary"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-[var(--border)]" />

      {/*─── Import section ───*/}
      <div>
        <h3 className="mb-2 text-[11px] font-medium uppercase text-[var(--text)] opacity-30">
          Import Dictionary
        </h3>

        <div className="space-y-2">
          {/* File picker */}
          <div>
            <button
              onClick={handlePickFile}
              className="flex w-full items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text)] opacity-60 hover:opacity-100 hover:border-[var(--color-accent)]/30 transition-colors"
            >
              <Plus size={12} />
              {importPath ? fileName(importPath) : 'Choose dictionary file...'}
            </button>
          </div>

          {/* Format selector */}
          {importPath && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-[var(--text)] opacity-30">Format:</label>
              <select
                value={importFormat}
                onChange={(e) => {
                  setImportFormat(e.target.value)
                  setValidation(null)
                }}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text)]"
              >
                <option value="ecdict">ECDICT (SQLite)</option>
              </select>

              <button
                onClick={handleValidate}
                disabled={validating}
                className="ml-auto rounded px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-30"
              >
                {validating ? 'Checking...' : 'Validate'}
              </button>
            </div>
          )}

          {/* Validation result */}
          {validation && (
            <div className={`rounded border p-2 text-xs ${
              validation.valid
                ? 'border-green-400/30 bg-green-400/5'
                : 'border-red-400/30 bg-red-400/5'
            }`}>
              {/* Status banner */}
              <div className="flex items-center gap-1.5 mb-1">
                {validation.valid ? (
                  <CheckCircle2 size={13} className="text-green-400" />
                ) : (
                  <XCircle size={13} className="text-red-400" />
                )}
                <span className={`font-medium ${
                  validation.valid ? 'text-green-400' : 'text-red-400'
                }`}>
                  {validation.valid ? 'Validation passed' : 'Validation failed'}
                </span>
              </div>

              {/* Summary */}
              {validation.entry_count && (
                <p className="text-[10px] text-[var(--text)] opacity-50 mb-1">
                  {validation.entry_count.toLocaleString()} entries
                  {validation.sample_columns.length > 0 &&
                    ` · Columns: ${validation.sample_columns.join(', ')}`}
                </p>
              )}

              {/* Errors */}
              {validation.errors.map((e, i) => (
                <div key={i} className="flex items-start gap-1 text-red-400 mt-1">
                  <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                  <span className="text-[10px]">{e.message}</span>
                </div>
              ))}

              {/* Warnings */}
              {validation.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1 text-yellow-400 mt-1">
                  <Info size={10} className="shrink-0 mt-0.5" />
                  <span className="text-[10px]">{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Import error */}
          {importError && (
            <div className="flex items-start gap-1 text-red-400 text-[10px]">
              <AlertTriangle size={10} className="shrink-0 mt-0.5" />
              <span>{importError}</span>
            </div>
          )}

          {/* Name input + Import button */}
          {validation?.valid && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                placeholder="Dictionary name..."
                className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none placeholder:text-[var(--text)]/20"
              />
              <button
                onClick={handleImport}
                disabled={importing || !importName.trim()}
                className="flex items-center gap-1 rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-30 transition-opacity"
              >
                {importing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Plus size={12} />
                )}
                Import
              </button>
            </div>
          )}

          {/* Store-level error */}
          {store.error && (
            <div className="flex items-start gap-1 text-red-400 text-[10px]">
              <AlertTriangle size={10} className="shrink-0 mt-0.5" />
              <span>{store.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
