import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createKeywordSpotter,
  defaultKeywordModelDir,
  type KeywordSpotterHandle,
  type SherpaOnnxNodeModule,
} from '../src/services/voice/keyword-spotter';

const REQUIRED_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
] as const;

class FakeKeywordSpotter {
  static lastConfig: unknown;

  constructor(config: unknown) {
    FakeKeywordSpotter.lastConfig = config;
  }

  createStream(): never { throw new Error('not used in unit test'); }
  isReady(): boolean { return false; }
  decode(): void {}
  getResult(): { keyword: string } { return { keyword: '' }; }
  reset(): void {}
}

const fakeModule: SherpaOnnxNodeModule = {
  KeywordSpotter: FakeKeywordSpotter as unknown as new (config: unknown) => KeywordSpotterHandle,
};
const tempDirs: string[] = [];

function makeModelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kws-unit-'));
  tempDirs.push(dir);
  for (const file of REQUIRED_FILES) writeFileSync(join(dir, file), '');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  FakeKeywordSpotter.lastConfig = undefined;
});

it('builds a spotter config from the bundled int8 model files', () => {
  const modelDir = makeModelDir();
  const keywordsFile = join(modelDir, 'keywords.txt');
  writeFileSync(keywordsFile, 'x iǎo zh ì x iǎo zh ì @小智小智\n');

  const spotter = createKeywordSpotter({ module: fakeModule, modelDir, keywordsFile });

  expect(spotter).toBeInstanceOf(FakeKeywordSpotter);
  expect(FakeKeywordSpotter.lastConfig).toMatchObject({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: resolve(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: resolve(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        joiner: resolve(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      },
      tokens: resolve(modelDir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
    },
    keywordsFile,
  });
});

it('loads the bilingual model with its quantized encoder and joiner', () => {
  const modelDir = makeModelDir();
  const encoder = join(modelDir, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx');
  const decoder = join(modelDir, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx');
  const joiner = join(modelDir, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx');
  const keywordsFile = join(modelDir, 'keywords.txt');
  for (const file of [encoder, decoder, joiner]) writeFileSync(file, '');
  writeFileSync(keywordsFile, 'HH AY1 K EH1 R AH0 N @Hi_Karen\n');

  expect(createKeywordSpotter({ module: fakeModule, modelDir })).toBeInstanceOf(FakeKeywordSpotter);
  expect(FakeKeywordSpotter.lastConfig).toMatchObject({
    modelConfig: { transducer: { encoder, decoder, joiner } },
    keywordsFile,
  });
});

it('returns undefined when any required model file is missing', () => {
  const modelDir = makeModelDir();
  rmSync(join(modelDir, 'tokens.txt'));
  expect(createKeywordSpotter({ module: fakeModule, modelDir })).toBeUndefined();
});

it('returns undefined when the keywords file is missing', () => {
  expect(createKeywordSpotter({ module: fakeModule, modelDir: makeModelDir() })).toBeUndefined();
});

it('resolves the default model dir from the environment with trimming', () => {
  expect(defaultKeywordModelDir({})).toContain('sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20');
  expect(defaultKeywordModelDir({ SHERPA_ONNX_KWS_MODEL_DIR: ' custom/models ' })).toBe('custom/models');
});
