import { useState, useEffect, useRef } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { usePdfStore } from '../stores/pdfStore'

interface OutlineNode {
  title: string
  dest?: string | unknown[]
  items: OutlineNode[]
}

export default function OutlinePanel() {
  const activeDocId = usePdfStore((s) => s.activeDocId)
  const getActiveDoc = usePdfStore((s) => s.getActiveDoc)
  const jumpToPage = usePdfStore((s) => s.jumpToPage)

  const activeDoc = getActiveDoc()
  const pdfDocRef = useRef(activeDoc?.doc ?? null)
  if (activeDocId && activeDoc?.doc) pdfDocRef.current = activeDoc.doc
  else if (!activeDocId) pdfDocRef.current = null

  const [outline, setOutline] = useState<OutlineNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pageMap, setPageMap] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)

  // Resolve page number for an outline destination
  async function resolvePage(dest: string | unknown[]): Promise<number> {
    const doc = pdfDocRef.current
    if (!doc) return 0
    try {
      let ref: unknown
      if (typeof dest === 'string') {
        const resolved = await doc.getDestination(dest)
        ref = resolved?.[0]
      } else if (Array.isArray(dest) && dest.length > 0) {
        ref = dest[0]
      }
      if (ref) return (await doc.getPageIndex(ref as never)) + 1
    } catch {}
    return 0
  }

  // Recursively resolve ALL page numbers
  async function resolveAllPages(items: typeof outline): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    for (const item of items) {
      if (item.dest !== undefined) {
        const p = await resolvePage(item.dest)
        if (p > 0) map.set(item.title, p)
      }
      if (item.items.length > 0) {
        const child = await resolveAllPages(item.items)
        child.forEach((v, k) => map.set(k, v))
      }
    }
    return map
  }

  useEffect(() => {
    const doc = pdfDocRef.current
    if (!doc) { setOutline([]); return }

    setLoading(true)
    doc.getOutline().then(async (items) => {
      if (!items?.length) { setOutline([]); setLoading(false); return }

      const convert = (node: (typeof items)[0]): OutlineNode => ({
        title: node.title || '(untitled)',
        dest: typeof node.dest === 'string' ? node.dest : Array.isArray(node.dest) ? node.dest : undefined,
        items: (node.items || []).map(convert),
      })

      const nodes = items.map(convert)
      setOutline(nodes)

      // Resolve page numbers for ALL levels
      const map = await resolveAllPages(nodes)
      setPageMap(map)

      // Auto-expand first level
      setExpanded(new Set(items.map((i) => i.title || '')))
      setLoading(false)
    }).catch(() => { setOutline([]); setLoading(false) })
  }, [activeDocId])

  const handleClick = async (item: OutlineNode) => {
    // Use cached page number from map
    let pageNum = pageMap.get(item.title) ?? 0
    if (pageNum === 0 && item.dest !== undefined) {
      pageNum = await resolvePage(item.dest)
    }
    if (pageNum > 0) {
      jumpToPage(pageNum)
    }
  }

  const toggle = (t: string) => setExpanded((prev) => {
    const next = new Set(prev)
    next.has(t) ? next.delete(t) : next.add(t)
    return next
  })

  const renderItems = (items: OutlineNode[], depth = 0) =>
    items.map((item, i) => (
      <div key={`${depth}-${i}`}>
        <button
          onClick={() => {
            if (item.items.length > 0) toggle(item.title)
            if (item.items.length === 0 || expanded.has(item.title)) handleClick(item)
          }}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--border)]/30"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {item.items.length > 0 ? (
            <span className="shrink-0">{expanded.has(item.title) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
          ) : <span className="w-3 shrink-0" />}
          <span className="min-w-0 flex-1 truncate text-[var(--text)] opacity-70">{item.title}</span>
          {pageMap.has(item.title) && (
            <span className="ml-1 shrink-0 text-[10px] tabular-nums text-[var(--text)] opacity-30">{pageMap.get(item.title)}</span>
          )}
        </button>
        {expanded.has(item.title) && item.items.length > 0 && renderItems(item.items, depth + 1)}
      </div>
    ))

  if (loading) return <p className="p-2 text-center text-xs text-[var(--text)] opacity-40">Loading outline...</p>
  if (outline.length === 0) return <p className="p-2 text-center text-xs text-[var(--text)] opacity-40">No table of contents available</p>
  return <div className="space-y-0.5 py-1">{renderItems(outline)}</div>
}
