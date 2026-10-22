import { BpmEngine, HOP_SIZE, type BpmStatus } from '~/utils/bpmEngine'

export type TempoScale = 0.5 | 1 | 2

export const useBpmDetector = (canvasRef?: Ref<HTMLCanvasElement | null>) => {
  // resolved up front: the Nuxt context isn't available after an await
  const workletUrl = useRuntimeConfig().app.baseURL + 'worklets/pcm-forwarder.js'

  const isListening = ref(false)
  const bpm = ref(0)
  const confidence = ref(0)
  const status = ref<BpmStatus | 'idle'>('idle')
  const warmup = ref(0)
  const level = ref(0) // 0..1 meter position
  const tooQuiet = ref(false)
  const beat = ref(0) // increments on every detected beat
  const tempoScale = ref<TempoScale>(1)
  const error = ref({ title: '', message: '' })

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let mediaStream: MediaStream | null = null
  let worklet: AudioWorkletNode | null = null
  let animationFrame: number | null = null
  let engine: BpmEngine | null = null

  const clearCanvas = () => {
    const canvas = canvasRef?.value
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.fillStyle = 'rgb(0, 0, 0)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  const syncState = () => {
    if (!engine) return
    bpm.value = engine.bpm
    confidence.value = engine.confidence
    status.value = engine.status
    warmup.value = engine.warmup
    tooQuiet.value = engine.tooQuiet
    beat.value = engine.beatCount
    // -60 dBFS .. 0 dBFS onto 0..1
    level.value = Math.round(Math.max(0, Math.min(1, 1 + Math.log10(Math.max(engine.level, 1e-6)) / 3)) * 100) / 100
  }

  // waveform only; detection happens in the worklet message handler
  const drawWaveform = () => {
    if (!analyser) return
    const waveform = new Uint8Array(analyser.fftSize)

    const frame = () => {
      animationFrame = requestAnimationFrame(frame)
      const canvas = canvasRef?.value
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx || !analyser) return

      analyser.getByteTimeDomainData(waveform)
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
    if (isListening.value) return
    try {
      error.value = { title: '', message: '' }

      // raw signal: no echo cancellation / noise suppression / AGC mangling the beats
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })

      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (audioContext.state === 'suspended') await audioContext.resume()

      await audioContext.audioWorklet.addModule(workletUrl)

      engine = new BpmEngine(audioContext.sampleRate)
      engine.setTempoScale(tempoScale.value)

      const source = audioContext.createMediaStreamSource(mediaStream)

      analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)

      worklet = new AudioWorkletNode(audioContext, 'pcm-forwarder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { hopSize: HOP_SIZE } })
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        engine?.push(event.data)
        syncState()
      }
      // a silent sink keeps the worklet pulled by the graph without playing the mic back
      const sink = audioContext.createGain()
      sink.gain.value = 0
      source.connect(worklet)
      worklet.connect(sink).connect(audioContext.destination)

      isListening.value = true
      syncState()
      drawWaveform()
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

    if (worklet) {
      worklet.port.onmessage = null
      worklet.disconnect()
      worklet = null
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
    engine = null

    isListening.value = false
    bpm.value = 0
    confidence.value = 0
    status.value = 'idle'
    warmup.value = 0
    level.value = 0
    tooQuiet.value = false
    clearCanvas()
  }

  // correct half / double time readings
  const setTempoScale = (scale: TempoScale) => {
    tempoScale.value = scale
    engine?.setTempoScale(scale)
    syncState()
  }
  const toggleHalfTime = () => setTempoScale(tempoScale.value === 0.5 ? 1 : 0.5)
  const toggleDoubleTime = () => setTempoScale(tempoScale.value === 2 ? 1 : 2)

  onUnmounted(stop)

  return { isListening, bpm, confidence, status, warmup, level, tooQuiet, beat, tempoScale, error, start, stop, toggleHalfTime, toggleDoubleTime }
}
