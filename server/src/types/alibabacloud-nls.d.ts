declare module 'alibabacloud-nls' {
  type Handler = (...args: any[]) => void;
  type Config = { url: string; appkey: string; token: string };

  export class SpeechTranscription {
    constructor(config: Config);
    defaultStartParams(): Record<string, unknown>;
    on(event: 'started' | 'changed' | 'completed' | 'closed' | 'failed' | 'begin' | 'end', handler: Handler): void;
    start(params: Record<string, unknown>, enablePing?: boolean, pingInterval?: number): Promise<unknown>;
    close(params?: Record<string, unknown>): Promise<unknown>;
    shutdown(): void;
    sendAudio(data: Buffer): boolean;
  }

  export class SpeechSynthesizer {
    constructor(config: Config);
    defaultStartParams(): Record<string, unknown>;
    on(event: 'meta' | 'data' | 'completed' | 'closed' | 'failed', handler: Handler): void;
    start(params: Record<string, unknown>, enablePing?: boolean, pingInterval?: number): Promise<unknown>;
    shutdown(): void;
  }
}
