/**
 * Jinn Talk — rehydration transforms (server snapshot → UI state).
 */
import { describe, it, expect } from "vitest"
import { messagesToEntries, childrenToThreads } from "../rehydrate"
import { channelHue } from "../channel-identity"

describe("messagesToEntries", () => {
  it("maps user/assistant messages to finalized entries (markdown stripped)", () => {
    const session = {
      messages: [
        { id: "u1", role: "user", content: "hello there" },
        { id: "a1", role: "assistant", content: "## Hi\n**bold** reply" },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "u1", role: "user", text: "hello there", partial: false },
      { id: "a1", role: "assistant", text: "Hi\nbold reply", partial: false },
    ])
  })

  it("drops notifications and empty bodies", () => {
    const session = {
      messages: [
        { id: "n1", role: "notification", content: "joined" },
        { id: "a1", role: "assistant", content: "   " },
        { id: "a2", role: "assistant", content: "kept" },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "a2", role: "assistant", text: "kept", partial: false },
    ])
  })

  it("falls back to .history and synthesizes ids", () => {
    const session = { history: [{ role: "user", text: "no id here" }] }
    expect(messagesToEntries(session)).toEqual([
      { id: "user-0", role: "user", text: "no id here", partial: false },
    ])
  })

  it("returns [] for missing/!array history", () => {
    expect(messagesToEntries(undefined)).toEqual([])
    expect(messagesToEntries({})).toEqual([])
    expect(messagesToEntries({ messages: "nope" })).toEqual([])
  })
})

describe("childrenToThreads", () => {
  it("rebuilds parked idle threads with stable hue", () => {
    const threads = childrenToThreads([
      { id: "c1", title: "pravko-lead", createdAt: "2026-06-07T10:00:00Z" },
    ])
    expect(threads).toEqual([
      {
        id: "c1",
        label: "pravko-lead",
        hue: channelHue("pravko-lead"),
        state: "idle",
        orbiting: false,
        ts: Date.parse("2026-06-07T10:00:00Z"),
      },
    ])
  })

  it("applies a label override over the server title", () => {
    const threads = childrenToThreads([{ id: "c1", title: "raw title" }], {
      c1: "My Topic",
    })
    expect(threads[0].label).toBe("My Topic")
    // Hue is still keyed off the server title (stable identity), not the override.
    expect(threads[0].hue).toBe(channelHue("raw title"))
  })

  it("skips entries without an id and returns [] for non-arrays", () => {
    expect(childrenToThreads([{ title: "x" }])).toEqual([])
    expect(childrenToThreads(undefined)).toEqual([])
  })

  it("filters out dismissed (tombstoned) thread ids", () => {
    const threads = childrenToThreads(
      [{ id: "c1", title: "keep" }, { id: "c2", title: "gone" }],
      {},
      ["c2"],
    )
    expect(threads.map((t) => t.id)).toEqual(["c1"])
  })
})
