import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pdfjsLib, getDocumentParamsFromData } from './pdfjs'

/**
 * Load a PDF file from disk (via Tauri FS plugin) and return the
 * PDF.js document proxy.  This is a standalone function so it can
 * be called from anywhere — the React hook and the LibraryPanel
 * both use it.
 */
export async function loadPdfFile(
  filePath: string,
): Promise<{ doc: PDFDocumentProxy; name: string; path: string }> {
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const data = await readFile(filePath)
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer

  const params = getDocumentParamsFromData(buffer)
  const loadingTask = pdfjsLib.getDocument(params)
  const doc = await loadingTask.promise

  const name = filePath.split(/[/\\]/).pop() || 'Untitled'
  return { doc, name, path: filePath }
}
