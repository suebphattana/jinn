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

    await flushRejoinNotice(new Map([["discord", stopped]]), undefined, { maxWaitMs: 30, pollMs: 10 });

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

  it("resumes the named session via the manager, then clears the marker", async () => {
    const session = {
      id: "sess-1",
      source: "discord",
      connector: "discord",
      sessionKey: "discord:chan-1",
      replyContext: { channel: "chan-1", thread: null },
      transportMeta: null,
      status: "interrupted",
      userId: null,
    };
    vi.doMock("../../sessions/registry.js", () => ({
      getSession: (id: string) => (id === "sess-1" ? session : undefined),
    }));

    const { flushRejoinNotice, writeRejoinNotice } = await import("../rejoin.js");
    writeRejoinNotice({
      connector: "discord",
      channel: "chan-1",
      text: "✅ Back online",
      sessionId: "sess-1",
      resumePrompt: "continue your work",
    });

    const { connector, sends } = runningConnector();
    const route = vi.fn(async () => ({ sessionId: "sess-1" }));
    const manager = { route } as any;

    await flushRejoinNotice(new Map([["discord", connector]]), manager);

    // Brief notice still sent for instant feedback.
    expect(sends).toEqual([{ channel: "chan-1", text: "✅ Back online" }]);
    // And the session was re-engaged with our resume prompt.
    expect(route).toHaveBeenCalledTimes(1);
    const msg = (route.mock.calls[0] as any[])[0];
    expect(msg.sessionKey).toBe("discord:chan-1");
    expect(msg.text).toBe("continue your work");
    expect(fs.existsSync(markerPath())).toBe(false);
    vi.doUnmock("../../sessions/registry.js");
  });

  it("resumes an idle session too (status drifted after boot)", async () => {
    vi.doMock("../../sessions/registry.js", () => ({
      getSession: () => ({
        id: "sess-idle", source: "discord", connector: "discord",
        sessionKey: "discord:k", replyContext: { channel: "k" }, transportMeta: null,
        status: "idle", userId: null,
      }),
    }));
    const { flushRejoinNotice, writeRejoinNotice } = await import("../rejoin.js");
    writeRejoinNotice({ connector: "discord", channel: "k", text: "back", sessionId: "sess-idle" });

    const { connector } = runningConnector();
    const route = vi.fn(async () => ({ sessionId: "sess-idle" }));
    await flushRejoinNotice(new Map([["discord", connector]]), { route } as any);

    expect(route).toHaveBeenCalledTimes(1);
    vi.doUnmock("../../sessions/registry.js");
  });

  it("skips resume when the session is paused on a usage limit (waiting)", async () => {
    vi.doMock("../../sessions/registry.js", () => ({
      getSession: () => ({
        id: "sess-wait", source: "discord", connector: "discord",
        sessionKey: "k", replyContext: {}, transportMeta: null,
        status: "waiting", userId: null,
      }),
    }));
    const { flushRejoinNotice, writeRejoinNotice } = await import("../rejoin.js");
    writeRejoinNotice({ connector: "discord", channel: "c", text: "back", sessionId: "sess-wait" });

    const { connector } = runningConnector();
    const route = vi.fn();
    await flushRejoinNotice(new Map([["discord", connector]]), { route } as any);

    expect(route).not.toHaveBeenCalled();
    vi.doUnmock("../../sessions/registry.js");
  });
});
