/**
 * Jinn Talk — orchestrator constellation.
 *
 * The big orb is the orchestrator. When it spawns COO child sessions, it lifts
 * up and shrinks, and each child appears as a satellite orb in a row below it,
 * with an animated link conveying knowledge flowing down (main → child) and
 * results returning (child → main). All threads always render — idle ones are
 * dimmed rather than hidden (Mission Control). Each satellite can carry a row
 * of mini-dots for its depth-2+ employee descendants.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { AuraAvatar } from "./aura-avatar"
import type { AvatarState } from "./types"
import type { TalkThread } from "./use-talk"
import { isWorking, type GraphNode } from "./graph-store"
import { visibleThreads, miniDotsFor } from "./constellation-layout"
import "./constellation.css"

interface ConstellationProps {
  state: AvatarState
  level: number | undefined
  threads: TalkThread[]
  /** Full delegation graph (depth-1 = COO threads, depth-2+ = employee children). */
  graph: GraphNode[]
  /** Open the read-only chat popup for a satellite (COO child) session. */
  onOpenSession?: (id: string) => void
}

interface Pt { x: number; y: number }

export function Constellation({ state, level, threads, graph, onOpenSession }: ConstellationProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  // Track which child ids have already mounted, so only NEW ones pop in.
  const mountedRef = useRef<Set<string>>(new Set())

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w, h } = dims
  const ready = w > 0 && h > 0
  // All threads render as satellites — idle ones are dimmed, never hidden.
  // Working threads float to the front; overflow beyond MAX_SATELLITES shows a chip.
  const { shown: sats, overflow } = visibleThreads(threads)
  const hasKids = sats.length > 0

  // The channel in focus = the most recently active thread still working
  // (non-idle). visibleThreads already sorts working-first, newest-first, so a
  // plain find yields it. The main orb morphs toward its hue; its satellite +
  // link are highlighted, the others recede. Null → pure AURA identity.
  const activeChild = sats.find((c) => c.state !== "idle") ?? null
  const activeId = activeChild?.id ?? null
  const mainHue = activeChild?.hue

  // Orb sizing scales with the smaller viewport dimension (mobile-first).
  const base = Math.max(160, Math.min(Math.min(w, h || w) * 0.62, 340))
  const mainSize = hasKids ? base * 0.72 : base
  const childSize = Math.max(58, Math.min(base * 0.34, 116))

  const mainCenter: Pt = { x: w / 2, y: hasKids ? h * 0.36 : h * 0.5 }

  // Lay satellites out in a centered row below the orchestrator.
  const n = sats.length
  const rowY = h * 0.7
  const gap = n > 0 ? Math.min((w * 0.84) / n, childSize * 1.75) : 0
  const childCenter = (i: number): Pt => ({
    x: w / 2 + (i - (n - 1) / 2) * gap,
    y: rowY,
  })

  // A gently curved link path from a→b (slight downward bow).
  const linkPath = (a: Pt, b: Pt) => {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2 + 14
    return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`
  }

  return (
    <div ref={rootRef} className="cst-root">
      {ready && hasKids && (
        <svg className="cst-links" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {sats.map((c, i) => {
            const from: Pt = { x: mainCenter.x, y: mainCenter.y + mainSize * 0.42 }
            const to: Pt = { x: childCenter(i).x, y: childCenter(i).y - childSize * 0.5 }
            const d = linkPath(from, to)
            const flowing = c.state !== "idle"
            const isFocused = c.id === activeId
            // The focused channel's tether wears that channel's hue (a shared-
            // colour link making "the main orb is talking to THIS one" legible).
            const stroke = isFocused ? `hsl(${c.hue} 72% 58%)` : undefined
            const opacity = c.state === "idle" ? 0.3 : isFocused ? 1 : 0.5
            return (
              <g key={c.id} style={{ opacity, transition: "opacity 450ms ease" }}>
                <path className="cst-link-base" d={d} style={stroke ? { stroke } : undefined} />
                {flowing && <path className="cst-link-flow" d={d} style={stroke ? { stroke } : undefined} />}
                {flowing && <path className="cst-link-return" d={d} style={stroke ? { stroke } : undefined} />}
              </g>
            )
          })}
        </svg>
      )}

      {/* Orchestrator (main) orb — morphs toward the focused channel's hue. */}
      {ready && (
        <div
          className="cst-orb"
          style={{ left: mainCenter.x, top: mainCenter.y, zIndex: 2 }}
        >
          <AuraAvatar state={state} level={level} size={Math.round(mainSize)} channelHue={mainHue} />
        </div>
      )}

      {/* Satellite (COO thread) orbs — each painted with its own channel hue. */}
      {ready && sats.map((c, i) => {
        const center = childCenter(i)
        const isNew = !mountedRef.current.has(c.id)
        if (isNew) mountedRef.current.add(c.id)
        const isFocused = c.id === activeId
        const clickable = !!onOpenSession
        const openLabel = `Open conversation: ${c.label || "thread"}`
        return (
          <div
            key={c.id}
            className={`cst-orb ${isNew ? "cst-orb-enter" : ""}${clickable ? " cst-orb-clickable" : ""}`}
            data-focused={isFocused}
            data-idle={c.state === "idle"}
            style={{
              left: center.x,
              top: center.y,
              zIndex: isFocused ? 4 : 3,
              opacity: isFocused ? 1 : c.state === "idle" ? 0.4 : 0.6,
            }}
            {...(clickable
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": openLabel,
                  title: openLabel,
                  onClick: () => onOpenSession?.(c.id),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onOpenSession?.(c.id)
                    }
                  },
                }
              : {})}
          >
            {/* Inner scaler: the focused satellite swells, the others recede —
                a transform-only highlight that never re-inits the orb canvas. */}
            <div className="cst-orb-scale" data-active={isFocused}>
              <AuraAvatar state={c.state === "idle" ? "idle" : "thinking"} size={Math.round(childSize)} channelHue={c.hue} />
            </div>
            {c.label && <span className="cst-orb-label">{c.label}</span>}
            {(() => {
              const dots = miniDotsFor(graph, c.id)
              if (dots.length === 0) return null
              return (
                <div className="cst-minis" aria-label={`${dots.length} sub-agents`}>
                  {dots.map((d) => (
                    <span
                      key={d.id}
                      className={`cst-mini${isWorking(d) ? " cst-mini-working" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open sub-agent: ${d.label}`}
                      title={`${d.label}${d.employee ? ` (${d.employee})` : ""} — ${d.status}`}
                      style={{ background: `hsl(${c.hue} 64% ${isWorking(d) ? 62 : 38}%)` }}
                      onClick={(e) => { e.stopPropagation(); onOpenSession?.(d.id) }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          e.stopPropagation()
                          onOpenSession?.(d.id)
                        }
                      }}
                    />
                  ))}
                </div>
              )
            })()}
          </div>
        )
      })}

      {ready && overflow > 0 && (
        <div className="cst-overflow" style={{ left: w / 2, top: rowY + childSize * 0.85 }}>
          +{overflow} more
        </div>
      )}
    </div>
  )
}
