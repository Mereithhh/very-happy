/**
 * Web ASR (dictation) for the composer. Records a mic clip with MediaRecorder,
 * sends it to the server STT proxy (ElevenLabs Scribe), and hands the transcript
 * back so the caller can drop it into the input box for the user to edit. This
 * is the "frontend only does ASR" flow — no realtime agent, no paywall.
 *
 * Web-only: `supported` is false everywhere else (native keeps the conversational
 * agent), and the browser APIs are only ever touched after the `supported` guard.
 */
import * as React from 'react';
import { Platform } from 'react-native';
import { TokenStorage } from '@/auth/tokenStorage';
import { transcribeAudio } from '@/sync/apiVoice';

/** Chrome records webm/opus; Safari only mp4. '' → let the browser choose. */
function pickMimeType(): string {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const c of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
        try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* older browser */ }
    }
    return '';
}

async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const chunk = 0x8000; // chunk to avoid arg-count limits on fromCharCode
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

export interface VoiceTranscription {
    supported: boolean;
    recording: boolean;
    transcribing: boolean;
    toggle: () => Promise<void>;
}

export function useVoiceTranscription(onText: (text: string) => void): VoiceTranscription {
    const [recording, setRecording] = React.useState(false);
    const [transcribing, setTranscribing] = React.useState(false);
    const recorderRef = React.useRef<MediaRecorder | null>(null);
    const chunksRef = React.useRef<Blob[]>([]);
    const streamRef = React.useRef<MediaStream | null>(null);
    const onTextRef = React.useRef(onText);
    onTextRef.current = onText;

    const supported = Platform.OS === 'web'
        && typeof navigator !== 'undefined'
        && !!navigator.mediaDevices
        && typeof MediaRecorder !== 'undefined';

    const releaseStream = React.useCallback(() => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];
    }, []);

    const stop = React.useCallback(() => {
        const rec = recorderRef.current;
        if (!rec) return;
        try {
            rec.stop(); // onstop transcribes + releases
        } catch {
            releaseStream();
            setRecording(false);
        }
    }, [releaseStream]);

    const start = React.useCallback(async () => {
        if (!supported) return;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            console.warn('[asr] microphone unavailable', e);
            return;
        }
        const mimeType = pickMimeType();
        const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        streamRef.current = stream;
        recorderRef.current = rec;
        chunksRef.current = [];

        rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
        rec.onstop = async () => {
            const type = rec.mimeType || 'audio/webm';
            const blob = new Blob(chunksRef.current, { type });
            releaseStream();
            setRecording(false);
            if (blob.size === 0) return;
            setTranscribing(true);
            try {
                const credentials = await TokenStorage.getCredentials();
                if (!credentials) throw new Error('not authenticated');
                const base64 = await blobToBase64(blob);
                const text = await transcribeAudio(credentials, base64, type);
                if (text) onTextRef.current(text);
            } catch (e) {
                console.warn('[asr] transcription failed', e);
            } finally {
                setTranscribing(false);
            }
        };

        rec.start();
        setRecording(true);
    }, [supported, releaseStream]);

    const toggle = React.useCallback(async () => {
        if (transcribing) return;
        if (recorderRef.current) stop();
        else await start();
    }, [transcribing, start, stop]);

    // Stop any active recording/stream on unmount.
    React.useEffect(() => () => {
        const rec = recorderRef.current;
        if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* gone */ } }
        streamRef.current?.getTracks().forEach((t) => t.stop());
    }, []);

    return { supported, recording, transcribing, toggle };
}
