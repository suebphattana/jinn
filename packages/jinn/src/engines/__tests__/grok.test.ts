import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
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

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "grok-home-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { buildGrokHeadlessArgs, GrokEngine, grokVisibleDeltas, parseGrokJsonLine } from "../grok.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      effortLevel: "high",
      cliFlags: ["--chrome", "--some-grok-flag"],
    } as any, "do work", "sess-1");

    expect(args).toContain("--no-auto-update");
    expect(args).toContain("--always-approve");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("streaming-json");
    expect(args[args.indexOf("--model") + 1]).toBe("grok-build");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/workspace");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--some-grok-flag");
    expect(args.slice(-2)).toEqual(["-p", "do work"]);
  });

  it("omits --effort for the default effort", () => {
    const args = buildGrokHeadlessArgs({
      prompt: "ignored",
      effortLevel: "default",
    } as any, "do work", "sess-1");

    expect(args).not.toContain("--effort");
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

  it("surfaces a generic, non-verbatim progress line for thought/reasoning (never the raw text)", () => {
    // Raw reasoning ("thought") must not reach the UI verbatim, but the stretch
    // should still show mid-turn progress (not a blank "Thinking"). The parser
    // emits a fixed, generic status line and drops the reasoning payload.
    const parsed = parseGrokJsonLine(JSON.stringify({ type: "thought", data: "checking secret files in /etc" }));
    expect(parsed?.deltas).toEqual([{ type: "status", content: "Thinking: working through the request…" }]);
    // The raw reasoning text is never echoed into any delta.
    expect(JSON.stringify(parsed?.deltas)).not.toContain("checking secret files");
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

  it("surfaces interactive thought chunks as generic progress (raw reasoning never displayed)", () => {
    const parsed = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "<thinking>checking the repository</thinking>" },
        },
      },
    }));
    expect(parsed?.sessionId).toBe("grok-pty-session");
    // Generic, non-verbatim progress line — the raw reasoning text is dropped.
    expect(parsed?.deltas).toEqual([{ type: "status", content: "Thinking: working through the request…" }]);
    expect(JSON.stringify(parsed?.deltas)).not.toContain("checking the repository");
    expect(JSON.stringify(parsed?.deltas)).not.toContain("<thinking>");
  });

  it("parses Grok interactive tool calls and completions", () => {
    const start = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "read_file",
          rawInput: { target_file: "/tmp/a.txt" },
        },
      },
    }));
    expect(start?.deltas).toEqual([{
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "tool-1",
      input: "{\"target_file\":\"/tmp/a.txt\"}",
    }]);

    const done = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }],
          rawOutput: { type: "ReadFile" },
        },
      },
    }));
    expect(done?.deltas).toEqual([{
      type: "tool_result",
      content: "ok",
      toolName: "read_file",
      toolId: "tool-1",
    }]);
  });

  it("parses Grok plan and retry updates as status", () => {
    const plan = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read files", status: "completed" },
            { content: "Patch parser", status: "in_progress" },
          ],
        },
      },
    }));
    expect(plan?.deltas).toEqual([{ type: "status", content: "Plan: Patch parser" }]);

    const retry = parseGrokJsonLine(JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "grok-pty-session",
        update: {
          sessionUpdate: "retry_state",
          attempt: 2,
          max_retries: 15,
          reason: "temporary upstream failure",
        },
      },
    }));
    expect(retry?.deltas).toEqual([{ type: "status", content: "Grok retrying (2/15): temporary upstream failure" }]);
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

describe("grokVisibleDeltas (dedup + reasoning suppression contract)", () => {
  it("never forwards answer text live from either stream (single authoritative emit)", () => {
    const text: StreamDelta[] = [{ type: "text", content: "Hello Michael" }];
    const snapshot: StreamDelta[] = [{ type: "text_snapshot", content: "Hello Michael" }];
    expect(grokVisibleDeltas(text, "stdout")).toEqual([]);
    expect(grokVisibleDeltas(text, "transcript")).toEqual([]);
    expect(grokVisibleDeltas(snapshot, "stdout")).toEqual([]);
    expect(grokVisibleDeltas(snapshot, "transcript")).toEqual([]);
  });

  it("streams tool lifecycle + context live, on the transcript stream", () => {
    const deltas: StreamDelta[] = [
      { type: "tool_use", content: "Using read_file", toolName: "read_file" },
      { type: "tool_result", content: "ok", toolName: "read_file" },
      { type: "context", content: "1234" },
      { type: "text", content: "leaked answer" },
    ];
    expect(grokVisibleDeltas(deltas, "transcript")).toEqual([
      { type: "tool_use", content: "Using read_file", toolName: "read_file" },
      { type: "tool_result", content: "ok", toolName: "read_file" },
      { type: "context", content: "1234" },
    ]);
  });

  it("the answer text is emitted exactly once: accumulated for resultText, not streamed", () => {
    // Simulate the headless stdout sequence: text chunks build the answer, the
    // transcript carries the same answer (agent_message_chunk) plus tool lifecycle.
    const stdoutLines = [
      parseGrokJsonLine(JSON.stringify({ type: "text", data: "Hello " }))!,
      parseGrokJsonLine(JSON.stringify({ type: "text", data: "Michael" }))!,
      parseGrokJsonLine(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s1" }))!,
    ];
    const transcriptLines = [
      parseGrokJsonLine(JSON.stringify({
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "write" } },
      }))!,
      parseGrokJsonLine(JSON.stringify({
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello Michael" } } },
      }))!,
    ];

    let resultText = "";
    const visible: StreamDelta[] = [];
    for (const parsed of stdoutLines) {
      for (const d of parsed.deltas) {
        if (d.type === "text") resultText += d.content;
        if (d.type === "text_snapshot") resultText = d.content;
      }
      visible.push(...grokVisibleDeltas(parsed.deltas, "stdout"));
    }
    for (const parsed of transcriptLines) visible.push(...grokVisibleDeltas(parsed.deltas, "transcript"));

    // resultText finalized correctly...
    expect(resultText).toBe("Hello Michael");
    // ...and the answer never appears as a visible (streamed) delta — exactly one
    // copy reaches the UI, via the final result. Reasoning is absent too.
    expect(visible.some((d) => d.type === "text" || d.type === "text_snapshot")).toBe(false);
    expect(visible.some((d) => d.type === "status")).toBe(false);
    expect(visible.filter((d) => d.type === "tool_use")).toHaveLength(1);
  });
});

describe("GrokEngine run", () => {
  it("accumulates answer text into the final result without emitting it live (no duplicate)", async () => {
    const { result, deltas, call } = await runWith([
      JSON.stringify({ session_id: "grok-session-1" }),
      JSON.stringify({ type: "content_delta", delta: "hel" }),
      JSON.stringify({ type: "content_delta", delta: "lo" }),
      JSON.stringify({ type: "result", result: "hello", done: true }),
    ]);

    expect(path.basename(call.bin)).toBe("grok");
    expect(call.args).not.toContain("--session-id");
    // Answer text is NOT streamed live — it would be frozen into a permanent bubble
    // by a late transcript tool_use and then duplicated by the final result. It lands
    // exactly once via result.result, accumulated from the same deltas.
    expect(deltas.filter((d) => d.type === "text" || d.type === "text_snapshot")).toEqual([]);
    expect(result).toMatchObject({ sessionId: "grok-session-1", result: "hello", numTurns: 1 });
    expect(result.error).toBeUndefined();
  });

  it("settles on the terminal end event even if the process never closes", async () => {
    // Regression: a `bash`/shell tool call can leave a grandchild that inherits the
    // child's stdout pipe, so `proc.on('close')` never fires even after grok exits.
    // The turn must still settle from grok's stdout `end` marker — never hang.
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "hatch an employee",
      cwd: "/tmp",
      sessionId: "jinn-session-hang",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    // Stream session id + answer text, then the terminal end event. Crucially we
    // NEVER call call.proc.close(...) — the pipe is "held open" by a grandchild.
    call.proc.emitStdout([
      JSON.stringify({ session_id: "grok-hang-session" }),
      JSON.stringify({ type: "text", data: "Done — React Reviewer is ready." }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "grok-hang-session" }),
      "",
    ].join("\n"));

    // Resolves promptly from the terminal event (no close). A 1s race guard proves
    // we don't depend on `close` (which would hang here).
    const raced = await Promise.race([
      promise,
      sleep(1000).then(() => "TIMED_OUT" as const),
    ]);
    expect(raced).not.toBe("TIMED_OUT");
    const result = raced as EngineResult;
    expect(result).toMatchObject({ sessionId: "grok-hang-session", result: "Done — React Reviewer is ready.", numTurns: 1 });
    expect(result.error).toBeUndefined();
    expect(engine.isAlive("jinn-session-hang")).toBe(false);
  });

  it("uses resumeSessionId when present", async () => {
    const { call, result } = await runWith([
      JSON.stringify({ type: "result", result: "resumed", done: true }),
    ], { resumeSessionId: "existing-grok-session" });

    expect(call.args[call.args.indexOf("--resume") + 1]).toBe("existing-grok-session");
    expect(result.sessionId).toBe("existing-grok-session");
  });

  it("mirrors headless tool deltas from Grok's transcript", async () => {
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "read a file",
      cwd: "/tmp",
      sessionId: "jinn-session-tool",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    call.proc.emitStdout(JSON.stringify({ session_id: "tool-session" }) + "\n");

    const file = path.join(osMockState.home, ".grok", "sessions", "tool-session", "updates.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    await sleep(350);
    fs.appendFileSync(file, [
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "tool-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "read_file",
            rawInput: { target_file: "AGENTS.md" },
          },
        },
      }),
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "tool-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            title: "read_file",
            content: [{ type: "content", content: { type: "text", text: "ok" } }],
          },
        },
      }),
      "",
    ].join("\n"));
    await sleep(350);

    call.proc.emitStdout([
      JSON.stringify({ type: "text", data: "done" }),
      JSON.stringify({ type: "result", result: "done", done: true }),
      "",
    ].join("\n"));
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("done");
    expect(deltas).toContainEqual({
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "tool-1",
      input: "{\"target_file\":\"AGENTS.md\"}",
    });
    expect(deltas).toContainEqual({
      type: "tool_result",
      content: "ok",
      toolName: "read_file",
      toolId: "tool-1",
    });
  });

  it("ignores changed transcript files that belong to another Grok session", async () => {
    const deltas: StreamDelta[] = [];
    const engine = new GrokEngine();
    const promise = engine.run({
      prompt: "read the right file",
      cwd: "/tmp",
      sessionId: "jinn-session-filter",
      model: "grok-build",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();
    call.proc.emitStdout(JSON.stringify({ session_id: "right-session" }) + "\n");

    const wrongFile = path.join(osMockState.home, ".grok", "sessions", "wrong-session", "updates.jsonl");
    fs.mkdirSync(path.dirname(wrongFile), { recursive: true });
    fs.writeFileSync(wrongFile, [
      JSON.stringify({ session_id: "wrong-session" }),
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "wrong-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "wrong-tool",
            title: "read_file",
            rawInput: { target_file: "WRONG.md" },
          },
        },
      }),
      "",
    ].join("\n"));

    const rightFile = path.join(osMockState.home, ".grok", "sessions", "right-session", "updates.jsonl");
    fs.mkdirSync(path.dirname(rightFile), { recursive: true });
    fs.writeFileSync(rightFile, [
      JSON.stringify({ session_id: "right-session" }),
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "right-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "right-tool",
            title: "read_file",
            rawInput: { target_file: "RIGHT.md" },
          },
        },
      }),
      "",
    ].join("\n"));

    await sleep(350);
    call.proc.emitStdout([
      JSON.stringify({ type: "text", data: "done" }),
      JSON.stringify({ type: "result", result: "done", done: true }),
      "",
    ].join("\n"));
    call.proc.close(0);

    await promise;
    expect(deltas).toContainEqual({
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "right-tool",
      input: "{\"target_file\":\"RIGHT.md\"}",
    });
    expect(deltas).not.toContainEqual(expect.objectContaining({ toolId: "wrong-tool" }));
  });
});
