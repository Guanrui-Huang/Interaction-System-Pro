import type { QwenOmniConfig } from './omni-config';

export type DashScopeTtsErrorCode = 'DASHSCOPE_TTS_AUTH' | 'DASHSCOPE_TTS_UPSTREAM';

export class DashScopeTtsError extends Error {
  constructor(readonly code: DashScopeTtsErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'DashScopeTtsError';
  }
}

export type SynthesizeDashScopeSpeechInput = {
  config: QwenOmniConfig;
  text: string;
  signal: AbortSignal;
  maxAudioBytes: number;
  fetchImpl?: typeof fetch;
};

const MAX_METADATA_BYTES = 256 * 1024;
const SAMPLE_RATE = 24_000;

export const NATURAL_NARRATION_INSTRUCTION = [
  '像真人讲解员自然说话。',
  '语调有起伏，句间自然换气，句尾自然降调，关键数字适度重读。',
  '异常语气收紧，建议语气温和坚定，不要播音腔或夸张表演。',
].join('');

const NARRATION_SENTENCE_PATTERN = /[^。！？；!?]+[。！？；!?]?/gu;
const RISK_LANGUAGE = /异常|风险|超标|预警|故障|恶化|突增|突降|峰值|剧烈波动|偏高|偏低/iu;
const ACTION_LANGUAGE = /建议|下一步|需要|应当|应优先|请关注|可考虑|保持|优化|复核|检查/iu;

type NarrationTone = 'empathetic' | 'serious';

function toneForSentence(sentence: string): NarrationTone {
  if (RISK_LANGUAGE.test(sentence)) return 'serious';
  if (ACTION_LANGUAGE.test(sentence)) return 'empathetic';
  return 'empathetic';
}

export function prepareNaturalNarrationText(text: string): string {
  const sentences = text.match(NARRATION_SENTENCE_PATTERN);
  if (!sentences?.length) return `[empathetic]${text}`;

  let activeTone: NarrationTone | undefined;
  return sentences.map((sentence) => {
    const tone = toneForSentence(sentence);
    if (tone === activeTone) return sentence;
    activeTone = tone;
    return `[${tone}]${sentence}`;
  }).join('');
}

type TtsMetadata = {
  output: {
    audio: {
      url: string;
    };
  };
};

function isTtsMetadata(value: unknown): value is TtsMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const output = (value as { output?: unknown }).output;
  if (typeof output !== 'object' || output === null) return false;
  const audio = (output as { audio?: unknown }).audio;
  return typeof audio === 'object'
    && audio !== null
    && typeof (audio as { url?: unknown }).url === 'string';
}

function isWav(bytes: Buffer): boolean {
  return bytes.byteLength >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WAVE';
}

function trustedAudioUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM', error);
  }
  const trustedHost = url.hostname === 'aliyuncs.com' || url.hostname.endsWith('.aliyuncs.com');
  if (!trustedHost || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM');
  }
  url.protocol = 'https:';
  return url.href;
}

async function readBoundedBytes(response: Response, maximum: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM');
  }
  if (!response.body) throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchAudioMetadata(
  input: SynthesizeDashScopeSpeechInput,
  fetchImpl: typeof fetch,
): Promise<TtsMetadata> {
  let response: Response;
  try {
    response = await fetchImpl(input.config.speechBaseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.config.speechModel,
        input: {
          text: prepareNaturalNarrationText(input.text),
          voice: input.config.speechVoice,
          format: 'wav',
          sample_rate: SAMPLE_RATE,
          volume: 50,
          rate: 1,
          pitch: 1,
          language_hints: ['zh'],
          instruction: NATURAL_NARRATION_INSTRUCTION,
        },
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM', error);
  }

  if (!response.ok) {
    throw new DashScopeTtsError(
      response.status === 401 || response.status === 403
        ? 'DASHSCOPE_TTS_AUTH'
        : 'DASHSCOPE_TTS_UPSTREAM',
      `HTTP ${response.status}`,
    );
  }

  try {
    const metadataBytes = await readBoundedBytes(response, MAX_METADATA_BYTES);
    const metadata: unknown = JSON.parse(metadataBytes.toString('utf8'));
    if (!isTtsMetadata(metadata)) throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM');
    return metadata;
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (error instanceof DashScopeTtsError) throw error;
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM', error);
  }
}

export async function synthesizeDashScopeSpeech(
  input: SynthesizeDashScopeSpeechInput,
): Promise<Buffer> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const metadata = await fetchAudioMetadata(input, fetchImpl);

  let audioResponse: Response;
  try {
    audioResponse = await fetchImpl(trustedAudioUrl(metadata.output.audio.url), {
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (error instanceof DashScopeTtsError) throw error;
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM', error);
  }
  if (!audioResponse.ok) {
    throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM', `HTTP ${audioResponse.status}`);
  }

  const audio = await readBoundedBytes(audioResponse, input.maxAudioBytes);
  if (!isWav(audio)) throw new DashScopeTtsError('DASHSCOPE_TTS_UPSTREAM');
  return audio;
}
