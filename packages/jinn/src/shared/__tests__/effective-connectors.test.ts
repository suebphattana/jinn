import { describe, it, expect } from "vitest";
import { effectiveConnectorInstances } from "../config.js";
import type { JinnConfig } from "../types.js";

function cfg(connectors: any): JinnConfig {
  return { connectors } as unknown as JinnConfig;
}

describe("effectiveConnectorInstances", () => {
  it("returns explicit instances unchanged", () => {
    const r = effectiveConnectorInstances(
      cfg({ instances: [{ id: "discord", type: "discord", botToken: "x" }] }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "discord", type: "discord" });
  });

  it("synthesizes an instance from a top-level connector block", () => {
    const r = effectiveConnectorInstances(
      cfg({ telegram: { botToken: "t", allowFrom: [1] } }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "telegram", type: "telegram", botToken: "t" });
    expect(r[0].allowFrom).toEqual([1]);
  });

  it("merges instances and top-level blocks", () => {
    const r = effectiveConnectorInstances(
      cfg({
        instances: [{ id: "discord", type: "discord", botToken: "d" }],
        telegram: { botToken: "t" },
      }),
    );
    const byId = Object.fromEntries(r.map((i) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual(["discord", "telegram"]);
  });

  it("explicit instance wins over a same-type top-level block", () => {
    const r = effectiveConnectorInstances(
      cfg({
        instances: [{ id: "telegram", type: "telegram", botToken: "from-instance" }],
        telegram: { botToken: "from-toplevel" },
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0].botToken).toBe("from-instance");
  });

  it("ignores empty top-level blocks (no credentials)", () => {
    const r = effectiveConnectorInstances(cfg({ discord: { botToken: "" } }));
    expect(r).toHaveLength(0);
  });

  it("accepts a slack block authenticated by appToken", () => {
    const r = effectiveConnectorInstances(cfg({ slack: { appToken: "xapp-1" } }));
    expect(r).toEqual([expect.objectContaining({ id: "slack", type: "slack" })]);
  });

  it("synthesizes whatsapp even without a token (QR auth)", () => {
    const r = effectiveConnectorInstances(cfg({ whatsapp: {} }));
    expect(r).toEqual([expect.objectContaining({ id: "whatsapp", type: "whatsapp" })]);
  });

  it("handles a missing connectors section", () => {
    expect(effectiveConnectorInstances({} as JinnConfig)).toEqual([]);
  });
});
