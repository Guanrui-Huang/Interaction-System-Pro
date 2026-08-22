import { describe, expect, it, vi } from 'vitest';
import {
  StructuredModelOutputShapeError,
  parseStructuredModelOutput,
} from '../src/services/structured-model-output';

describe('parseStructuredModelOutput', () => {
  it('repairs one structural parse failure and parses the replacement', async () => {
    const repair = vi.fn(async () => '{"kind":"report"}');
    const parse = (content: string) => {
      if (content === '{bad json') {
        throw new StructuredModelOutputShapeError(['invalid JSON']);
      }
      return JSON.parse(content) as { kind: string };
    };

    await expect(parseStructuredModelOutput({
      content: '{bad json',
      parse,
      repair,
    })).resolves.toEqual({ kind: 'report' });
    expect(repair).toHaveBeenCalledOnce();
  });

  it('returns the caller malformed-output error after a second structural failure', async () => {
    const repair = vi.fn(async () => '{still bad');
    const parse = () => {
      throw new StructuredModelOutputShapeError(['invalid JSON']);
    };
    const invalid = new Error('REPORT_INTENT_INVALID');

    await expect(parseStructuredModelOutput({
      content: '{bad json',
      parse,
      repair,
      invalidError: () => invalid,
    })).rejects.toBe(invalid);
    expect(repair).toHaveBeenCalledOnce();
  });

  it('returns evidence-policy errors immediately without requesting a structural repair', async () => {
    const repair = vi.fn(async () => '{"kind":"report"}');
    const evidenceError = new Error('EVIDENCE_POLICY_INVALID');

    await expect(parseStructuredModelOutput({
      content: '{"kind":"report"}',
      parse: () => { throw evidenceError; },
      repair,
    })).rejects.toBe(evidenceError);
    expect(repair).not.toHaveBeenCalled();
  });
});
