import type { ReplyContext } from "../../shared/types.js";

export interface SlackMessageEventLike {
  channel: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface SlackThreadOptions {
  shareSessionInChannel?: boolean;
}

export function deriveSessionKey(
  event: SlackMessageEventLike,
  opts: SlackThreadOptions = {},
): string {
  if (event.channel_type === "im") {
    return `slack:dm:${event.user || "unknown"}`;
  }

  if (opts.shareSessionInChannel) {
    return `slack:${event.channel}`;
  }

  if (event.thread_ts && event.thread_ts !== event.ts) {
    return `slack:${event.channel}:${event.thread_ts}`;
  }

  return `slack:${event.channel}`;
}

export function buildReplyContext(event: SlackMessageEventLike): ReplyContext {
  const thread = event.thread_ts && event.thread_ts !== event.ts
    ? event.thread_ts
    : undefined;

  return {
    channel: event.channel,
    thread: thread ?? null,
    messageTs: event.ts ?? null,
  };
}

export function isOldSlackMessage(ts: string | undefined, bootTimeMs: number): boolean {
  if (!ts) return false;
  const secs = Number(ts.split(".")[0]);
  if (!Number.isFinite(secs)) return false;
  return secs * 1000 < bootTimeMs;
}
