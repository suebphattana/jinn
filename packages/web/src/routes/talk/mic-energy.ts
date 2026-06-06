/**
 * Jinn Talk — barge-in mic energy monitor (browser glue).
 *
 * Opens a short-lived microphone capture and reports per-frame RMS energy so the
 * barge-in detector can notice the user talking over AURA. Distinct from the STT
 * recorder: it runs DURING playback (no recorder active) and explicitly requests
 * browser echo-cancellation / noise-suppression so AURA's own voice coming back
 * through the speaker is largely removed before it reaches the analyser — the
 * first line of defence against self-triggered barge-in (the threshold + onset
 * sustain in BARGE_IN_DEFAULTS is the second).
 *
 * Pure-glue, not unit-tested: it only wires getUserMedia → AnalyserNode → RMS.
 * The decision logic it feeds lives in vad.ts and IS tested.
 */
export class MicEnergyMonitor {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private raf = 0

  async start(onFrame: (rms: number, nowMs: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    // A fresh context can start "suspended" off-gesture (mobile); resume so the
    // analyser actually processes input frames.
    await ctx.resume().catch(() => {})
    const source = ctx.createMediaStreamSource(this.stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)

    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      onFrame(Math.sqrt(sum / buf.length), performance.now())
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}
