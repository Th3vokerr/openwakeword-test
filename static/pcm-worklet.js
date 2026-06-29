class Pcm16kWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputSampleRate = options.processorOptions.inputSampleRate;
    this.outputSampleRate = options.processorOptions.outputSampleRate;
    this.frameSamples = options.processorOptions.frameSamples;
    this.ratio = this.inputSampleRate / this.outputSampleRate;
    this.sourceBuffer = [];
    this.outputBuffer = [];
    this.readIndex = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let index = 0; index < input.length; index += 1) {
      this.sourceBuffer.push(input[index]);
    }

    while (this.readIndex + 1 < this.sourceBuffer.length) {
      const before = Math.floor(this.readIndex);
      const after = before + 1;
      const fraction = this.readIndex - before;
      const sample =
        this.sourceBuffer[before] +
        (this.sourceBuffer[after] - this.sourceBuffer[before]) * fraction;

      this.outputBuffer.push(Math.max(-1, Math.min(1, sample)));
      this.readIndex += this.ratio;

      if (this.outputBuffer.length === this.frameSamples) {
        this.postFrame();
      }
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.sourceBuffer.splice(0, consumed);
      this.readIndex -= consumed;
    }

    return true;
  }

  postFrame() {
    const pcm = new Int16Array(this.frameSamples);
    for (let index = 0; index < this.frameSamples; index += 1) {
      const sample = this.outputBuffer[index];
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    this.outputBuffer = [];
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}

registerProcessor("pcm-16k-worklet", Pcm16kWorklet);
