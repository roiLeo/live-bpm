const ENVELOPE_RATE = 100 // Hz, resampled onset envelope
const WINDOW_SECONDS = 8
const MIN_SECONDS = 4
const MIN_BPM = 70
const MAX_BPM = 180
const ESTIMATE_INTERVAL = 0.5 // seconds between tempo estimates
const HISTORY_SIZE = 5

interface Frame {
  t: number
  v: number
}

export interface BpmResult {
  bpm: number
  confidence: number
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

// Onset detection (spectral flux) + tempo estimation (autocorrelation of the onset envelope)
class BPMDetector {
  private audioContext: AudioContext
  private minBin: number
  private maxBin: number
  private prevSpectrum: Uint8Array | null = null
  private frames: Frame[] = []
  private lastEstimate = 0
  private history: number[] = []

  constructor(audioContext: AudioContext, binCount: number) {
    this.audioContext = audioContext
    const binHz = audioContext.sampleRate / 2 / binCount
    this.minBin = Math.max(1, Math.floor(30 / binHz))
    this.maxBin = Math.min(binCount, Math.ceil(5000 / binHz))
  }

  // spectrum: Uint8Array from getByteFrequencyData (dB scaled, so level independent)
  process(spectrum: Uint8Array): BpmResult | null {
    const t = this.audioContext.currentTime

    let flux = 0
    if (this.prevSpectrum) {
      for (let i = this.minBin; i < this.maxBin; i++) {
        const diff = spectrum[i]! - this.prevSpectrum[i]!
        if (diff > 0) flux += diff
      }
    } else {
      this.prevSpectrum = new Uint8Array(spectrum.length)
    }
    this.prevSpectrum.set(spectrum)

    this.frames.push({ t, v: flux })
    while (this.frames.length && t - this.frames[0]!.t > WINDOW_SECONDS) this.frames.shift()

    if (t - this.lastEstimate < ESTIMATE_INTERVAL) return null
    this.lastEstimate = t
    return this.estimate()
  }

  // resample irregular frames onto a fixed grid, remove local mean, half-wave rectify
  private buildEnvelope(): Float32Array {
    const frames = this.frames
    const first = frames[0]!
    const duration = frames[frames.length - 1]!.t - first.t
    const n = Math.floor(duration * ENVELOPE_RATE)
    const env = new Float32Array(n)

    let j = 0
    for (let i = 0; i < n; i++) {
      const t = first.t + i / ENVELOPE_RATE
      while (j < frames.length - 2 && frames[j + 1]!.t < t) j++
      const a = frames[j]!
      const b = frames[j + 1]!
      const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
      env[i] = a.v + (b.v - a.v) * k
    }

    const half = Math.round(ENVELOPE_RATE * 0.25)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      let count = 0
      for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) {
        sum += env[k]!
        count++
      }
      out[i] = Math.max(0, env[i]! - sum / count)
    }
    return out
  }

  private estimate(): BpmResult | null {
    const frames = this.frames
    if (frames.length < 2 || frames[frames.length - 1]!.t - frames[0]!.t < MIN_SECONDS) return null

    const env = this.buildEnvelope()
    const n = env.length
    const minLag = Math.floor((60 / MAX_BPM) * ENVELOPE_RATE) - 1
    const maxLag = Math.ceil((60 / MIN_BPM) * ENVELOPE_RATE) + 1
    const maxNeeded = Math.min(n - 1, maxLag * 2)

    const ac = new Float32Array(maxNeeded + 1)
    for (let lag = 0; lag <= maxNeeded; lag++) {
      let sum = 0
      for (let i = 0; i + lag < n; i++) sum += env[i]! * env[i + lag]!
      ac[lag] = sum / (n - lag) // unbiased
    }
    const ac0 = ac[0]!
    if (ac0 < 1e-3) return null // silence / no onsets

    // score each lag: its own correlation plus its double (beat vs. subdivisions)
    const score = (lag: number) => (ac[lag]! + 0.5 * (lag * 2 <= maxNeeded ? ac[lag * 2]! : 0)) / ac0

    let bestLag = -1
    let bestScore = 0
    for (let lag = minLag; lag <= maxLag && lag <= maxNeeded; lag++) {
      const bpmAtLag = (60 * ENVELOPE_RATE) / lag
      // mild preference for common tempos around 120 BPM
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpmAtLag / 120) / 0.8, 2))
      const s = score(lag) * (0.7 + 0.3 * prior)
      if (s > bestScore) {
        bestScore = s
        bestLag = lag
      }
    }
    if (bestLag < 0) return null

    // parabolic interpolation for sub-sample lag
    let lag = bestLag
    if (bestLag > 0 && bestLag < maxNeeded) {
      const y0 = ac[bestLag - 1]!
      const y1 = ac[bestLag]!
      const y2 = ac[bestLag + 1]!
      const denom = y0 - 2 * y1 + y2
      if (denom < 0) lag += Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom))
    }

    const rawBpm = (60 * ENVELOPE_RATE) / lag
    const confidence = Math.round(Math.max(0, Math.min(100, (ac[bestLag]! / ac0) * 200)))
    if (confidence < 10) return null

    this.history.push(rawBpm)
    if (this.history.length > HISTORY_SIZE) this.history.shift()

    return { bpm: Math.round(median(this.history)), confidence }
  }
}

export const useBpmDetector = (canvasRef?: Ref<HTMLCanvasElement | null>) => {
  const isListening = ref(false)
  const bpm = ref(0)
  const confidence = ref(0)
  const error = ref({ title: '', message: '' })

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let mediaStream: MediaStream | null = null
  let animationFrame: number | null = null
  let detector: BPMDetector | null = null

  const clearCanvas = () => {
    const canvas = canvasRef?.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = 'rgb(0, 0, 0)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  const run = (analyser: AnalyserNode, detector: BPMDetector) => {
    const spectrum = new Uint8Array(analyser.frequencyBinCount)
    const waveform = new Uint8Array(analyser.fftSize)

    const frame = () => {
      animationFrame = requestAnimationFrame(frame)

      analyser.getByteFrequencyData(spectrum)
      const result = detector.process(spectrum)
      if (result) {
        bpm.value = result.bpm
        confidence.value = result.confidence
      }

      const canvas = canvasRef?.value
      if (!canvas) return
      analyser.getByteTimeDomainData(waveform)

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = 'rgb(0, 0, 0)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgb(147, 51, 234)'
      ctx.beginPath()

      const sliceWidth = canvas.width / waveform.length
      for (let i = 0; i < waveform.length; i++) {
        const y = ((waveform[i]! / 128) * canvas.height) / 2
        if (i === 0) ctx.moveTo(0, y)
        else ctx.lineTo(i * sliceWidth, y)
      }
      ctx.stroke()
    }

    frame()
  }

  const start = async (): Promise<void> => {
    try {
      error.value = { title: '', message: '' }

      // raw signal: no echo cancellation / noise suppression / AGC mangling the beats
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })

      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (audioContext.state === 'suspended') await audioContext.resume()

      const newAnalyser = audioContext.createAnalyser()
      newAnalyser.fftSize = 2048
      newAnalyser.smoothingTimeConstant = 0 // spectral flux needs unsmoothed frames
      audioContext.createMediaStreamSource(mediaStream).connect(newAnalyser)

      analyser = newAnalyser
      detector = new BPMDetector(audioContext, newAnalyser.frequencyBinCount)
      isListening.value = true
      run(newAnalyser, detector)
    } catch (err) {
      await stop()
      error.value = {
        title: 'Failed to access microphone',
        message: 'Please ensure you have granted microphone access and try again.'
      }
      console.error('Error accessing microphone:', err)
    }
  }

  const stop = async (): Promise<void> => {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame)
      animationFrame = null
    }

    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null

    if (audioContext && audioContext.state !== 'closed') {
      try {
        await audioContext.close()
      } catch (err) {
        console.warn('Error closing audio context:', err)
      }
    }
    audioContext = null
    analyser = null
    detector = null

    isListening.value = false
    bpm.value = 0
    confidence.value = 0
    clearCanvas()
  }

  onUnmounted(stop)

  return { isListening, bpm, confidence, error, start, stop }
}
