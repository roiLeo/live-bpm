<template>
  <div class="mx-auto max-w-2xl">
    <div class="mb-8 text-center">
      <h1 class="text-highlighted mb-2 text-4xl font-bold">Live BPM Detector</h1>
      <p class="text-muted">Detect the tempo of live music in real-time</p>
    </div>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-musical-note" class="size-6" />
            <span class="font-semibold">Audio Analysis</span>
          </div>
          <UBadge v-if="isListening" color="success" variant="subtle">
            <UIcon name="i-heroicons-signal" class="size-3 animate-pulse" />
            Live
          </UBadge>
        </div>
      </template>

      <div class="mb-6">
        <div class="rounded-lg bg-neutral-50 py-8 text-center dark:bg-neutral-800">
          <div class="text-primary mb-2 text-6xl font-bold">
            {{ bpm || '--' }}
          </div>
          <div class="text-muted text-sm tracking-wide uppercase">BPM</div>
          <div v-if="confidence > 0" class="mt-4">
            <UProgress :value="confidence" color="primary" size="sm" animation="elastic" />
            <div class="mt-1 text-xs text-neutral-500">Confidence ~{{ confidence }}%</div>
          </div>
        </div>
      </div>

      <div v-show="isListening" class="mb-6">
        <div class="overflow-hidden rounded-lg bg-black" style="height: 200px">
          <canvas ref="canvasRef" class="h-full w-full" width="800" height="200" />
        </div>
      </div>

      <UAlert v-if="error.title" color="error" variant="subtle" :title="error.title" :description="error.message" class="mb-4" />

      <div class="flex gap-3">
        <UButton v-if="!isListening" color="primary" size="xl" block @click="startListening" icon="i-heroicons-microphone"> Start Listening </UButton>
        <UButton v-else color="error" size="xl" block @click="stopListening" icon="i-heroicons-stop"> Stop Listening </UButton>
      </div>

      <template #footer>
        <div class="text-muted text-xs">
          <UIcon name="i-heroicons-information-circle" class="inline size-4" />
          Make sure to allow microphone access. Works best with clear, rhythmic music.
        </div>
      </template>
    </UCard>

    <div class="my-6 grid grid-cols-1 gap-4 md:grid-cols-3">
      <UPageCard :ui="{ leadingIcon: 'size-8', description: 'text-xs' }" title="Live Detection" description="Real-time audio analysis" icon="i-heroicons-speaker-wave" spotlight spotlight-color="primary" />
      <UPageCard :ui="{ leadingIcon: 'size-8', description: 'text-xs' }" title="Visual Feedback" description="Live waveform display" icon="i-heroicons-chart-bar" spotlight spotlight-color="primary" />
      <UPageCard :ui="{ leadingIcon: 'size-8', description: 'text-xs' }" title="Instant Results" description="Fast BPM calculation" icon="i-heroicons-bolt" spotlight spotlight-color="primary" />
    </div>
  </div>
</template>

<script setup>
const isListening = ref(false)
const bpm = ref(0)
const confidence = ref(0)
const error = ref({ title: '', message: '' })

const audioContextRef = ref(null)
const analyserRef = ref(null)
const mediaStreamRef = ref(null)
const animationFrameRef = ref(null)
const canvasRef = ref(null)
const bpmDetectorRef = ref(null)

class BPMDetector {
  constructor(audioContext) {
    this.audioContext = audioContext
    this.sampleRate = audioContext.sampleRate
    this.intervals = []
    // start lastPeakTime at the current audio context time so the
    // first detected peak doesn't produce a huge interval
    this.lastPeakTime = audioContext.currentTime

    // base (minimum) threshold and adaptive RMS tracking
    // NOTE: lowered the base threshold because RMS values from
    // getByteTimeDomainData are typically small (0.01-0.1)
    this.threshold = 0.02
    this.avgRms = 0
    this.alpha = 0.92 // smoothing for running RMS average
    this.thresholdMultiplier = 2.2
    this.minAbsoluteThreshold = 0.01
    this.minTimeBetweenPeaks = 0.3 // 200 BPM max
    this.maxTimeBetweenPeaks = 1.2 // 50 BPM min
  }

  detectBeat(dataArray) {
    const currentTime = this.audioContext.currentTime

    // Calculate RMS (Root Mean Square) for volume detection
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = (dataArray[i] - 128) / 128
      sum += normalized * normalized
    }
    const rms = Math.sqrt(sum / dataArray.length)

    // update running average RMS
    this.avgRms = this.alpha * this.avgRms + (1 - this.alpha) * rms

    const dynamicThreshold = Math.max(this.threshold, this.avgRms * this.thresholdMultiplier, this.minAbsoluteThreshold)

    // Detect peak using adaptive threshold
    if (rms > dynamicThreshold && currentTime - this.lastPeakTime > this.minTimeBetweenPeaks) {
      const interval = currentTime - this.lastPeakTime

      if (interval < this.maxTimeBetweenPeaks) {
        this.intervals.push(interval)

        // Keep only last 32 intervals for moving average
        if (this.intervals.length > 32) {
          this.intervals.shift()
        }
      }

      this.lastPeakTime = currentTime
    }

    // Calculate BPM from intervals
    if (this.intervals.length >= 4) {
      // Remove outliers and calculate average
      const sorted = [...this.intervals].sort((a, b) => a - b)
      const q1 = sorted[Math.floor(sorted.length * 0.25)]
      const q3 = sorted[Math.floor(sorted.length * 0.75)]
      const iqr = q3 - q1

      const filtered = sorted.filter((val) => val >= q1 - 1.5 * iqr && val <= q3 + 1.5 * iqr)

      if (filtered.length > 0) {
        const avgInterval = filtered.reduce((a, b) => a + b, 0) / filtered.length
        const calculatedBPM = 60 / avgInterval

        // Confidence based on consistency
        const variance = filtered.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / filtered.length
        const stdDev = Math.sqrt(variance)
        const conf = Math.max(0, Math.min(100, 100 - stdDev * 100))

        return { bpm: Math.round(calculatedBPM), confidence: Math.round(conf) }
      }
    }

    return null
  }
}

const drawWaveform = () => {
  if (!analyserRef.value || !canvasRef.value) return

  const canvas = canvasRef.value
  const canvasCtx = canvas.getContext('2d')
  const analyser = analyserRef.value
  const bufferLength = analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)

  const draw = () => {
    animationFrameRef.value = requestAnimationFrame(draw)

    analyser.getByteTimeDomainData(dataArray)

    if (bpmDetectorRef.value) {
      const result = bpmDetectorRef.value.detectBeat(dataArray)
      if (result) {
        bpm.value = result.bpm
        confidence.value = result.confidence
      }
    }

    // clear canvas
    canvasCtx.fillStyle = 'rgb(0, 0, 0)'
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height)

    // waveform
    canvasCtx.lineWidth = 2
    canvasCtx.strokeStyle = 'rgb(147, 51, 234)'
    canvasCtx.beginPath()

    const sliceWidth = canvas.width / bufferLength
    let x = 0

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0
      const y = (v * canvas.height) / 2

      if (i === 0) {
        canvasCtx.moveTo(x, y)
      } else {
        canvasCtx.lineTo(x, y)
      }

      x += sliceWidth
    }

    canvasCtx.lineTo(canvas.width, canvas.height / 2)
    canvasCtx.stroke()
  }

  draw()
}

const startListening = async () => {
  try {
    error.value = { title: '', message: '' }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaStreamRef.value = stream

    const audioContext = new (window.AudioContext || window.webkitAudioContext)()
    // make sure the context is running (some browsers start in 'suspended')
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }
    audioContextRef.value = audioContext

    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    // reduce smoothing so transient peaks are preserved for beat detection
    analyser.smoothingTimeConstant = 0.3
    analyserRef.value = analyser

    const source = audioContext.createMediaStreamSource(stream)
    source.connect(analyser)

    bpmDetectorRef.value = new BPMDetector(audioContext)

    isListening.value = true
    drawWaveform()
  } catch (err) {
    error.value = {
      title: 'Failed to access microphone',
      message: 'Please ensure you have granted microphone access and try again.'
    }
    console.error('Error accessing microphone:', err)
  }
}

const stopListening = async () => {
  // stop the animation loop
  if (animationFrameRef.value) {
    cancelAnimationFrame(animationFrameRef.value)
    animationFrameRef.value = null
  }

  // stop all media tracks
  if (mediaStreamRef.value) {
    mediaStreamRef.value.getTracks().forEach((track) => track.stop())
    mediaStreamRef.value = null
  }

  // close audio context only if not already closed
  if (audioContextRef.value) {
    try {
      if (audioContextRef.value.state !== 'closed') {
        await audioContextRef.value.close()
      }
    } catch (err) {
      // avoid unhandled promise rejection
      console.warn('Error closing audio context:', err)
    }
    audioContextRef.value = null
  }

  // clear other refs
  analyserRef.value = null
  bpmDetectorRef.value = null

  isListening.value = false
  bpm.value = 0
  confidence.value = 0

  if (canvasRef.value) {
    const canvasCtx = canvasRef.value.getContext('2d')
    canvasCtx.fillStyle = 'rgb(0, 0, 0)'
    canvasCtx.fillRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  }
}

onUnmounted(() => {
  stopListening()
})
</script>
