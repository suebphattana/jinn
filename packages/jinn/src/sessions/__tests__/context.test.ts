import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContext } from "../context.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

// These tests lock the CURRENT output of buildContext after the "context hygiene"
// refactor: the static COO operating-manual base was dropped (engines auto-ingest
// CLAUDE.md/AGENTS.md), buildDelegationProtocol was deleted, the COO identity is a
// slim 3-line anchor, and the self-evolution block is onboarding-only.

const baseOpts = {
  source: "slack",
  channel: "C123",
  user: "the operator",
};

const minimalEmployee: Employee = {
  name: "pravko-lead",
  displayName: "Pravko Lead",
  department: "pravko",
  rank: "manager",
  engine: "claude",
  model: "opus",
  persona: "You lead the Pravko legal-AI team.",
};

describe("buildContext — COO (no employee)", () => {
  it("emits the slim COO identity anchor and points at the operating manual", () => {
    const out = buildContext({ ...baseOpts });
    // Slim 3-line identity anchor (default portalName = "Jinn")
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("COO of the user's AI organization");
    // Anchor points at the auto-loaded manual rather than duplicating it
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("AGENTS.md");
  });

  it("includes the Current session section", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("## Current session");
  });

  it("does NOT inline the removed static operating manual / delegation protocol", () => {
    const out = buildContext({ ...baseOpts });
    // The long static base prose is gone — these markers must not appear.
    expect(out).not.toContain("Core Principles");
    expect(out).not.toContain("Delegation protocol");
    expect(out).not.toContain("## Delegation");
  });

  it("does not emit the employee identity section in COO mode", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("You are an AI employee in the");
    expect(out).not.toContain("## Your persona");
  });
});

describe("buildContext — employee mode", () => {
  it("emits the employee identity section instead of the COO anchor", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee });
    expect(out).toContain("# You are Pravko Lead");
    expect(out).toContain("You are an AI employee in the Jinn gateway system.");
    expect(out).toContain("## Your persona");
    expect(out).toContain("You lead the Pravko legal-AI team.");
    // The employee section carries the role block, not the COO "manual" anchor.
    expect(out).toContain("**Department**: pravko");
    expect(out).toContain("**Rank**: manager");
    // The COO-only anchor wording must NOT appear for an employee.
    expect(out).not.toContain("COO of the user's AI organization");
  });
});

describe("buildContext — Current session reflects passed opts", () => {
  it("reflects sessionId, channel and user", () => {
    const out = buildContext({
      ...baseOpts,
      sessionId: "sess-abc-123",
      user: "Operator Bob",
    });
    expect(out).toContain("- Session ID: sess-abc-123");
    expect(out).toContain("- User: Operator Bob");
    expect(out).toContain("C123");
  });

  it("renders a named channel when channelName is provided", () => {
    const out = buildContext({
      ...baseOpts,
      channel: "C999",
      channelName: "ventures",
    });
    expect(out).toContain("- Channel: #ventures (C999)");
  });

  it("labels a slack DM channel", () => {
    const out = buildContext({
      ...baseOpts,
      source: "slack",
      channel: "D456",
    });
    expect(out).toContain("- Channel: Direct Message (D456)");
  });
});

describe("buildContext — config awareness", () => {
  it("emits the configuration section reflecting the passed config", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude", claude: { model: "opus" } },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).toContain("## Current configuration");
    expect(out).toContain("- Default engine: claude");
    expect(out).toContain("http://127.0.0.1:7799");
  });

  it("omits the configuration section when no config is passed", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("## Current configuration");
  });
});

describe("buildContext — self-evolution is omitted when configured", () => {
  // In this environment ~/.jinn/knowledge/user-profile.md is populated (>50 chars),
  // so buildEvolutionContext returns null → no onboarding block in steady state.
  it("does not emit the onboarding self-evolution block for a configured install", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("ONBOARDING MODE");
  });

  it("never emits self-evolution in employee mode", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee });
    expect(out).not.toContain("## Self-evolution");
    expect(out).not.toContain("ONBOARDING MODE");
  });
});

describe("buildContext — self-evolution appears ONLY for a fresh install", () => {
  // Onboarding hinges on JINN_HOME/knowledge/user-profile.md being missing/tiny.
  // JINN_HOME is resolved at module-load from process.env.JINN_HOME, so we point
  // it at a temp dir WITHOUT a profile and re-import the module graph.
  let tmpHome: string;
  const prevHome = process.env.JINN_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-ctx-"));
    process.env.JINN_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = prevHome;
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("emits ONBOARDING MODE when user-profile.md is absent", async () => {
    const { buildContext: freshBuild } = await import("../context.js");
    const out = freshBuild({ ...baseOpts });
    expect(out).toContain("## Self-evolution");
    expect(out).toContain("ONBOARDING MODE");
  });

  it("omits ONBOARDING MODE once user-profile.md is populated", async () => {
    fs.mkdirSync(path.join(tmpHome, "knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, "knowledge", "user-profile.md"),
      "# the operator\nSolo indie developer running several apps. This profile is well past fifty chars.",
    );
    const { buildContext: freshBuild } = await import("../context.js");
    const out = freshBuild({ ...baseOpts });
    expect(out).not.toContain("ONBOARDING MODE");
  });
});

describe("buildContext — maxChars trimming", () => {
  it("stays within a configured maxChars cap by trimming optional/standard sections", () => {
    const cap = 1200;
    const config = {
      gateway: { host: "127.0.0.1", port: 7777 },
      engines: { default: "claude", claude: { model: "opus" } },
      context: { maxChars: cap },
    } as unknown as JinnConfig;
    const out = buildContext({
      ...baseOpts,
      config,
      connectors: ["slack"],
    });
    // Trimming is best-effort by tier; the essential identity + session must survive.
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("## Current session");
    // It should be dramatically smaller than the untrimmed (no-cap) output.
    const uncapped = buildContext({ ...baseOpts, connectors: ["slack"] });
    expect(out.length).toBeLessThan(uncapped.length);
  });

  it("does not trim when output is under the default cap", () => {
    const out = buildContext({ ...baseOpts });
    expect(out.length).toBeLessThan(100_000);
    // Essential sections present and intact.
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("## Current session");
  });
});
