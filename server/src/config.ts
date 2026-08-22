import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve('server/.env') });

export function getDeepSeekConfig(): { apiKey: string; baseUrl: string; model: string } | null {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
  };
}
