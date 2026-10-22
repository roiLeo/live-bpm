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
          <div class="relative inline-block">
            <span class="absolute top-1/2 -left-8 size-4 -translate-y-1/2 rounded-full transition-all duration-100" :class="beatOn ? 'bg-primary scale-125' : 'bg-neutral-300 dark:bg-neutral-600'" />
            <div class="text-primary mb-2 text-6xl font-bold">
              {{ bpm ? Math.round(bpm) : '--' }}
            </div>
          </div>
          <div class="text-muted text-sm tracking-wide uppercase">
            BPM<span v-if="bpm" class="ml-2 normal-case">({{ bpm.toFixed(1) }})</span>
          </div>
          <div v-if="isListening && statusText" class="text-muted mt-3 px-4 text-xs">{{ statusText }}</div>
          <UProgress v-if="isListening && status === 'warming'" :model-value="warmup * 100" size="xs" class="mx-auto mt-2 max-w-48" />
          <div v-if="confidence > 0" class="mt-4">
            <UProgress :model-value="confidence" color="primary" size="sm" animation="elastic" />
            <div class="mt-1 text-xs text-neutral-500">Confidence ~{{ confidence }}%</div>
          </div>
          <div v-if="isListening" class="mt-4 flex items-center justify-center gap-2">
            <UButton size="xs" :variant="tempoScale === 0.5 ? 'solid' : 'outline'" color="neutral" @click="toggleHalfTime">&frac12;&times;</UButton>
            <UButton size="xs" :variant="tempoScale === 2 ? 'solid' : 'outline'" color="neutral" @click="toggleDoubleTime">2&times;</UButton>
          </div>
        </div>
      </div>

      <div v-if="isListening" class="mb-6" aria-label="Input level">
        <UProgress :model-value="level * 100" size="xs" :color="tooQuiet ? 'warning' : 'success'" />
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
const canvasRef = ref(null)
const { isListening, bpm, confidence, status, warmup, level, tooQuiet, beat, tempoScale, error, start: startListening, stop: stopListening, toggleHalfTime, toggleDoubleTime } = useBpmDetector(canvasRef)

const beatOn = ref(false)
watch(beat, () => {
  beatOn.value = true
  setTimeout(() => (beatOn.value = false), 120)
})

const statusText = computed(() => {
  if (tooQuiet.value) return 'Too quiet – move closer to the music or raise the volume'
  if (status.value === 'warming') return 'Listening…'
  if (status.value === 'searching') return 'Searching for a steady beat…'
  return ''
})
</script>
