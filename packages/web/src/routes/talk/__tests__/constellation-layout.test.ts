import { describe, it, expect } from "vitest"
import { visibleThreads, miniDotsFor, MAX_SATELLITES } from "../constellation-layout"
import type { TalkThread } from "../thread-store"
import type { GraphNode } from "../graph-store"

const t = (id: string, over: Partial<TalkThread> = {}): TalkThread => ({
  id, label: id, hue: 120, state: "idle", orbiting: false, ts: 1, ...over,
})
const g = (id: string, parentId: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, parentId, depth: 2, label: id, employee: null, status: "running",
  lastActivity: "2026-06-10T00:00:00Z", ...over,
})

describe("visibleThreads", () => {
  it("shows ALL threads (idle included), working first then newest, capped", () => {
    const threads = [t("old", { ts: 1 }), t("busy", { ts: 2, state: "thinking" }), t("new", { ts: 3 })]
    const v = visibleThreads(threads)
    expect(v.shown.map((x) => x.id)).toEqual(["busy", "new", "old"])
    expect(v.overflow).toBe(0)
  })
  it("caps and reports overflow", () => {
    const threads = Array.from({ length: MAX_SATELLITES + 3 }, (_, i) => t(`x${i}`, { ts: i }))
    const v = visibleThreads(threads)
    expect(v.shown).toHaveLength(MAX_SATELLITES)
    expect(v.overflow).toBe(3)
  })
  it("orders concurrent working threads newest-first (focus = shown[0])", () => {
    // The constellation derives the focused channel as the FIRST non-idle entry,
    // so with several COOs running the newest-active one must lead.
    const threads = [
      t("older-working", { ts: 10, state: "thinking" }),
      t("idle", { ts: 99 }),
      t("newer-working", { ts: 20, state: "thinking" }),
    ]
    const v = visibleThreads(threads)
    expect(v.shown.map((x) => x.id)).toEqual(["newer-working", "older-working", "idle"])
  })
})

describe("miniDotsFor", () => {
  it("returns a thread's depth-2+ descendants, working first, capped at 6", () => {
    const nodes = [
      g("e1", "coo1"), g("e2", "coo1", { status: "idle" }),
      g("e3", "other"),
      ...Array.from({ length: 7 }, (_, i) => g(`m${i}`, "coo1", { status: "idle" })),
    ]
    const dots = miniDotsFor(nodes, "coo1")
    expect(dots).toHaveLength(6)
    expect(dots[0].id).toBe("e1")
    expect(dots.some((d) => d.id === "e3")).toBe(false)
  })
})
