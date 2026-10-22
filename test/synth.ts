// Synthetic audio for the BPM engine tests: kick on the beat, snare on 2 & 4, hats on the off-beats

export interface Segment {
  bpm: number
  seconds: number
}

export interface SynthOptions {
  segments: Segment[]
  sampleRate?: number
  noise?: number // white noise floor amplitude
  jitterMs?: number // random timing error per hit
  swing?: number // 0..0.4, delays the off-beat hats
  kick?: boolean
  snare?: boolean
  hats?: boolean
  gain?: number
  seed?: number
}

const random = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

export function synth({ segments, sampleRate = 44100, noise = 0.01, jitterMs = 0, swing = 0, kick = true, snare = true, hats = true, gain = 1, seed = 1 }: SynthOptions) {
  const rnd = random(seed)
  const total = segments.reduce((a, s) => a + s.seconds, 0)
  const out = new Float32Array(Math.floor(total * sampleRate))

  const add = (time: number, fn: (t: number) => number, length: number) => {
    const start = Math.floor((time + ((rnd() - 0.5) * 2 * jitterMs) / 1000) * sampleRate)
    for (let i = 0; i < length * sampleRate; i++) {
      const idx = start + i
      if (idx >= 0 && idx < out.length) out[idx]! += fn(i / sampleRate)
    }
  }

  let t0 = 0
  for (const seg of segments) {
    const period = 60 / seg.bpm
    const beats = Math.floor(seg.seconds / period)
    for (let b = 0; b < beats; b++) {
      const t = t0 + b * period
      if (kick && b % 2 === 0) add(t, (x) => 0.8 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-x * 40)) * x) * Math.exp(-x / 0.09), 0.3)
      if (kick && b % 2 === 1) add(t, (x) => 0.5 * Math.sin(2 * Math.PI * 55 * x) * Math.exp(-x / 0.07), 0.25)
      if (snare && b % 2 === 1) add(t, (x) => 0.4 * (rnd() * 2 - 1) * Math.exp(-x / 0.08), 0.2)
      if (hats) add(t + period * (0.5 + swing), (x) => 0.25 * (rnd() * 2 - 1) * Math.exp(-x / 0.015), 0.06)
    }
    t0 += seg.seconds
  }

  for (let i = 0; i < out.length; i++) out[i] = (out[i]! + noise * (rnd() * 2 - 1)) * gain
  return out
}

// feed in uneven chunks to exercise the engine's buffering
export function feed(engine: { push(c: Float32Array): boolean }, audio: Float32Array, onTick?: (seconds: number) => void) {
  let pos = 0
  const sizes = [128, 512, 300, 1024, 777]
  let s = 0
  while (pos < audio.length) {
    const size = sizes[s++ % sizes.length]!
    engine.push(audio.subarray(pos, Math.min(audio.length, pos + size)))
    pos += size
    onTick?.(pos)
  }
}
