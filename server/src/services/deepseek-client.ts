import { z } from 'zod';
import type { AiErrorCode } from '../../../shared/ai';

export type DeepSeekSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type DeepSeekServiceErrorDetails = {
  availableDateRange?: { from: string; to: string };
};

export class DeepSeekServiceError extends Error {
  declare readonly details?: DeepSeekServiceErrorDetails;

  constructor(
    readonly code: Exclude<AiErrorCode, 'INVALID_REQUEST'>,
    details?: DeepSeekServiceErrorDetails,
  ) {
    super(code);
    this.name = 'DeepSeekServiceError';
    if (details !== undefined) {
      Object.defineProperty(this, 'details', {
        configurable: true,
        enumerable: true,
        value: details,
      });
    }
  }
}

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

export type DeepSeekCompletionRequest = {
  settings: DeepSeekSettings;
  prompt: string;
  temperature: number;
  timeoutMs: number;
  maxTokens?: number;
  maxOutputCharacters?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  responseFormat?: { type: 'json_object' };
  transportRetry?: 'allowed' | 'disabled';
};

export async function requestDeepSeekCompletion(input: DeepSeekCompletionRequest): Promise<string> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.settings.model,
        temperature: input.temperature,
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        messages: [{ role: 'user', content: input.prompt }],
        ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new DeepSeekServiceError('UPSTREAM_HTTP');
    }

    let rawPayload: unknown;
    try {
      rawPayload = await response.json();
    } catch {
      throw new DeepSeekServiceError('MALFORMED_RESPONSE');
    }

    const parsed = responseSchema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new DeepSeekServiceError('MALFORMED_RESPONSE');
    }

    const content = parsed.data.choices[0].message.content.trim();
    if (!content) {
      throw new DeepSeekServiceError('EMPTY_ANSWER');
    }
    if (
      input.maxOutputCharacters !== undefined
      && Array.from(content).length > input.maxOutputCharacters
    ) {
      throw new DeepSeekServiceError('MALFORMED_RESPONSE');
    }

    return content;
  } catch (error) {
    if (error instanceof DeepSeekServiceError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new DeepSeekServiceError('UPSTREAM_TIMEOUT');
    }
    throw new DeepSeekServiceError('UPSTREAM_HTTP');
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}
