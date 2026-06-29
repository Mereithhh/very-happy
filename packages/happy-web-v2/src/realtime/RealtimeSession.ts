// Shim: voice/realtime is cut in web v2. The data layer only reads "is there an
// active voice session" to gate some behavior; always "no".
export interface VoiceSession {
  id: string;
}

export function getVoiceSession(): VoiceSession | null {
  return null;
}

export function getCurrentRealtimeSessionId(): string | null {
  return null;
}
