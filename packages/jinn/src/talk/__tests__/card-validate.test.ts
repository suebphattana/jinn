import { describe, it, expect } from "vitest";
import { validateCard } from "../card-validate.js";

describe("validateCard", () => {
  it("accepts a valid card of each of the 8 types", () => {
    const cards: unknown[] = [
      { id: "c1", type: "text", body: "hello" },
      { id: "c2", type: "stat", value: "42", label: "users" },
      { id: "c3", type: "list", items: [{ text: "one" }, { text: "two" }] },
      { id: "c4", type: "image", src: "https://x/y.png" },
      { id: "c5", type: "image-grid", images: [{ src: "https://x/1.png" }] },
      { id: "c6", type: "status", label: "build", progress: 0.5, state: "running" },
      {
        id: "c7",
        type: "agent-activity",
        agents: [{ id: "a1", name: "Dev", role: "engineer", status: "done" }],
      },
      { id: "c8", type: "link", url: "https://x", label: "open" },
    ];
    for (const card of cards) {
      const result = validateCard(card);
      expect(result.ok, JSON.stringify(card)).toBe(true);
      if (result.ok) expect(result.card).toBe(card);
    }
  });

  it("rejects a card with a missing id", () => {
    const result = validateCard({ type: "text", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/id/);
  });

  it("rejects a card with an empty id", () => {
    expect(validateCard({ id: "", type: "text", body: "hi" }).ok).toBe(false);
  });

  it("rejects an unknown card type", () => {
    const result = validateCard({ id: "c1", type: "frobnicate" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown card type/);
  });

  it("rejects a status card with a bad state", () => {
    const result = validateCard({
      id: "c1",
      type: "status",
      label: "build",
      progress: 0.5,
      state: "exploded",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/state/);
  });

  it("rejects a list card whose items is not an array", () => {
    const result = validateCard({ id: "c1", type: "list", items: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/items/);
  });

  it("rejects a list card whose item lacks string text", () => {
    expect(validateCard({ id: "c1", type: "list", items: [{ foo: 1 }] }).ok).toBe(false);
  });

  it("rejects non-object input (null)", () => {
    expect(validateCard(null).ok).toBe(false);
  });

  it("rejects non-object input (string)", () => {
    expect(validateCard("not a card").ok).toBe(false);
  });

  it("rejects optional title that is not a string", () => {
    expect(
      validateCard({ id: "c1", type: "text", body: "hi", title: 7 }).ok,
    ).toBe(false);
  });

  // --- decision-support variants ---

  it("accepts a valid card of each decision-support type", () => {
    const cards: unknown[] = [
      { id: "d1", type: "choice", prompt: "pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "d2", type: "comparison", columns: ["X", "Y"], rows: [{ label: "Price", cells: ["1", "2"], highlight: 1 }] },
      { id: "d3", type: "approval", summary: "Send it?", details: [{ k: "To", v: "x@y.com" }], danger: true },
      { id: "d4", type: "keyvalue", rows: [{ k: "Uptime", v: "99%", tone: "good" }] },
      { id: "d5", type: "diff", hunks: [{ label: "cfg", before: "a", after: "b" }] },
    ];
    for (const card of cards) {
      const result = validateCard(card);
      expect(result.ok, JSON.stringify(card)).toBe(true);
    }
  });

  it("rejects a choice card with empty options", () => {
    expect(validateCard({ id: "d1", type: "choice", options: [] }).ok).toBe(false);
  });

  it("rejects a choice option missing id or label", () => {
    expect(validateCard({ id: "d1", type: "choice", options: [{ label: "A" }] }).ok).toBe(false);
    expect(validateCard({ id: "d1", type: "choice", options: [{ id: "a" }] }).ok).toBe(false);
  });

  it("rejects a comparison card with non-string cells", () => {
    const result = validateCard({
      id: "d2",
      type: "comparison",
      columns: ["X"],
      rows: [{ label: "Price", cells: [1, 2] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cells/);
  });

  it("rejects an approval card without a string summary", () => {
    expect(validateCard({ id: "d3", type: "approval" }).ok).toBe(false);
  });

  it("rejects a keyvalue row missing k or v", () => {
    expect(validateCard({ id: "d4", type: "keyvalue", rows: [{ k: "only" }] }).ok).toBe(false);
  });

  it("rejects a diff card with empty hunks", () => {
    expect(validateCard({ id: "d5", type: "diff", hunks: [] }).ok).toBe(false);
  });
});
