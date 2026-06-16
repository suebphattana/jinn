import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { StreamDelta, EngineResult } from "../../shared/types.js";

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  close: (code: number | null) => void;
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

const spawnCalls: SpawnCall[] = [];

function makeFakeProc(): FakeProc {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout,
    stderr,
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 6363,
    kill: () => true,
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return p;
    },
    emitStdout(s) {
      stdout.emit("data", Buffer.from(s));
    },
    emitStderr(s) {
      stderr.emit("data", Buffer.from(s));
    },
    close(code) {
      p.exitCode = code;
      handlers["close"]?.(code);
    },
  };
  return p;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

import { buildGrokHeadlessArgs, GrokEngine, parseGrokJsonLine } from "../grok.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

async function runWith(
  stdoutLines: string[],
  opts: Record<string, unknown> = {},
  closeCode = 0,
): Promise<{ result: EngineResult; deltas: StreamDelta[]; call: SpawnCall }> {
  const deltas: StreamDelta[] = [];
  const engine = new GrokEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "jinn-session-1",
    model: "grok-build",
    onStream: (d: StreamDelta) => deltas.push(d),
    ...opts,
  } as any);

  await flush();
  const call = spawnCalls[spawnCalls.length - 1];
  expect(call).toBeDefined();
  if (stdoutLines.length) call.proc.emitStdout(stdoutLines.join("\n") + "\n");
  call.proc.close(closeCode);
  const result = await promise;
  return { result, deltas, call };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("GrokEngine args", () => {
  it("builds headless streaming-json args", () => {
    const args = buildGrokHeadlessArgs({
      prompt: "ignored",
      cwd: "/workspace",
      model: "grok-build",
      cliFlags: ["--chrome", "--some-grok-flag"],
    } as any, "do work", "sess-1");

    expect(args).toContain("--no-auto-update");
    expect(args).toContain("--always-approve");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("streaming-json");
    expect(args[args.indexOf("--model") + 1]).toBe("grok-build");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/workspace");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--some-grok-flag");
    expect(args.slice(-2)).toEqual(["-p", "do work"]);
  });

  it("uses --resume for headless follow-up turns", () => {
    const args = buildGrokHeadlessArgs({
      prompt: "ignored",
      resumeSessionId: "sess-1",
    } as any, "continue work", "sess-1");

    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(args).not.toContain("--session-id");
    expect(args.slice(-2)).toEqual(["-p", "continue work"]);
  });
});

describe("parseGrokJsonLine", () => {
  it("parses assistant message snapshots", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      session_id: "grok-1",
    }));
    expect(parsed?.sessionId).toBe("grok-1");
    expect(parsed?.doneText).toBe("done");
    expect(parsed?.deltas).toContainEqual({ type: "text_snapshot", content: "done" });
  });

  it("parses delta chunks", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({ type: "content_delta", delta: "hel" }));
    expect(parsed?.deltas).toEqual([{ type: "text", content: "hel" }]);
  });

  it("parses Grok streaming text data and skips thought data", () => {
    expect(parseGrokJsonLine(JSON.stringify({ type: "thought", data: "internal" }))?.deltas).toEqual([]);
    expect(parseGrokJsonLine(JSON.stringify({ type: "text", data: "G" }))?.deltas)
      .toEqual([{ type: "text", content: "G" }]);
  });

  it("skips Grok transcript user/system entries", () => {
    expect(parseGrokJsonLine(JSON.stringify({ type: "user", content: "<system-reminder>startup</system-reminder>" }))?.deltas)
      .toEqual([]);
    expect(parseGrokJsonLine(JSON.stringify({ type: "system", content: "policy" }))?.deltas)
      .toEqual([]);
  });

  it("parses Grok interactive update message chunks", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    }));
    expect(parsed?.sessionId).toBe("grok-pty-session");
    expect(parsed?.deltas).toEqual([{ type: "text", content: "hello" }]);
  });

  it("parses Grok end events as terminal with session id", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "grok-live-session",
    }));
    expect(parsed?.terminal).toBe(true);
    expect(parsed?.sessionId).toBe("grok-live-session");
  });

  it("parses terminal result lines", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({ type: "result", result: "final answer", done: true }));
    expect(parsed?.terminal).toBe(true);
    expect(parsed?.doneText).toBe("final answer");
  });

  it("maps tool and error events to stream deltas", () => {
    expect(parseGrokJsonLine(JSON.stringify({ type: "tool_start", toolName: "shell", id: "t1" }))?.deltas)
      .toEqual([{ type: "tool_use", content: "Using shell", toolName: "shell", toolId: "t1" }]);

    expect(parseGrokJsonLine(JSON.stringify({ type: "error", message: "bad auth" }))?.deltas)
      .toEqual([{ type: "error", content: "bad auth" }]);
  });
});

describe("GrokEngine run", () => {
  it("streams text deltas and resolves with the final result", async () => {
    const { result, deltas, call } = await runWith([
      JSON.stringify({ session_id: "grok-session-1" }),
      JSON.stringify({ type: "content_delta", delta: "hel" }),
      JSON.stringify({ type: "content_delta", delta: "lo" }),
      JSON.stringify({ type: "result", result: "hello", done: true }),
    ]);

    expect(path.basename(call.bin)).toBe("grok");
    expect(call.args).not.toContain("--session-id");
    expect(deltas.filter((d) => d.type === "text")).toEqual([
      { type: "text", content: "hel" },
      { type: "text", content: "lo" },
    ]);
    expect(result).toMatchObject({ sessionId: "grok-session-1", result: "hello", numTurns: 1 });
    expect(result.error).toBeUndefined();
  });

  it("uses resumeSessionId when present", async () => {
    const { call, result } = await runWith([
      JSON.stringify({ type: "result", result: "resumed", done: true }),
    ], { resumeSessionId: "existing-grok-session" });

    expect(call.args[call.args.indexOf("--resume") + 1]).toBe("existing-grok-session");
    expect(result.sessionId).toBe("existing-grok-session");
  });
});
