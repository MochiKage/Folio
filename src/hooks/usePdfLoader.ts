import { useState, useCallback, useEffect, useRef } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { loadPdfFile } from '../lib/pdfLoader'

interface UsePdfLoaderResult {
  pdfDoc: PDFDocumentProxy | null
  loading: boolean
  error: string | null
  loadPdfFromPath: (filePath: string) => Promise<void>
  loadPdfFromData: (data: ArrayBuffer) => Promise<void>
  closePdf: () => void
}

export function usePdfLoader(): UsePdfLoaderResult {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)

  const closePdf = useCallback(() => {
    if (docRef.current) {
      ;(docRef.current as { destroy?: () => void }).destroy?.()
      docRef.current = null
    }
    setPdfDoc(null)
    setError(null)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (docRef.current) {
        ;(docRef.current as { destroy?: () => void }).destroy?.()
      }
    }
  }, [])

  const loadPdfFromData = useCallback(
    async (data: ArrayBuffer) => {
      closePdf()
      setLoading(true)
      setError(null)

      try {
        const { pdfjsLib, getDocumentParamsFromData } = await import('../lib/pdfjs')
        const params = getDocumentParamsFromData(data)
        const loadingTask = pdfjsLib.getDocument(params)
        const doc = await loadingTask.promise
        docRef.current = doc
        setPdfDoc(doc)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load PDF'
        setError(message)
        setPdfDoc(null)
      } finally {
        setLoading(false)
      }
    },
    [closePdf]
  )

  const loadPdfFromPath = useCallback(
    async (filePath: string) => {
      closePdf()
      setLoading(true)
      setError(null)
      try {
        const { doc } = await loadPdfFile(filePath)
        docRef.current = doc
        setPdfDoc(doc)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load PDF'
        setError(message)
        setPdfDoc(null)
      } finally {
        setLoading(false)
      }
    },
    [closePdf],
  )

  return { pdfDoc, loading, error, loadPdfFromPath, loadPdfFromData, closePdf }
}
