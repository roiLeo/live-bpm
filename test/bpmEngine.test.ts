import { describe, expect, it } from 'vitest'
import { BpmEngine, estimateTempo } from '../app/utils/bpmEngine'
import { feed, synth } from './synth'

const SR = 44100

const run = (opts: Parameters<typeof synth>[0]) => {
  const engine = new BpmEngine(opts.sampleRate ?? SR)
  const timeline: Array<{ t: number; bpm: number; confidence: number }> = []
  let next = 0
  feed(engine, synth(opts), (pos) => {
    if (pos / (opts.sampleRate ?? SR) >= next) {
      timeline.push({ t: next, bpm: engine.bpm, confidence: engine.confidence })
      next += 1
    }
  })
  return { engine, timeline }
}

describe('tempo detection', () => {
  for (const bpm of [90, 100, 120, 128, 140, 150, 174]) {
    it(`locks onto ${bpm} BPM`, () => {
      const { engine } = run({ segments: [{ bpm, seconds: 20 }] })
      expect(engine.status).toBe('locked')
      expect(Math.abs(engine.bpm - bpm)).toBeLessThan(1.5)
    })
  }

  it('may read slow tempos with busy off-beats as double time, which the toggle fixes', () => {
    const { engine } = run({ segments: [{ bpm: 80, seconds: 20 }] })
    expect([80, 160].some((t) => Math.abs(engine.bpm - t) < 1.5)).toBe(true)
    if (engine.bpm > 120) {
      engine.setTempoScale(0.5)
      expect(Math.abs(engine.bpm - 80)).toBeLessThan(1.5)
    }
  })

  it('reports decimal tempos', () => {
    const { engine } = run({ segments: [{ bpm: 127.5, seconds: 25 }] })
    expect(Math.abs(engine.bpm - 127.5)).toBeLessThan(1)
  })

  it('works with kick only and with hats only', () => {
    const kick = run({ segments: [{ bpm: 110, seconds: 20 }], snare: false, hats: false })
    expect(Math.abs(kick.engine.bpm - 110)).toBeLessThan(1.5)
    const hats = run({ segments: [{ bpm: 110, seconds: 20 }], kick: false, snare: false })
    expect(Math.abs(hats.engine.bpm - 110)).toBeLessThan(1.5)
  })

  it('tolerates timing jitter, swing and noise', () => {
    const jitter = run({ segments: [{ bpm: 124, seconds: 25 }], jitterMs: 12, noise: 0.03 })
    expect(Math.abs(jitter.engine.bpm - 124)).toBeLessThan(2.5)
    const swing = run({ segments: [{ bpm: 100, seconds: 25 }], swing: 0.15 })
    expect(Math.abs(swing.engine.bpm - 100)).toBeLessThan(2)
  })

  it('does not depend on the input level', () => {
    const quiet = run({ segments: [{ bpm: 120, seconds: 20 }], gain: 0.15, noise: 0.001 })
    expect(Math.abs(quiet.engine.bpm - 120)).toBeLessThan(1.5)
  })

  it('works at 48 kHz', () => {
    const { engine } = run({ segments: [{ bpm: 133, seconds: 20 }], sampleRate: 48000 })
    expect(Math.abs(engine.bpm - 133)).toBeLessThan(1.5)
  })

  it('follows a tempo change', () => {
    const { engine, timeline } = run({
      segments: [
        { bpm: 100, seconds: 25 },
        { bpm: 140, seconds: 30 }
      ]
    })
    expect(Math.abs(timeline[24]!.bpm - 100)).toBeLessThan(2)
    expect(Math.abs(engine.bpm - 140)).toBeLessThan(2)
  })

  it('half / double time toggle scales the reading', () => {
    const { engine } = run({ segments: [{ bpm: 140, seconds: 20 }] })
    engine.setTempoScale(0.5)
    expect(Math.abs(engine.bpm - 70)).toBeLessThan(1)
    engine.setTempoScale(2)
    expect(Math.abs(engine.bpm - 280)).toBeLessThan(2)
  })

  it('does not lock onto noise or silence', () => {
    const noise = run({ segments: [{ bpm: 120, seconds: 20 }], kick: false, snare: false, hats: false, noise: 0.2 })
    expect(noise.engine.bpm).toBe(0)
    const silence = run({ segments: [{ bpm: 120, seconds: 12 }], kick: false, snare: false, hats: false, noise: 0 })
    expect(silence.engine.bpm).toBe(0)
    expect(silence.engine.tooQuiet).toBe(true)
  })

  it('does not flicker once locked', () => {
    const { timeline } = run({ segments: [{ bpm: 128, seconds: 40 }], jitterMs: 8 })
    const locked = timeline.filter((p) => p.bpm > 0).slice(3)
    expect(locked.length).toBeGreaterThan(20)
    expect(Math.max(...locked.map((p) => p.bpm)) - Math.min(...locked.map((p) => p.bpm))).toBeLessThan(2)
  })

  it('drops the lock after the music stops', () => {
    const music = synth({ segments: [{ bpm: 120, seconds: 15 }] })
    const quiet = new Float32Array(SR * 12)
    const engine = new BpmEngine(SR)
    feed(engine, music)
    expect(engine.bpm).toBeGreaterThan(0)
    feed(engine, quiet)
    expect(engine.bpm).toBe(0)
  })
})

describe('warm-up and levels', () => {
  it('reports warm-up progress then locks', () => {
    const engine = new BpmEngine(SR)
    feed(engine, synth({ segments: [{ bpm: 120, seconds: 2 }] }))
    expect(engine.status).toBe('warming')
    expect(engine.warmup).toBeGreaterThan(0.3)
    expect(engine.warmup).toBeLessThan(1)
  })

  it('measures the input level', () => {
    const { engine } = run({ segments: [{ bpm: 120, seconds: 6 }] })
    expect(engine.level).toBeGreaterThan(0.02)
    expect(engine.tooQuiet).toBe(false)
  })
})

describe('beat clock', () => {
  it('emits beats at the detected tempo, in phase with the audio', () => {
    const bpm = 120
    const audio = synth({ segments: [{ bpm, seconds: 30 }] })
    const engine = new BpmEngine(SR)
    const beats: number[] = []
    let count = 0
    feed(engine, audio, () => {
      while (count < engine.beatCount) {
        beats.push(engine.now)
        count++
      }
    })
    const recent = beats.filter((t) => t > 20)
    expect(recent.length).toBeGreaterThanOrEqual(15)
    const period = 60 / bpm
    for (let i = 1; i < recent.length; i++) expect(Math.abs(recent[i]! - recent[i - 1]! - period)).toBeLessThan(0.06)
    // kicks land on multiples of the period, so beats should too (allowing for analysis latency)
    const offsets = recent.map((t) => ((t % period) + period) % period)
    const spread = Math.max(...offsets) - Math.min(...offsets)
    expect(Math.min(spread, period - spread)).toBeLessThan(0.08)
  })
})

describe('estimateTempo', () => {
  it('returns null for short or empty input', () => {
    expect(estimateTempo(new Float32Array(10), 86)).toBeNull()
    expect(estimateTempo(new Float32Array(1000), 86)).toBeNull()
  })

  it('finds the period of a pulse train', () => {
    const rate = 86.13
    const env = new Float32Array(Math.floor(rate * 12))
    const period = (60 / 96) * rate
    for (let p = 0; p < env.length; p += period) env[Math.floor(p)] = 1
    const est = estimateTempo(env, rate)!
    expect(Math.abs(est.bpm - 96)).toBeLessThan(1)
    expect(est.confidence).toBeGreaterThan(50)
  })
})
