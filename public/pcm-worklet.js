// AudioWorklet: collects mic input into 2048-sample Float32 chunks and posts
// them to the main thread for resampling + VAD + utterance segmentation. Runs
// at the AudioContext's ACTUAL rate — useRecorder normalizes whatever that is
// to 16 kHz before anything else touches the samples.
class PcmChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this._buffer[this._filled++] = channel[i];
        if (this._filled === this._buffer.length) {
          // Copy so we never hand off a buffer we keep writing to.
          this.port.postMessage(this._buffer.slice());
          this._filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-chunker', PcmChunker);