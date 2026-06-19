import { describe, it, expect } from "vitest";
import { OpenRouterEngine } from "../openrouter.js";
import { engineAvailable, effortLevelsForModel, buildRegistry, OPENROUTER_MODELS } from "../../shared/models.js";
import type { JinnConfig } from "../../shared/types.js";

function cfg(openrouter?: { apiKey?: string; model?: string }): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
      ...(openrouter ? { openrouter } : {}),
    },
  } as unknown as JinnConfig;
}

describe("OpenRouter registry", () => {
  it("is unavailable without an API key", () => {
    expect(engineAvailable(cfg(), "openrouter")).toBe(false);
  });

  it("is available once an API key is set", () => {
    expect(engineAvailable(cfg({ apiKey: "sk-or-x" }), "openrouter")).toBe(true);
  });

  it("exposes the fixed model catalog", () => {
    const reg = buildRegistry(cfg({ apiKey: "sk-or-x" }));
    const ids = reg.openrouter.models.map((m) => m.id);
    expect(ids).toEqual(OPENROUTER_MODELS.map((m) => m.id));
    expect(ids).toContain("anthropic/claude-sonnet-4.6");
  });

  it("honours a pinned default model", () => {
    const reg = buildRegistry(cfg({ apiKey: "k", model: "google/gemini-3.5-flash" }));
    expect(reg.openrouter.defaultModel).toBe("google/gemini-3.5-flash");
  });

  it("openrouter models do not support effort", () => {
    expect(effortLevelsForModel(cfg({ apiKey: "k" }), "openrouter", "deepseek/deepseek-v4-pro")).toEqual([]);
  });
});

describe("OpenRouterEngine", () => {
  it("returns an actionable error when no API key is configured", async () => {
    const engine = new OpenRouterEngine(() => cfg());
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.result).toBe("");
    expect(r.error).toMatch(/API key/i);
    expect(r.sessionId).toBeTruthy();
  });
});
