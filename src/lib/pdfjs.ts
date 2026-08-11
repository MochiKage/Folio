import * as pdfjsLib from 'pdfjs-dist'

// Worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// CMaps and standard fonts served from public/ directory
const CMAP_URL = '/cmaps/'
const STANDARD_FONT_DATA_URL = '/standard_fonts/'

const BASE_PARAMS = {
  cMapUrl: CMAP_URL,
  cMapPacked: true,
  standardFontDataUrl: STANDARD_FONT_DATA_URL,
}

/** Load from a URL (for web-based PDFs) */
export function getDocumentParams(url: string) {
  return { url, ...BASE_PARAMS }
}

/** Load from binary data (for local files read via Tauri fs) */
export function getDocumentParamsFromData(data: ArrayBuffer) {
  return { data, ...BASE_PARAMS }
}

export { pdfjsLib }
