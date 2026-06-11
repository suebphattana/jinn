import { describe, expect, it } from "vitest"
import { activityFor, excerpt, threadActivityReducer } from "../thread-activity"

describe("excerpt", () => {
  it("strips markdown, urls and uuids, flattens whitespace", () => {
    const raw = "**Done!** See https://x.test/r `code` 0b6a7c1e-1111-2222-3333-444455556666\n\nNext   steps"
    expect(excerpt(raw, 140)).toBe("Done! See code Next steps")
  })
  it("caps at max chars with an ellipsis", () => {
    expect(excerpt("word ".repeat(60), 40).length).toBeLessThanOrEqual(40)
    expect(excerpt("word ".repeat(60), 40).endsWith("…")).toBe(true)
  })
  it("returns empty string for empty/noise-only input", () => {
    expect(excerpt("``` ```", 140)).toBe("")
  })
})

describe("activityFor", () => {
  it("maps delegation spawns", () => {
    expect(activityFor({ toolName: "Bash", input: 'curl -X POST /api/sessions {"parentSessionId":"x"}' })).toBe("delegating…")
  })
  it("maps file reads and edits", () => {
    expect(activityFor({ toolName: "Read" })).toBe("reading…")
    expect(activityFor({ toolName: "Edit" })).toBe("editing…")
  })
  it("maps web work and shell, defaults to working", () => {
    expect(activityFor({ toolName: "WebSearch" })).toBe("searching the web…")
    expect(activityFor({ toolName: "Bash", input: "ls -la" })).toBe("running commands…")
    expect(activityFor({ toolName: "SomethingNew" })).toBe("working…")
  })
})

describe("threadActivityReducer", () => {
  it("sets activity, then report clears the live line", () => {
    let m = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "reading…" })
    expect(m.get("a")).toEqual({ activity: "reading…" })
    m = threadActivityReducer(m, { type: "report", id: "a", text: "All done." })
    expect(m.get("a")).toEqual({ reportExcerpt: "All done." })
  })
  it("is referentially stable on no-op updates", () => {
    const m1 = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "x" })
    const m2 = threadActivityReducer(m1, { type: "activity", id: "a", text: "x" })
    expect(m2).toBe(m1)
  })
  it("drops empty report excerpts but still clears activity", () => {
    let m = threadActivityReducer(new Map(), { type: "activity", id: "a", text: "x" })
    m = threadActivityReducer(m, { type: "report", id: "a", text: "" })
    expect(m.get("a")).toEqual({})
  })
})
