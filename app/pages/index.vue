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
const canvasRef = ref(null)
const { isListening, bpm, confidence, error, start: startListening, stop: stopListening } = useBpmDetector(canvasRef)
</script>
