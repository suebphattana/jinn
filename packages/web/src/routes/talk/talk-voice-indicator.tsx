/**
 * Jinn Talk — neural-vs-fallback voice indicator.
 *
 * A tiny dot + label showing which voice produced the last spoken turn:
 *   • "Neural" — the gateway streamed Kokoro audio and it played.
 *   • "Fallback" — the browser Web-Speech synth (Kokoro absent/unavailable).
 * Driven by useTalk's `voiceMode` (set per turn from whether talk:audio arrived).
 * Renders nothing until the first turn has been spoken, so it stays invisible
 * on the calm idle surface.
 */
import type { VoiceMode } from "./use-talk"

export function TalkVoiceIndicator({ voiceMode, muted }: { voiceMode: VoiceMode; muted?: boolean }) {
  // Silent/text mode takes precedence — there is no voice to label.
  if (muted) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
        title="Silent mode — replies are read, not spoken"
      >
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--text-quaternary)" }} />
        Muted
      </span>
    )
  }
  if (!voiceMode) return null
  const neural = voiceMode === "neural"
  return (
    <span
      className="inline-flex items-center gap-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
      title={
        neural
          ? "Spoken with the neural Kokoro voice"
          : "Spoken with the browser fallback voice (neural voice unavailable)"
      }
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ background: neural ? "var(--accent)" : "var(--text-quaternary)" }}
      />
      {neural ? "Neural" : "Fallback"}
    </span>
  )
}
