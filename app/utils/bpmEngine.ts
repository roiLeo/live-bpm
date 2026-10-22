// Pure DSP for live BPM detection (no browser APIs, so it can be unit tested in Node).
//
// pipeline: PCM -> STFT -> per-band spectral flux (onset envelope)
//           -> Fourier tempogram with harmonic comb (decimal BPM, octave handling)
//           -> tracker (lock-in / hysteresis) -> beat clock (phase for the pulse indicator)

export const FFT_SIZE = 2048
export const HOP_SIZE = 512

const MIN_BPM = 70
const MAX_BPM = 180
const MIN_SECONDS = 4 // data needed before the first estimate
const SHORT_WINDOW = 8 // seconds, reacts to tempo changes
const LONG_WINDOW = 20 // seconds, precise on stable tracks
const ESTIMATE_INTERVAL = 0.5 // seconds between tempo estimates
const PHASE_WINDOW = 8 // seconds used to find the beat phase

const HARMONIC_WEIGHTS = [1, 0.6, 0.4, 0.3]
const BANDS = [
  { lo: 30, hi: 180, weight: 1 }, // kick / bass
  { lo: 180, hi: 2500, weight: 0.8 }, // snare / body
  { lo: 2500, hi: 9000, weight: 0.6 } // hats / transients
]

const GATE_RMS = 0.002 // about -54 dBFS, below this the input counts as silence
const QUIET_RESET_SECONDS = 3

const ACCEPT_CONFIDENCE = 25
const LOCK_COUNT = 2
const CHALLENGE_COUNT = 4
const LOSE_COUNT = 8
const SAME_TEMPO = 0.03 // relative tolerance for "same tempo"

export interface TempoEstimate {
  bpm: number
  confidence: number
}

export type BpmStatus = 'warming' | 'searching' | 'locked' | 'quiet'

class FFT {
  private cos: Float64Array
  private sin: Float64Array
  private rev: Uint32Array
  readonly re: Float64Array
  readonly im: Float64Array

  constructor(readonly size: number) {
    this.re = new Float64Array(size)
    this.im = new Float64Array(size)
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((2 * Math.PI * i) / size)
    }
    this.rev = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }

  // in-place forward transform of re/im
  transform() {
    const { re, im, size, rev, cos, sin } = this
    for (let i = 0; i < size; i++) {
      const j = rev[i]!
      if (j > i) {
        const tr = re[i]!
        re[i] = re[j]!
        re[j] = tr
        const ti = im[i]!
        im[i] = im[j]!
        im[j] = ti
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1
      const step = size / len
      for (let i = 0; i < size; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!
          const wi = -sin[k * step]!
          const a = i + k
          const b = a + half
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
  }
}

const sameTempo = (a: number, b: number) => Math.abs(a - b) <= SAME_TEMPO * Math.max(a, b)

// Tempo (decimal BPM) from an onset envelope sampled at `rate` Hz.
// Fourier tempogram: magnitude of the envelope spectrum at the beat frequency plus its
// harmonics, so the beat period wins over its subdivisions, with a mild prior around 120 BPM.
export function estimateTempo(env: ArrayLike<number>, rate: number, minBpm = MIN_BPM, maxBpm = MAX_BPM): TempoEstimate | null {
  const n = env.length
  if (n < rate * MIN_SECONDS) return null

  let mean = 0
  for (let i = 0; i < n; i++) mean += env[i]!
  mean /= n

  const x = new Float64Array(n)
  let energy = 0
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    x[i] = (env[i]! - mean) * hann
    energy += x[i]! * x[i]!
  }
  if (energy < 1e-9) return null

  // grid of half-BPM steps: index k is k / 2 BPM, i.e. k / 120 Hz
  const harmonics = HARMONIC_WEIGHTS.length
  const kLo = Math.floor(minBpm * 2)
  const kHi = Math.ceil(maxBpm * 2)
  const maxK = kHi * harmonics
  const mag = new Float64Array(maxK + 1)

  for (let k = kLo; k <= maxK; k++) {
    const angle = (-2 * Math.PI * k) / (120 * rate)
    const stepRe = Math.cos(angle)
    const stepIm = Math.sin(angle)
    let pr = 1
    let pi = 0
    let sr = 0
    let si = 0
    for (let i = 0; i < n; i++) {
      sr += x[i]! * pr
      si += x[i]! * pi
      const nr = pr * stepRe - pi * stepIm
      pi = pr * stepIm + pi * stepRe
      pr = nr
    }
    mag[k] = Math.hypot(sr, si)
  }

  const scores = new Float64Array(kHi + 2)
  let total = 0
  let bestK = -1
  let bestWeighted = 0
  for (let k = kLo; k <= kHi; k++) {
    let s = 0
    for (let h = 1; h <= harmonics; h++) s += HARMONIC_WEIGHTS[h - 1]! * mag[k * h]!
    scores[k] = s
    total += s
    const bpm = k / 2
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.6, 2))
    const weighted = s * (0.5 + 0.5 * prior)
    if (weighted > bestWeighted) {
      bestWeighted = weighted
      bestK = k
    }
  }
  if (bestK < 0) return null

  // parabolic interpolation on the score for sub-grid accuracy
  let k = bestK
  if (bestK > kLo && bestK < kHi) {
    const y0 = scores[bestK - 1]!
    const y1 = scores[bestK]!
    const y2 = scores[bestK + 1]!
    const denom = y0 - 2 * y1 + y2
    if (denom < 0) k += Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom))
  }

  // confidence: how far the peak stands out from the average score across the range
  const mean_ = total / (kHi - kLo + 1)
  const ratio = scores[bestK]! / mean_
  const confidence = Math.round(Math.max(0, Math.min(100, ((ratio - 1.8) / 2.7) * 100)))

  return { bpm: k / 2, confidence }
}

// Hold a tempo until a different one persists (no flicker), but still follow real changes.
export class TempoTracker {
  locked = 0
  confidence = 0
  private pending: { bpm: number; count: number } | null = null
  private challenger: { bpm: number; count: number } | null = null
  private lowCount = 0

  clear() {
    this.locked = 0
    this.confidence = 0
    this.pending = null
    this.challenger = null
    this.lowCount = 0
  }

  update(est: TempoEstimate | null) {
    if (!est || est.confidence < ACCEPT_CONFIDENCE) {
      this.lowCount++
      if (this.locked && this.lowCount >= LOSE_COUNT) this.clear()
      return
    }
    this.lowCount = 0

    if (!this.locked) {
      if (this.pending && sameTempo(est.bpm, this.pending.bpm)) {
        this.pending.bpm = (this.pending.bpm * this.pending.count + est.bpm) / (this.pending.count + 1)
        this.pending.count++
        if (this.pending.count >= LOCK_COUNT) {
          this.locked = this.pending.bpm
          this.confidence = est.confidence
          this.pending = null
        }
      } else {
        this.pending = { bpm: est.bpm, count: 1 }
      }
      return
    }

    if (sameTempo(est.bpm, this.locked)) {
      this.locked += 0.25 * (est.bpm - this.locked)
      this.confidence = est.confidence
      this.challenger = null
      return
    }

    if (this.challenger && sameTempo(est.bpm, this.challenger.bpm)) {
      this.challenger.count++
      this.challenger.bpm += (est.bpm - this.challenger.bpm) / this.challenger.count
      if (this.challenger.count >= CHALLENGE_COUNT) {
        this.locked = this.challenger.bpm
        this.confidence = est.confidence
        this.challenger = null
      }
    } else {
      this.challenger = { bpm: est.bpm, count: 1 }
    }
  }
}

export class BpmEngine {
  readonly sampleRate: number
  readonly rate: number // onset envelope rate in Hz
  private scale = 1 // 0.5 / 2 to correct half / double time readings

  private fft = new FFT(FFT_SIZE)
  private window = new Float64Array(FFT_SIZE)
  private samples = new Float32Array(FFT_SIZE)
  private hop = new Float32Array(HOP_SIZE)
  private hopFilled = 0
  private hopCount = 0
  private bandBins: Array<[number, number]>
  private prevMag: Float64Array
  private hasPrev = false
  private flux: number[][] = BANDS.map(() => [])
  private frameCount = 0
  private maxFrames: number
  private nextEstimateAt = 0
  private tracker = new TempoTracker()
  private quietFrames = 0

  level = 0 // smoothed RMS of the input, 0..1
  tooQuiet = false
  beatCount = 0
  private beatPeriod = 0
  private lastBeat = -Infinity
  private nextBeat = Infinity

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.rate = sampleRate / HOP_SIZE
    this.maxFrames = Math.ceil(LONG_WINDOW * this.rate)
    for (let i = 0; i < FFT_SIZE; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))

    const binHz = sampleRate / FFT_SIZE
    const nyquistBin = FFT_SIZE / 2
    this.bandBins = BANDS.map(({ lo, hi }) => {
      const a = Math.max(1, Math.floor(lo / binHz))
      const b = Math.min(nyquistBin, Math.max(a + 1, Math.ceil(hi / binHz)))
      return [a, b]
    })
    this.prevMag = new Float64Array(nyquistBin + 1)
  }

  // seconds of audio analysed so far
  get dataSeconds() {
    return this.flux[0]!.length / this.rate
  }

  get warmup() {
    return Math.min(1, this.dataSeconds / MIN_SECONDS)
  }

  get status(): BpmStatus {
    if (this.tooQuiet) return 'quiet'
    if (this.tracker.locked) return 'locked'
    return this.dataSeconds < MIN_SECONDS ? 'warming' : 'searching'
  }

  // displayed tempo (0 when not locked)
  get bpm() {
    return this.tracker.locked ? Math.round(this.tracker.locked * this.scale * 10) / 10 : 0
  }

  get confidence() {
    return this.tracker.locked ? this.tracker.confidence : 0
  }

  get tempoScale() {
    return this.scale
  }

  setTempoScale(scale: number) {
    this.scale = scale
    this.updateBeatClock()
  }

  // time (seconds) of the end of the latest analysed window
  get now() {
    return ((this.frameCount - 1) * HOP_SIZE + FFT_SIZE) / this.sampleRate
  }

  private frameTime(frame: number) {
    return (frame * HOP_SIZE + FFT_SIZE / 2) / this.sampleRate
  }

  // feed any amount of mono PCM; returns true when the tempo estimate was refreshed
  push(chunk: Float32Array): boolean {
    let refreshed = false
    for (let i = 0; i < chunk.length; i++) {
      this.hop[this.hopFilled++] = chunk[i]!
      if (this.hopFilled < HOP_SIZE) continue
      this.hopFilled = 0
      if (this.processHop()) refreshed = true
    }
    return refreshed
  }

  private processHop(): boolean {
    this.samples.copyWithin(0, HOP_SIZE)
    this.samples.set(this.hop, FFT_SIZE - HOP_SIZE)
    if (++this.hopCount < FFT_SIZE / HOP_SIZE) return false // window not full yet

    let sq = 0
    for (let i = 0; i < HOP_SIZE; i++) sq += this.hop[i]! * this.hop[i]!
    const rms = Math.sqrt(sq / HOP_SIZE)
    this.level += 0.05 * (rms - this.level)
    const gated = rms < GATE_RMS

    this.quietFrames = this.level < GATE_RMS ? this.quietFrames + 1 : 0
    this.tooQuiet = this.quietFrames > 0.5 * this.rate
    if (this.quietFrames > QUIET_RESET_SECONDS * this.rate) this.resetAnalysis()

    const { re, im } = this.fft
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = this.samples[i]! * this.window[i]!
      im[i] = 0
    }
    this.fft.transform()

    const norm = 100 / (FFT_SIZE / 4)
    const bandFlux = BANDS.map(() => 0)
    for (let b = 0; b < BANDS.length; b++) {
      const [lo, hi] = this.bandBins[b]!
      let sum = 0
      for (let k = lo; k < hi; k++) {
        const v = Math.log1p(Math.hypot(re[k]!, im[k]!) * norm)
        const diff = v - this.prevMag[k]!
        if (this.hasPrev && diff > 0) sum += diff
      }
      bandFlux[b] = gated ? 0 : sum / (hi - lo)
    }
    // update previous log-magnitudes for every bin the bands use
    for (let k = 1; k <= FFT_SIZE / 2; k++) this.prevMag[k] = Math.log1p(Math.hypot(re[k]!, im[k]!) * norm)
    this.hasPrev = true

    for (let b = 0; b < BANDS.length; b++) {
      const arr = this.flux[b]!
      arr.push(bandFlux[b]!)
      if (arr.length > this.maxFrames) arr.shift()
    }
    this.frameCount++

    let refreshed = false
    if (this.now >= this.nextEstimateAt && this.dataSeconds >= MIN_SECONDS) {
      this.nextEstimateAt = this.now + ESTIMATE_INTERVAL
      this.estimate()
      refreshed = true
    }

    while (this.now >= this.nextBeat) {
      this.beatCount++
      this.lastBeat = this.nextBeat
      this.nextBeat += this.beatPeriod
    }
    return refreshed
  }

  // drop stale analysis after a long silence
  private resetAnalysis() {
    for (const arr of this.flux) arr.length = 0
    this.tracker.clear()
    this.nextBeat = Infinity
    this.nextEstimateAt = 0
    this.hasPrev = false
  }

  // onset envelope of the last `seconds`: per band remove the local mean, rectify, weight, sum
  private buildEnvelope(seconds: number): Float64Array {
    const len = this.flux[0]!.length
    const n = Math.min(len, Math.round(seconds * this.rate))
    const out = new Float64Array(n)
    const hw = Math.max(1, Math.round(0.25 * this.rate))
    const prefix = new Float64Array(n + 1)

    for (let b = 0; b < BANDS.length; b++) {
      const arr = this.flux[b]!
      const off = len - n
      for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + arr[off + i]!
      const weight = BANDS[b]!.weight
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - hw)
        const c = Math.min(n, i + hw + 1)
        const localMean = (prefix[c]! - prefix[a]!) / (c - a)
        const v = arr[off + i]! - localMean
        out[i] = out[i]! + (v > 0 ? v * weight : 0)
      }
    }
    return out
  }

  private estimate() {
    const long = estimateTempo(this.buildEnvelope(LONG_WINDOW), this.rate)
    let est = long
    if (this.dataSeconds > SHORT_WINDOW + 2) {
      const short = estimateTempo(this.buildEnvelope(SHORT_WINDOW), this.rate)
      if (short && (!long || (!sameTempo(short.bpm, long.bpm) && short.confidence > long.confidence))) est = short
    }
    this.tracker.update(est)
    this.updateBeatClock()
  }

  // find the beat phase by sliding a comb of the locked period over the recent envelope
  private updateBeatClock() {
    if (!this.tracker.locked) {
      this.nextBeat = Infinity
      return
    }
    const period = 60 / (this.tracker.locked * this.scale)
    const periodFrames = period * this.rate
    const env = this.buildEnvelope(PHASE_WINDOW)
    const n = env.length
    if (n < periodFrames * 2) return

    let bestPhase = 0
    let bestScore = -1
    for (let p = 0; p < periodFrames; p += 0.5) {
      let sum = 0
      let count = 0
      for (let pos = p; pos < n - 1; pos += periodFrames) {
        const i = Math.floor(pos)
        const f = pos - i
        sum += env[i]! * (1 - f) + env[i + 1]! * f
        count++
      }
      const score = count ? sum / count : 0
      if (score > bestScore) {
        bestScore = score
        bestPhase = p
      }
    }

    const origin = this.frameTime(this.frameCount - n + bestPhase)
    this.beatPeriod = period

    if (Number.isFinite(this.nextBeat)) {
      // already running: ease towards the new phase so re-estimates never skip or double a beat
      const nearest = origin + Math.round((this.nextBeat - origin) / period) * period
      const delta = nearest - this.nextBeat
      this.nextBeat = Math.abs(delta) < 0.5 * period ? this.nextBeat + 0.3 * delta : nearest
      return
    }
    const floor = Math.max(this.lastBeat + 0.5 * period, this.now)
    this.nextBeat = origin + Math.ceil((floor - origin) / period) * period
  }
}
