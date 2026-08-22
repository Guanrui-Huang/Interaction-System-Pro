/** Converts a continuous Float32 PCM stream to signed 16-bit PCM. */
export class Pcm16Resampler {
  private readonly step: number;
  private inputCount = 0;
  private nextOutputPosition = 0;
  private previousSample = 0;

  constructor(inputSampleRate: number, outputSampleRate: number) {
    if (!Number.isFinite(inputSampleRate) || !Number.isFinite(outputSampleRate)
      || inputSampleRate <= 0 || outputSampleRate <= 0) {
      throw new RangeError('Sample rates must be positive finite numbers');
    }
    this.step = inputSampleRate / outputSampleRate;
  }

  push(input: Float32Array): Int16Array {
    if (input.length === 0) return new Int16Array();

    const chunkStart = this.inputCount;
    const chunkEnd = chunkStart + input.length - 1;
    const samples: number[] = [];

    while (this.nextOutputPosition <= chunkEnd) {
      const lowerIndex = Math.floor(this.nextOutputPosition);
      const upperIndex = Math.ceil(this.nextOutputPosition);
      if (upperIndex > chunkEnd) break;

      const fraction = this.nextOutputPosition - lowerIndex;
      const lower = this.sampleAt(lowerIndex, chunkStart, input);
      const upper = this.sampleAt(upperIndex, chunkStart, input);
      samples.push(toPcm16(lower + (upper - lower) * fraction));
      this.nextOutputPosition += this.step;
    }

    this.inputCount += input.length;
    this.previousSample = input[input.length - 1];
    return Int16Array.from(samples);
  }

  reset(): void {
    this.inputCount = 0;
    this.nextOutputPosition = 0;
    this.previousSample = 0;
  }

  private sampleAt(index: number, chunkStart: number, input: Float32Array): number {
    return index === chunkStart - 1 ? this.previousSample : input[index - chunkStart];
  }
}

function toPcm16(sample: number): number {
  const bounded = Math.max(-1, Math.min(1, sample));
  return bounded <= -1 ? -32_768 : Math.round(bounded * 32_767);
}
