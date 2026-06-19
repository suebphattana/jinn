import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-rejoin-"));
  fs.mkdirSync(path.join(tmpHome, "tmp"), { recursive: true });
  prevHome = process.env.JINN_HOME;
  process.env.JINN_HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function markerPath() {
  return path.join(tmpHome, "tmp", "rejoin.json");
}

function runningConnector() {
  const sends: Array<{ channel: string; text: string }> = [];
  return {
    sends,
    connector: {
      getHealth: () => ({ status: "running" }),
      sendMessage: async (t: { channel: string }, text: string) => {
        sends.push({ channel: t.channel, text });
      },
    } as any,
  };
}

describe("flushRejoinNotice", () => {
  it("does nothing when no marker exists", async () => {
    const { flushRejoinNotice } = await import("../rejoin.js");
    const { connector, sends } = runningConnector();
    await flushRejoinNotice(new Map([["discord", connector]]));
    expect(sends).toHaveLength(0);
  });

  it("sends the notice via the connector and deletes the marker", async () => {
    const { flushRejoinNotice, writeRejoinNotice } = await import("../rejoin.js");
    writeRejoinNotice({ connector: "discord", channel: "555", text: "✅ Back online" });
    expect(fs.existsSync(markerPath())).toBe(true);

    const { connector, sends } = runningConnector();
    await flushRejoinNotice(new Map([["discord", connector]]));

    expect(sends).toEqual([{ channel: "555", text: "✅ Back online" }]);
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it("waits for the connector then gives up + clears marker if never running", async () => {
    const { flushRejoinNotice, writeRejoinNotice } = await import("../rejoin.js");
    writeRejoinNotice({ connector: "discord", channel: "1", text: "hi" });
    const stopped = { getHealth: () => ({ status: "stopped" }), sendMessage: vi.fn() } as any;

    await flushRejoinNotice(new Map([["discord", stopped]]), { maxWaitMs: 30, pollMs: 10 });

    expect(stopped.sendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it("ignores a malformed marker", async () => {
    const { flushRejoinNotice } = await import("../rejoin.js");
    fs.writeFileSync(markerPath(), "{ not json");
    const { connector, sends } = runningConnector();
    await flushRejoinNotice(new Map([["discord", connector]]));
    expect(sends).toHaveLength(0);
  });

  it("defaults to the discord connector when none is named", async () => {
    const { flushRejoinNotice, writeRejoinNotice } = await import("../rejoin.js");
    writeRejoinNotice({ channel: "9", text: "yo" } as any);
    const { connector, sends } = runningConnector();
    await flushRejoinNotice(new Map([["discord", connector]]));
    expect(sends).toEqual([{ channel: "9", text: "yo" }]);
  });
});
