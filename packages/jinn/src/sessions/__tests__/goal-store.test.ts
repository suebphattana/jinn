import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getGoal, setGoal, clearGoal } from "../goal-store.js";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-goals-"));
  prevHome = process.env.JINN_HOME;
  process.env.JINN_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("goal-store", () => {
  it("returns null when no goal is set", () => {
    expect(getGoal("discord:123")).toBeNull();
  });

  it("sets and reads back a goal", () => {
    setGoal("discord:123", "ship the feature");
    expect(getGoal("discord:123")).toBe("ship the feature");
  });

  it("trims whitespace on set", () => {
    setGoal("k", "  do the thing  ");
    expect(getGoal("k")).toBe("do the thing");
  });

  it("keeps goals separate per session key", () => {
    setGoal("a", "goal A");
    setGoal("b", "goal B");
    expect(getGoal("a")).toBe("goal A");
    expect(getGoal("b")).toBe("goal B");
  });

  it("replaces an existing goal", () => {
    setGoal("a", "first");
    setGoal("a", "second");
    expect(getGoal("a")).toBe("second");
  });

  it("clears a goal and reports whether one existed", () => {
    setGoal("a", "x");
    expect(clearGoal("a")).toBe(true);
    expect(getGoal("a")).toBeNull();
    expect(clearGoal("a")).toBe(false);
  });

  it("persists across calls (file-backed)", () => {
    setGoal("a", "persistent");
    // A fresh read goes through the file again.
    expect(getGoal("a")).toBe("persistent");
    expect(fs.existsSync(path.join(tmpHome, "goals.json"))).toBe(true);
  });

  it("treats an empty/whitespace stored goal as none", () => {
    setGoal("a", "   ");
    expect(getGoal("a")).toBeNull();
  });

  it("survives a corrupt goals.json", () => {
    fs.writeFileSync(path.join(tmpHome, "goals.json"), "{not valid json");
    expect(getGoal("a")).toBeNull();
    // and can still write over it
    setGoal("a", "recovered");
    expect(getGoal("a")).toBe("recovered");
  });
});
