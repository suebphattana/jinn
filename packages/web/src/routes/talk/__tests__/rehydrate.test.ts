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
      { id: "u1", role: "user", text: "hello there", partial: false, full: "hello there" },
      { id: "a1", role: "assistant", text: "Hi\nbold reply", partial: false, full: "Hi\nbold reply" },
    ])
  })

  it("maps notification rows to system entries; drops empty bodies", () => {
    const session = {
      messages: [
        { id: "n1", role: "notification", content: "joined" },
        { id: "a1", role: "assistant", content: "   " },
        { id: "a2", role: "assistant", content: "kept" },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n1", kind: "system", event: "info", label: "joined" },
      { id: "a2", role: "assistant", text: "kept", partial: false, full: "kept" },
    ])
  })

  it('maps 📩 Thread "label" reported back to system/reported', () => {
    const session = {
      messages: [
        {
          id: "n1",
          role: "notification",
          content: '📩 Thread "Pravko blog" reported back. Summary here.',
        },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n1", kind: "system", event: "reported", label: "Pravko blog" },
    ])
  })

  it('maps ⚠️ Thread "X" hit an error to system/error', () => {
    const session = {
      messages: [{ id: "n2", role: "notification", content: '⚠️ Thread "X" hit an error' }],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n2", kind: "system", event: "error", label: "X" },
    ])
  })

  it('maps 🔄 Employee "X" resumed to system/reported', () => {
    const session = {
      messages: [
        {
          id: "n3",
          role: "notification",
          content: '🔄 Employee "jinn-dev" has resumed after rate limit cleared.',
        },
      ],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n3", kind: "system", event: "reported", label: "jinn-dev" },
    ])
  })

  it('maps 📩 Employee "X" replied (persisted format) to system/reported', () => {
    const content =
      '📩 Employee "content-lead" replied in child session abc123.\n\nReply preview:\nDone.'
    const session = {
      messages: [{ id: "n4", role: "notification", content }],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n4", kind: "system", event: "reported", label: "content-lead" },
    ])
  })

  it("maps unparseable notification (no emoji, no quotes) to system/info with first 60 chars", () => {
    const content = "Some plain notification message that has no emoji or quotes here"
    const session = {
      messages: [{ id: "n5", role: "notification", content }],
    }
    expect(messagesToEntries(session)).toEqual([
      { id: "n5", kind: "system", event: "info", label: content.slice(0, 60) },
    ])
  })

  it("synthesizes id for notification without an id", () => {
    const session = {
      messages: [{ role: "notification", content: "ping" }],
    }
    const result = messagesToEntries(session)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: "system", event: "info", label: "ping" })
    expect(typeof result[0].id).toBe("string")
  })

  it("falls back to .history and synthesizes ids", () => {
    const session = { history: [{ role: "user", text: "no id here" }] }
    expect(messagesToEntries(session)).toEqual([
      { id: "user-0", role: "user", text: "no id here", partial: false, full: "no id here" },
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
      { id: "c1", title: "content-lead", createdAt: "2026-06-07T10:00:00Z" },
    ])
    expect(threads).toEqual([
      {
        id: "c1",
        label: "content-lead",
        hue: channelHue("content-lead"),
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
