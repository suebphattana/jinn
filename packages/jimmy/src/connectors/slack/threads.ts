export function deriveSourceRef(event: any): string {
  if (event.channel_type === "im") {
    return `slack:dm:${event.user}`;
  }
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return `slack:${event.channel}:${event.thread_ts}`;
  }
  return `slack:${event.channel}`;
}
