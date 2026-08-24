export type VoiceOutputKind = 'prompt' | 'narration';

export type VoiceOutputLease = {
  isCurrent(): boolean;
  release(): void;
};

type ActiveOutput = {
  id: number;
  kind: VoiceOutputKind;
  stop(): Promise<void>;
};

export type VoiceOutputArbiter = {
  acquire(
    kind: VoiceOutputKind,
    stop: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<VoiceOutputLease | null>;
  getActive(): boolean;
  subscribe(listener: () => void): () => void;
};

export function createVoiceOutputArbiter(): VoiceOutputArbiter {
  let sequence = 0;
  let active: ActiveOutput | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const waitForChange = (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const finish = (changed: boolean) => {
      listeners.delete(onChange);
      signal?.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onChange = () => finish(true);
    const onAbort = () => finish(false);
    listeners.add(onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const acquire: VoiceOutputArbiter['acquire'] = async (kind, stop, signal) => {
    while (kind === 'narration' && active?.kind === 'prompt') {
      if (!await waitForChange(signal)) return null;
    }
    if (signal?.aborted) return null;
    const claim: ActiveOutput = { id: ++sequence, kind, stop };
    const previous = active;
    active = claim;
    notify();
    if (previous) {
      try {
        await previous.stop();
      } catch {
        // Ownership still transfers when stopping the previous output fails.
      }
    }
    if (signal?.aborted || active !== claim) {
      if (active === claim) {
        active = null;
        notify();
      }
      return null;
    }
    return {
      isCurrent: () => active === claim,
      release: () => {
        if (active !== claim) return;
        active = null;
        notify();
      },
    };
  };

  return {
    acquire,
    getActive: () => active !== null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const voiceOutputArbiter = createVoiceOutputArbiter();
