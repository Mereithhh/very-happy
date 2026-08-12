/**
 * useHoldToTalk — press-and-hold recording for the assistant PTT button.
 *
 * All DECISIONS live in recorderMachine.ts (pure, unit-tested); this hook
 * executes the effects: mic acquisition, MediaRecorder lifecycle, base64
 * encoding, STT, and the level meter. Hard-won rules baked in:
 *  - a NEW MediaRecorder per press; every track stopped on finish/cancel;
 *  - mime probed via isTypeSupported priority list, options omitted when
 *    nothing matches, and the ACTUAL recorder.mimeType is what rides with
 *    the blob to STT;
 *  - Pointer Events with setPointerCapture; pointercancel IS a cancel;
 *  - visibilitychange-hidden and track.onmute cancel and discard;
 *  - <500ms hold = mis-tap, discarded (state machine rule).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    recorderInitial,
    recorderTransition,
    pickRecorderMime,
    type RecorderEvent,
    type RecorderSnapshot,
    type RecorderState,
} from './recorderMachine';

export interface HoldToTalkOptions {
    /** run STT on the finished clip; returns transcript ('' = nothing heard) */
    transcribe: (audioBase64: string, mimeType: string) => Promise<string>;
    /** transcript ready — hand to the send pipeline */
    onText: (text: string) => void;
    /** 0..1 mic level while recording (drives the waveform ring) */
    onLevel?: (level: number) => void;
    /** mic permission / recorder start failed */
    onMicError?: () => void;
    disabled?: boolean;
}

interface ActiveRecording {
    stream: MediaStream;
    recorder: MediaRecorder;
    chunks: Blob[];
    /** what to do when the recorder actually stops */
    outcome: 'pending' | 'transcribe' | 'discard';
    audioCtx: AudioContext | null;
    rafId: number;
    generation: number;
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const url = reader.result as string;
            resolve(url.slice(url.indexOf(',') + 1));
        };
        reader.readAsDataURL(blob);
    });
}

export function useHoldToTalk(options: HoldToTalkOptions) {
    const [state, setState] = useState<RecorderState>('idle');
    const snapRef = useRef<RecorderSnapshot>(recorderInitial);
    const activeRef = useRef<ActiveRecording | null>(null);
    const generationRef = useRef(0);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const teardownMeter = useCallback((active: ActiveRecording) => {
        cancelAnimationFrame(active.rafId);
        if (active.audioCtx) {
            void active.audioCtx.close().catch(() => undefined);
            active.audioCtx = null;
        }
        optionsRef.current.onLevel?.(0);
    }, []);

    const stopTracks = useCallback((active: ActiveRecording) => {
        for (const track of active.stream.getTracks()) {
            try {
                track.stop();
            } catch {
                // already stopped
            }
        }
    }, []);

    const finishRecording = useCallback(
        async (active: ActiveRecording) => {
            teardownMeter(active);
            stopTracks(active);
            if (active.outcome !== 'transcribe') return;
            try {
                // Read back the REAL negotiated mime (may differ from the probe).
                const mime = active.recorder.mimeType || 'audio/webm';
                const blob = new Blob(active.chunks, { type: mime });
                if (blob.size === 0) {
                    dispatch({ type: 'transcribe-failed' });
                    return;
                }
                const b64 = await blobToBase64(blob);
                const text = await optionsRef.current.transcribe(b64, mime);
                dispatch({ type: 'transcribed', text });
            } catch {
                dispatch({ type: 'transcribe-failed' });
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const runEffects = useCallback(
        (effects: ReturnType<typeof recorderTransition>['effects']) => {
            for (const effect of effects) {
                switch (effect.kind) {
                    case 'start-recording': {
                        void startRecording();
                        break;
                    }
                    case 'stop-and-transcribe': {
                        const active = activeRef.current;
                        if (!active) {
                            dispatch({ type: 'transcribe-failed' });
                            break;
                        }
                        active.outcome = 'transcribe';
                        activeRef.current = null;
                        if (active.recorder.state !== 'inactive') {
                            active.recorder.stop(); // onstop → finishRecording
                        } else {
                            void finishRecording(active);
                        }
                        break;
                    }
                    case 'discard-recording': {
                        const active = activeRef.current;
                        if (active) {
                            active.outcome = 'discard';
                            activeRef.current = null;
                            try {
                                if (active.recorder.state !== 'inactive') active.recorder.stop();
                            } catch {
                                // recorder never started
                            }
                            teardownMeter(active);
                            stopTracks(active);
                        }
                        break;
                    }
                    case 'send-text': {
                        optionsRef.current.onText(effect.text);
                        break;
                    }
                }
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const dispatch = useCallback(
        (event: RecorderEvent) => {
            const { next, effects } = recorderTransition(snapRef.current, event);
            snapRef.current = next;
            setState(next.state);
            runEffects(effects);
        },
        [runEffects],
    );

    const startRecording = useCallback(async () => {
        const generation = ++generationRef.current;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            optionsRef.current.onMicError?.();
            dispatch({ type: 'cancel' });
            return;
        }
        // The press may have ended while the permission prompt was up.
        if (generation !== generationRef.current || snapRef.current.state !== 'recording') {
            for (const track of stream.getTracks()) track.stop();
            return;
        }

        const supported =
            typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
                ? (m: string) => MediaRecorder.isTypeSupported(m)
                : () => false;
        const mime = pickRecorderMime(supported);

        let recorder: MediaRecorder;
        try {
            recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch {
            try {
                recorder = new MediaRecorder(stream);
            } catch {
                for (const track of stream.getTracks()) track.stop();
                optionsRef.current.onMicError?.();
                dispatch({ type: 'cancel' });
                return;
            }
        }

        const active: ActiveRecording = {
            stream,
            recorder,
            chunks: [],
            outcome: 'pending',
            audioCtx: null,
            rafId: 0,
            generation,
        };
        activeRef.current = active;

        recorder.ondataavailable = (e: BlobEvent) => {
            if (e.data && e.data.size > 0) active.chunks.push(e.data);
        };
        recorder.onstop = () => {
            void finishRecording(active);
        };

        // a muted track mid-recording (call, Siri, route change) = cancel
        for (const track of stream.getAudioTracks()) {
            track.onmute = () => {
                if (activeRef.current === active) dispatch({ type: 'cancel' });
            };
        }

        try {
            recorder.start();
        } catch {
            activeRef.current = null;
            stopTracks(active);
            optionsRef.current.onMicError?.();
            dispatch({ type: 'cancel' });
            return;
        }

        // level meter (best effort — a suspended context just means no meter)
        if (optionsRef.current.onLevel) {
            try {
                const Ctor: typeof AudioContext | undefined =
                    window.AudioContext ??
                    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
                if (Ctor) {
                    const meterCtx = new Ctor();
                    active.audioCtx = meterCtx;
                    const sourceNode = meterCtx.createMediaStreamSource(stream);
                    const analyser = meterCtx.createAnalyser();
                    analyser.fftSize = 256;
                    sourceNode.connect(analyser);
                    const data = new Uint8Array(analyser.frequencyBinCount);
                    const tick = () => {
                        if (activeRef.current !== active) return;
                        analyser.getByteTimeDomainData(data);
                        let sum = 0;
                        for (let i = 0; i < data.length; i++) {
                            const v = (data[i] - 128) / 128;
                            sum += v * v;
                        }
                        const rms = Math.sqrt(sum / data.length);
                        optionsRef.current.onLevel?.(Math.min(1, rms * 3));
                        active.rafId = requestAnimationFrame(tick);
                    };
                    active.rafId = requestAnimationFrame(tick);
                }
            } catch {
                // no meter — recording still works
            }
        }
    }, [dispatch, finishRecording, stopTracks]);

    // hide tab / lock screen while recording → cancel and discard
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'hidden' && snapRef.current.state === 'recording') {
                dispatch({ type: 'cancel' });
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [dispatch]);

    // unmount cleanup: whatever is live gets discarded
    useEffect(() => {
        return () => {
            const active = activeRef.current;
            if (active) {
                active.outcome = 'discard';
                activeRef.current = null;
                try {
                    if (active.recorder.state !== 'inactive') active.recorder.stop();
                } catch {
                    // ignore
                }
                cancelAnimationFrame(active.rafId);
                if (active.audioCtx) void active.audioCtx.close().catch(() => undefined);
                for (const track of active.stream.getTracks()) track.stop();
            }
        };
    }, []);

    const onPointerDown = useCallback(
        (e: React.PointerEvent<HTMLElement>) => {
            if (optionsRef.current.disabled) return;
            if (typeof e.button === 'number' && e.button !== 0 && e.pointerType === 'mouse') return;
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
                // capture is best-effort
            }
            dispatch({ type: 'press', at: Date.now() });
        },
        [dispatch],
    );

    const onPointerUp = useCallback(() => {
        dispatch({ type: 'release', at: Date.now() });
    }, [dispatch]);

    const onPointerCancel = useCallback(() => {
        dispatch({ type: 'cancel' });
    }, [dispatch]);

    const onContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault(); // long-press context menu would break the hold
    }, []);

    return {
        state,
        handlers: { onPointerDown, onPointerUp, onPointerCancel, onContextMenu },
    };
}
