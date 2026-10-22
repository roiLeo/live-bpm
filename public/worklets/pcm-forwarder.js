// Runs on the audio thread: forwards the mono input in fixed hops so the analysis has
// steady, sample-accurate timing and keeps running in background tabs.
class PcmForwarder extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.hopSize = options.processorOptions.hopSize
    this.buffer = new Float32Array(this.hopSize)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.hopSize) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(this.hopSize)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-forwarder', PcmForwarder)
