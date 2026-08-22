import { expect, it, vi } from 'vitest';
import type { QwenOmniConfig } from '../src/services/voice/omni-config';
import {
  NATURAL_NARRATION_INSTRUCTION,
  prepareNaturalNarrationText,
  synthesizeDashScopeSpeech,
} from '../src/services/voice/dashscope-tts';

const config: QwenOmniConfig = {
  apiKey: 'dashscope-secret',
  workspaceId: 'workspace-1',
  region: 'cn',
  model: 'qwen3.5-omni-flash-realtime',
  baseUrl: 'wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  speechModel: 'qwen-audio-3.0-tts-plus',
  speechBaseUrl: 'https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  speechVoice: 'longanlingxin',
};

function wav(payload = Buffer.from([1, 0, 2, 0])): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + payload.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(payload.byteLength, 40);
  return Buffer.concat([header, payload]);
}

it('uses the dedicated natural narration model and downloads a trusted WAV result', async () => {
  const audio = wav();
  const fetchMock = vi.fn(async (
    url: string | URL | Request,
    _request?: RequestInit,
  ) => {
    if (String(url) === config.speechBaseUrl) {
      return Response.json({
        output: {
          audio: {
            url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?signature=test',
          },
        },
      });
    }
    const body = audio.buffer.slice(
      audio.byteOffset,
      audio.byteOffset + audio.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { status: 200 });
  });

  const result = await synthesizeDashScopeSpeech({
    config,
    text: '本页现场结论。',
    signal: new AbortController().signal,
    maxAudioBytes: 1_024,
    fetchImpl: fetchMock as unknown as typeof fetch,
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [requestUrl, request] = fetchMock.mock.calls[0]!;
  expect(requestUrl).toBe(config.speechBaseUrl);
  expect((request as RequestInit).headers).toEqual(expect.objectContaining({
    Authorization: 'Bearer dashscope-secret',
  }));
  const payload = JSON.parse(String((request as RequestInit).body));
  expect(payload).toEqual({
    model: 'qwen-audio-3.0-tts-plus',
    input: {
      text: '[empathetic]本页现场结论。',
      voice: 'longanlingxin',
      format: 'wav',
      sample_rate: 24_000,
      volume: 50,
      rate: 1,
      pitch: 1,
      language_hints: ['zh'],
      instruction: NATURAL_NARRATION_INSTRUCTION,
    },
  });
  expect(String(fetchMock.mock.calls[1]![0])).toMatch(/^https:\/\/dashscope-result-bj\.oss-cn-beijing\.aliyuncs\.com\//u);
  expect(result).toEqual(audio);
});

it('changes tone at risk and recommendation boundaries without rewriting narration', () => {
  expect(Array.from(NATURAL_NARRATION_INSTRUCTION).length).toBeLessThanOrEqual(128);
  expect(prepareNaturalNarrationText(
    '当前出水水质保持稳定。二号池出现异常波动，存在风险。下一步建议复核溶解氧。',
  )).toBe(
    '[empathetic]当前出水水质保持稳定。'
    + '[serious]二号池出现异常波动，存在风险。'
    + '[empathetic]下一步建议复核溶解氧。',
  );
});

it('maps authentication failures and rejects untrusted audio locations', async () => {
  const authFetch = vi.fn(async () => new Response('denied', { status: 403 })) as typeof fetch;
  await expect(synthesizeDashScopeSpeech({
    config,
    text: '测试',
    signal: new AbortController().signal,
    maxAudioBytes: 1_024,
    fetchImpl: authFetch,
  })).rejects.toMatchObject({ code: 'DASHSCOPE_TTS_AUTH' });

  const untrustedFetch = vi.fn(async () => Response.json({
    output: { audio: { url: 'https://example.com/audio.wav' } },
  })) as typeof fetch;
  await expect(synthesizeDashScopeSpeech({
    config,
    text: '测试',
    signal: new AbortController().signal,
    maxAudioBytes: 1_024,
    fetchImpl: untrustedFetch,
  })).rejects.toMatchObject({ code: 'DASHSCOPE_TTS_UPSTREAM' });
});

it('rejects malformed or oversized audio', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({
      output: { audio: { url: 'https://result.aliyuncs.com/audio.wav' } },
    }))
    .mockResolvedValueOnce(new Response('not a wav', { status: 200 }));

  await expect(synthesizeDashScopeSpeech({
    config,
    text: '测试',
    signal: new AbortController().signal,
    maxAudioBytes: 4,
    fetchImpl: fetchMock as typeof fetch,
  })).rejects.toMatchObject({ code: 'DASHSCOPE_TTS_UPSTREAM' });
});
