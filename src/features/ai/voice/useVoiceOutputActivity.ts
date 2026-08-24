import { useSyncExternalStore } from 'react';
import { voiceOutputArbiter, type VoiceOutputArbiter } from './voice-output-arbiter';

export function useVoiceOutputActivity(arbiter: VoiceOutputArbiter = voiceOutputArbiter): boolean {
  return useSyncExternalStore(
    arbiter.subscribe,
    arbiter.getActive,
    () => false,
  );
}
