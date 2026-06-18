import { describe, it, expect } from "vitest";
import {
  parseButtons,
  ButtonRegistry,
  BUTTON_CALLBACK_PREFIX,
  MAX_BUTTONS_PER_ROW,
  MAX_BUTTON_ROWS,
  buttonPressText,
} from "../buttons.js";

describe("parseButtons", () => {
  it("returns rows: null when no directive is present", () => {
    const r = parseButtons("just some text");
    expect(r.rows).toBeNull();
    expect(r.cleanedText).toBe("just some text");
  });

  it("parses a single row of buttons", () => {
    const r = parseButtons("Pick one [buttons: Yes | No | Maybe]");
    expect(r.rows).toEqual([["Yes", "No", "Maybe"]]);
    expect(r.cleanedText).toBe("Pick one");
  });

  it("parses multiple rows separated by ;;", () => {
    const r = parseButtons("[buttons: Approve | Reject ;; More info]");
    expect(r.rows).toEqual([["Approve", "Reject"], ["More info"]]);
    expect(r.cleanedText).toBe("");
  });

  it("parses rows separated by newlines inside the directive", () => {
    const r = parseButtons("[buttons: A | B\nC | D]");
    expect(r.rows).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("trims whitespace and drops empty labels", () => {
    const r = parseButtons("[buttons:  Yes  |  | No  ]");
    expect(r.rows).toEqual([["Yes", "No"]]);
  });

  it("is case-insensitive on the directive keyword", () => {
    const r = parseButtons("[BUTTONS: One | Two]");
    expect(r.rows).toEqual([["One", "Two"]]);
  });

  it("clamps to the max buttons per row", () => {
    const labels = Array.from({ length: 10 }, (_, i) => `B${i}`);
    const r = parseButtons(`[buttons: ${labels.join(" | ")}]`);
    expect(r.rows?.[0]).toHaveLength(MAX_BUTTONS_PER_ROW);
  });

  it("clamps to the max rows", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `R${i}`).join(" ;; ");
    const r = parseButtons(`[buttons: ${rows}]`);
    expect(r.rows).toHaveLength(MAX_BUTTON_ROWS);
  });

  it("strips a directive that has no valid labels but yields null rows", () => {
    const r = parseButtons("hello [buttons:   ] world");
    expect(r.rows).toBeNull();
    expect(r.cleanedText).toBe("hello  world".trim());
  });

  it("preserves surrounding text and trims trailing whitespace", () => {
    const r = parseButtons("Question?\n[buttons: A | B]");
    expect(r.cleanedText).toBe("Question?");
    expect(r.rows).toEqual([["A", "B"]]);
  });
});

describe("ButtonRegistry", () => {
  it("registers a label and resolves it back", () => {
    const reg = new ButtonRegistry();
    const data = reg.register("Approve");
    expect(data.startsWith(BUTTON_CALLBACK_PREFIX)).toBe(true);
    expect(reg.resolve(data)).toBe("Approve");
  });

  it("returns null for foreign callback data", () => {
    const reg = new ButtonRegistry();
    expect(reg.resolve("someoneelse:123")).toBeNull();
  });

  it("returns null for unknown ids", () => {
    const reg = new ButtonRegistry();
    expect(reg.resolve(`${BUTTON_CALLBACK_PREFIX}deadbeef`)).toBeNull();
  });

  it("generates distinct ids for repeated labels", () => {
    const reg = new ButtonRegistry();
    const a = reg.register("Same");
    const b = reg.register("Same");
    expect(a).not.toBe(b);
    expect(reg.resolve(a)).toBe("Same");
    expect(reg.resolve(b)).toBe("Same");
  });

  it("evicts oldest entries past the cap", () => {
    const reg = new ButtonRegistry(3);
    const first = reg.register("one");
    reg.register("two");
    reg.register("three");
    reg.register("four"); // pushes out "one"
    expect(reg.size).toBe(3);
    expect(reg.resolve(first)).toBeNull();
  });

  it("expires entries past the TTL", () => {
    const reg = new ButtonRegistry(5000, -1); // already-expired ttl
    const data = reg.register("gone");
    expect(reg.resolve(data)).toBeNull();
  });
});

describe("buttonPressText", () => {
  it("returns the label verbatim", () => {
    expect(buttonPressText("Yes please")).toBe("Yes please");
  });
});
