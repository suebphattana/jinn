/**
 * Jinn Talk — orchestrator constellation.
 *
 * The big orb is the orchestrator. When it spawns COO child sessions, it lifts
 * up and shrinks, and each child appears as a satellite orb in a row below it,
 * with an animated link conveying knowledge flowing down (main → child) and
 * results returning (child → main). Children spread out as their count grows and
 * fade out shortly after they finish.
 */
import { useLayoutEffect, useRef, useState } from "react"
import { AuraAvatar } from "./aura-avatar"
import type { AvatarState } from "./types"
import type { TalkChild } from "./use-talk"
import "./constellation.css"

interface ConstellationProps {
  state: AvatarState
  level: number | undefined
  children: TalkChild[]
}

interface Pt { x: number; y: number }

export function Constellation({ state, level, children }: ConstellationProps) {
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
  const hasKids = children.length > 0

  // Orb sizing scales with the smaller viewport dimension (mobile-first).
  const base = Math.max(160, Math.min(Math.min(w, h || w) * 0.62, 340))
  const mainSize = hasKids ? base * 0.72 : base
  const childSize = Math.max(58, Math.min(base * 0.34, 116))

  const mainCenter: Pt = { x: w / 2, y: hasKids ? h * 0.36 : h * 0.5 }

  // Lay children out in a centered row below the orchestrator.
  const n = children.length
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
          {children.map((c, i) => {
            const from: Pt = { x: mainCenter.x, y: mainCenter.y + mainSize * 0.42 }
            const to: Pt = { x: childCenter(i).x, y: childCenter(i).y - childSize * 0.5 }
            const d = linkPath(from, to)
            const active = c.state !== "idle"
            return (
              <g key={c.id} style={{ opacity: c.state === "idle" ? 0.35 : 1, transition: "opacity 450ms ease" }}>
                <path className="cst-link-base" d={d} />
                {active && <path className="cst-link-flow" d={d} />}
                {active && <path className="cst-link-return" d={d} />}
              </g>
            )
          })}
        </svg>
      )}

      {/* Orchestrator (main) orb */}
      {ready && (
        <div
          className="cst-orb"
          style={{ left: mainCenter.x, top: mainCenter.y, zIndex: 2 }}
        >
          <AuraAvatar state={state} level={level} size={Math.round(mainSize)} />
        </div>
      )}

      {/* Satellite (COO child) orbs */}
      {ready && children.map((c, i) => {
        const center = childCenter(i)
        const isNew = !mountedRef.current.has(c.id)
        if (isNew) mountedRef.current.add(c.id)
        return (
          <div
            key={c.id}
            className={`cst-orb ${isNew ? "cst-orb-enter" : ""} ${c.state === "idle" ? "cst-orb-leaving" : ""}`}
            style={{ left: center.x, top: center.y, zIndex: 3 }}
          >
            <AuraAvatar state={c.state === "idle" ? "idle" : "thinking"} size={Math.round(childSize)} />
            {c.label && <span className="cst-orb-label">{c.label}</span>}
          </div>
        )
      })}
    </div>
  )
}
