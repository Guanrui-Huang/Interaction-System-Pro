import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const DEFAULT_MODEL_DIR = 'models/kws/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';
const TRANSDUCER_MODELS = [
  {
    encoder: 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
    decoder: 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx',
    joiner: 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  },
  {
    encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
    joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  },
] as const;

export type KeywordSpotterWaveform = { samples: Float32Array; sampleRate: number };
export type KeywordSpotterStream = {
  acceptWaveform(waveform: KeywordSpotterWaveform): void;
  inputFinished(): void;
};
export type KeywordSpotResult = { keyword: string };
export type KeywordSpotterHandle = {
  createStream(): KeywordSpotterStream;
  isReady(stream: KeywordSpotterStream): boolean;
  decode(stream: KeywordSpotterStream): void;
  getResult(stream: KeywordSpotterStream): KeywordSpotResult;
  reset(stream: KeywordSpotterStream): void;
};
export type SherpaOnnxNodeModule = {
  KeywordSpotter: new (config: unknown) => KeywordSpotterHandle;
};
export type CreateKeywordSpotterOptions = {
  module?: SherpaOnnxNodeModule;
  modelDir?: string;
  keywordsFile?: string;
  exists?: typeof existsSync;
};

function toAbsolutePath(value: string): string { return resolve(process.cwd(), value); }

export function defaultKeywordModelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHERPA_ONNX_KWS_MODEL_DIR?.trim() || DEFAULT_MODEL_DIR;
}

export function loadSherpaOnnxModule(): SherpaOnnxNodeModule | undefined {
  try {
    return createRequire(import.meta.url)('sherpa-onnx-node') as SherpaOnnxNodeModule;
  } catch {
    return undefined;
  }
}

export function createKeywordSpotter(options: CreateKeywordSpotterOptions = {}): KeywordSpotterHandle | undefined {
  const module = options.module ?? loadSherpaOnnxModule();
  if (!module) return undefined;
  const modelDir = toAbsolutePath(options.modelDir ?? defaultKeywordModelDir());
  const envKeywordsFile = process.env.SHERPA_ONNX_KWS_KEYWORDS_FILE?.trim();
  const keywordsFile = toAbsolutePath((options.keywordsFile ?? envKeywordsFile) || resolve(modelDir, 'keywords.txt'));
  const exists = options.exists ?? existsSync;
  const tokens = resolve(modelDir, 'tokens.txt');
  if (!exists(tokens) || !exists(keywordsFile)) return undefined;
  const modelFiles = TRANSDUCER_MODELS.find((model) =>
    Object.values(model).every((file) => exists(resolve(modelDir, file))),
  );
  if (!modelFiles) return undefined;

  try {
    return new module.KeywordSpotter({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: resolve(modelDir, modelFiles.encoder),
          decoder: resolve(modelDir, modelFiles.decoder),
          joiner: resolve(modelDir, modelFiles.joiner),
        },
        tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile,
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.0,
      keywordsThreshold: 0.25,
    });
  } catch {
    return undefined;
  }
}
