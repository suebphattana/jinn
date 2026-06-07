/**
 * stripMarkdown — drops markdown syntax, preserves newlines for sentence splits.
 */
import { describe, it, expect } from "vitest"
import { stripMarkdown } from "../strip-markdown"

describe("stripMarkdown", () => {
  it("strips headings", () => {
    expect(stripMarkdown("## Hello there")).toBe("Hello there")
    expect(stripMarkdown("###### Deep")).toBe("Deep")
  })

  it("strips bold/italic markers", () => {
    expect(stripMarkdown("**bold** and _italic_ and ***both***")).toBe(
      "bold and italic and both",
    )
  })

  it("strips list markers at line start", () => {
    expect(stripMarkdown("- one\n- two")).toBe("one\ntwo")
    expect(stripMarkdown("1. first\n2) second")).toBe("first\nsecond")
    expect(stripMarkdown("• bullet")).toBe("bullet")
  })

  it("strips blockquotes, inline code, and code fences", () => {
    expect(stripMarkdown("> quoted")).toBe("quoted")
    expect(stripMarkdown("run `npm test` now")).toBe("run npm test now")
    expect(stripMarkdown("```ts\ncode\n```")).toBe("code")
  })

  it("turns links into their label text", () => {
    expect(stripMarkdown("see [the docs](https://x.com/y)")).toBe("see the docs")
  })

  it("preserves newlines but collapses horizontal whitespace", () => {
    expect(stripMarkdown("a    b\n\n\nc   d")).toBe("a b\n\nc d")
  })

  it("leaves plain text untouched (trimmed)", () => {
    expect(stripMarkdown("  Just plain text.  ")).toBe("Just plain text.")
  })

  it("does not split decimals or eat mid-token characters", () => {
    expect(stripMarkdown("Pi is 3.14 today")).toBe("Pi is 3.14 today")
  })
})
