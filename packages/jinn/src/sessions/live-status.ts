import type { Connector, Target, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export type LiveStatusMode = "edit" | "append";

/** Minimum gap between connector writes. Calm enough that an editing message
 *  doesn't visibly flicker, live enough to feel real. Discord allows ~5 edits
 *  / 5s per message — we stay well under. */
const MIN_INTERVAL_MS = 2500;
/** How many recent steps to keep visible in the edited status message. */
const MAX_STEPS = 8;
/** Hard cap on the rendered body so we never exceed a connector's message
 *  length limit (Discord = 2000). */
const MAX_BODY_LEN = 1800;
/** Truncation length for the abbreviated tool input shown after each step. */
const INPUT_TRUNC = 80;

const HEADER = "⚙️ ทำงานอยู่…";

interface Step {
  /** Tool name (or a short status label). */
  name: string;
  /** Abbreviated, single-line input — may be empty. */
  input: string;
}

/**
 * Streams live progress (one short line per tool call, with an abbreviated
 * input) from an engine's `onStream` deltas to a chat connector — the
 * Hermes-style "narrate every step" behaviour customers see. Engine-agnostic:
 * any engine that emits `tool_use` deltas (claude, codex) drives it; engines
 * that only emit text (openrouter) produce no steps and it stays quiet.
 *
 * Two modes:
 *  - `edit`   — keep ONE status message and edit it in place as steps arrive.
 *  - `append` — post a NEW message for each batch of fresh steps.
 *
 * Writes are throttled AND only happen when there is genuinely new content
 * (`dirty`), so the status message never re-edits itself with identical text
 * (which is what made it flicker). All connector writes are fired-and-forgotten
 * so the hot `onStream` path never blocks the engine turn.
 */
export class LiveStatusStreamer {
  private steps: Step[] = [];
  private pending: Step[] = [];
  private messageTs: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;
  private sending = false;
  private finished = false;
  /** True when there is unflushed content. Gates writes so we never re-edit
   *  the message with text that hasn't changed. */
  private dirty = false;

  constructor(
    private readonly connector: Connector,
    private readonly target: Target,
    private readonly mode: LiveStatusMode,
  ) {}

  /** Feed one engine delta. Cheap + synchronous — never awaits. */
  handle(delta: StreamDelta): void {
    if (this.finished) return;
    const step = toStep(delta);
    if (!step) return;

    // Claude emits two `tool_use` deltas per call: a bare one (SSE
    // content_block_start, no input) immediately followed by a richer one
    // (PreToolUse, with input). Collapse them so each tool shows once.
    const last = this.steps[this.steps.length - 1];
    if (last && last.name === step.name && !last.input && step.input) {
      last.input = step.input;
      const lastPending = this.pending[this.pending.length - 1];
      if (lastPending && lastPending.name === step.name && !lastPending.input) {
        lastPending.input = step.input;
      } else {
        this.pending.push(step);
      }
    } else {
      this.steps.push(step);
      this.pending.push(step);
    }
    if (this.steps.length > MAX_STEPS) this.steps = this.steps.slice(-MAX_STEPS);

    this.dirty = true;
    this.schedule();
  }

  /** Stop streaming. Cancels any pending flush; leaves the last status
   *  message in place (it reads as a record of what happened). */
  finish(): void {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.timer || this.sending || this.finished || !this.dirty) return;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.sending || this.finished || !this.dirty) return;
    this.sending = true;
    // Snapshot intent and clear dirty now: any delta arriving mid-send re-sets
    // it and triggers a fresh schedule in the finally below.
    this.dirty = false;
    try {
      if (this.mode === "append") {
        const batch = this.pending.splice(0);
        const body = clamp(batch.map(renderStep).join("\n"));
        if (body) await this.connector.sendMessage(this.target, body);
      } else {
        const body = clamp(`${HEADER}\n${this.steps.map(renderStep).join("\n")}`);
        if (!this.messageTs) {
          const id = await this.connector.sendMessage(this.target, body);
          if (typeof id === "string") this.messageTs = id;
        } else {
          await this.connector.editMessage(
            { channel: this.target.channel, thread: this.target.thread, messageTs: this.messageTs },
            body,
          );
        }
        this.pending = [];
      }
    } catch (err) {
      logger.debug(`LiveStatusStreamer write failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.lastFlush = Date.now();
      this.sending = false;
      // Only re-schedule if new content arrived while we were sending.
      if (this.dirty) this.schedule();
    }
  }
}

/** Map a raw engine delta to a renderable step, or null to ignore it. */
function toStep(delta: StreamDelta): Step | null {
  if (delta.type === "tool_use") {
    const name = (delta.toolName || delta.content || "tool").trim() || "tool";
    return { name, input: abbreviateInput(delta.input) };
  }
  if (delta.type === "status" && delta.content.trim()) {
    return { name: delta.content.trim().slice(0, 60), input: "" };
  }
  return null;
}

function renderStep(s: Step): string {
  return s.input ? `🔧 \`${s.name}\` ${s.input}` : `🔧 \`${s.name}\``;
}

/**
 * Turn a (possibly JSON) tool input into a short, single-line hint. For known
 * tool shapes we pull the single most meaningful field; otherwise we show a
 * compact slice. Kept deliberately short for an unobtrusive status line.
 */
function abbreviateInput(input: string | undefined): string {
  if (!input) return "";
  let pick = input;
  try {
    const obj = JSON.parse(input);
    if (obj && typeof obj === "object") {
      const primary =
        obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ??
        obj.query ?? obj.url ?? obj.prompt ?? obj.description ?? obj.title;
      pick = typeof primary === "string" && primary.trim() ? primary : "";
    }
  } catch {
    // Not JSON — use the raw string.
  }
  const oneLine = pick.replace(/\s+/g, " ").trim();
  return oneLine.length > INPUT_TRUNC ? `${oneLine.slice(0, INPUT_TRUNC)}…` : oneLine;
}

function clamp(body: string): string {
  return body.length > MAX_BODY_LEN ? `${body.slice(0, MAX_BODY_LEN)}…` : body;
}
