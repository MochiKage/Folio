import { usePdfStore } from '../stores/pdfStore'

/**
 * Small bus between the StatusBar rotate button and ReaderViewport.
 *
 * ReaderViewport registers a handler that captures the reading anchor
 * (the PDF-space point at the viewport center) BEFORE the rotation is
 * applied, so the scroll position can be restored afterwards. The button
 * cannot do this itself — it has no access to the scroll container.
 *
 * Fallback (no reader mounted): apply the rotation directly.
 */
type RotateHandler = (next: number) => void

const bus: { handler: RotateHandler | null } = { handler: null }

export function requestRotation(next: number): void {
  if (bus.handler) {
    bus.handler(next)
  } else {
    usePdfStore.getState().setRotation(next)
  }
}

export function setRotationHandler(handler: RotateHandler | null): void {
  bus.handler = handler
}
