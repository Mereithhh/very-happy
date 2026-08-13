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
 *
 * B-069 adds a STREAMING path: when `streaming` options are wired and the
 * platform supports it (AudioWorklet + WebSocket), a press goes
 * mic → AudioWorklet PCM tap → realtime Scribe WS, partial transcripts flow
 * through `streaming.onPartial` (live caption), and release commits for the
 * final text — which then rides the SAME `onText` pipeline. ANY streaming
 * failure falls back to the MediaRecorder batch path: at press time on the
 * same press; mid-recording it fails the turn. Either way the failure is
 * remembered for the rest of this mount so later presses go straight to
 * batch (a remount — re-entering the screen — retries). The two paths never
 * run on the same stream simultaneously.
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
import { isAsrStreamSupported, startAsrStream, type AsrStreamSession } from './asrStream';

export interface HoldToTalkStreamingOptions {
    /** mint an stt single-use token; null = unavailable → batch fallback */
    mintToken: () => Promise<string | null>;
    /** live partial transcript while recording; null = clear */
    onPartial: (text: string | null) => void;
    /** ISO-639 recognition hint (null/undefined = auto-detect) */
    languageCode?: string | null;
}

export interface HoldToTalkOptions {
    /** run STT on the finished clip; returns transcript ('' = nothing heard) */
    transcribe: (audioBase64: string, mimeType: string) => Promise<string>;
    /** transcript ready — hand to the send pipeline */
    onText: (text: string) => void;
    /** 0..1 mic level while recording (drives the waveform ring) */
    onLevel?: (level: number) => void;
    /** mic permission / recorder start failed */
    onMicError?: () => void;
    /** B-069: streaming ASR (absent = batch only) */
    streaming?: HoldToTalkStreamingOptions;
    disabled?: boolean;
}

interface ActiveRecording {
    stream: MediaStream;
    recorder: MediaRecorder | null;
    chunks: Blob[];
    /** what to do when the recording actually stops */
    outcome: 'pending' | 'transcribe' | 'discard';
    audioCtx: AudioContext | null;
    rafId: number;
    generation: number;
    /** streaming session once established */
    asr: AsrStreamSession | null;
    /** streaming session being established (token + WS in flight) */
    asrPending: Promise<AsrStreamSession | null> | null;
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
    // streaming failed once this mount → stay on batch until remount
    const asrFailedRef = useRef(false);
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
                const mime = active.recorder?.mimeType || 'audio/webm';
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

    /** Release on the streaming path: commit the WS and use its final text. */
    const finishAsr = useCallback(
        async (active: ActiveRecording) => {
            teardownMeter(active);
            try {
                // the session may still be connecting (short press) — the tap
                // buffered the audio locally, so waiting still yields a commit
                const session = active.asr ?? (active.asrPending ? await active.asrPending : null);
                stopTracks(active);
                optionsRef.current.streaming?.onPartial(null);
                if (active.outcome !== 'transcribe') {
                    session?.cancel();
                    return;
                }
                if (!session) {
                    asrFailedRef.current = true;
                    dispatch({ type: 'transcribe-failed' });
                    return;
                }
                const text = await session.commit();
                if (text === null) {
                    // WS died mid-recording — the audio only lived in the
                    // socket, so this turn is lost; later presses go batch
                    asrFailedRef.current = true;
                    dispatch({ type: 'transcribe-failed' });
                    return;
                }
                dispatch({ type: 'transcribed', text });
            } catch {
                asrFailedRef.current = true;
                stopTracks(active);
                optionsRef.current.streaming?.onPartial(null);
                dispatch({ type: 'transcribe-failed' });
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    );

    const discardActive = useCallback(
        (active: ActiveRecording) => {
            active.outcome = 'discard';
            active.asr?.cancel();
            if (active.asrPending) {
                // session may resolve after the discard — kill it on arrival
                void active.asrPending.then((s) => s?.cancel());
            }
            optionsRef.current.streaming?.onPartial(null);
            try {
                if (active.recorder && active.recorder.state !== 'inactive') active.recorder.stop();
            } catch {
                // recorder never started
            }
            teardownMeter(active);
            stopTracks(active);
        },
        [teardownMeter, stopTracks],
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
                        if (active.asr || active.asrPending) {
                            void finishAsr(active);
                        } else if (active.recorder && active.recorder.state !== 'inactive') {
                            active.recorder.stop(); // onstop → finishRecording
                        } else {
                            void finishRecording(active);
                        }
                        break;
                    }
                    case 'discard-recording': {
                        const active = activeRef.current;
                        if (active) {
                            activeRef.current = null;
                            discardActive(active);
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

    /** Level meter (best effort — a suspended context just means no meter). */
    const setupMeter = useCallback((active: ActiveRecording) => {
        if (!optionsRef.current.onLevel) return;
        try {
            const Ctor: typeof AudioContext | undefined =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return;
            const meterCtx = new Ctor();
            active.audioCtx = meterCtx;
            const sourceNode = meterCtx.createMediaStreamSource(active.stream);
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
        } catch {
            // no meter — recording still works
        }
    }, []);

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

        const active: ActiveRecording = {
            stream,
            recorder: null,
            chunks: [],
            outcome: 'pending',
            audioCtx: null,
            rafId: 0,
            generation,
            asr: null,
            asrPending: null,
        };
        activeRef.current = active;

        // a muted track mid-recording (call, Siri, route change) = cancel
        for (const track of stream.getAudioTracks()) {
            track.onmute = () => {
                if (activeRef.current === active) dispatch({ type: 'cancel' });
            };
        }
        setupMeter(active);

        // ── streaming path first (B-069) ──
        const streaming = optionsRef.current.streaming;
        if (streaming && !asrFailedRef.current && isAsrStreamSupported()) {
            const pending = startAsrStream({
                stream,
                mintToken: streaming.mintToken,
                languageCode: streaming.languageCode,
                onPartial: (text) => {
                    // only surface partials while this press is still the live one
                    if (activeRef.current === active || active.outcome === 'transcribe') {
                        optionsRef.current.streaming?.onPartial(text);
                    }
                },
            });
            active.asrPending = pending;
            const session = await pending;
            if (session) {
                if (active.outcome === 'discard') {
                    session.cancel();
                    return;
                }
                active.asr = session;
                return; // streaming path live; release → finishAsr
            }
            // Streaming unavailable (probe/token/WS). Remember for this mount
            // and, if the press is still going, fall back to MediaRecorder now
            // (first syllables lost once — later presses go straight to batch).
            asrFailedRef.current = true;
            active.asrPending = null;
            if (activeRef.current !== active || snapRef.current.state !== 'recording') return;
        }

        // ── batch path (MediaRecorder) ──
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
                activeRef.current = null;
                teardownMeter(active);
                for (const track of stream.getTracks()) track.stop();
                optionsRef.current.onMicError?.();
                dispatch({ type: 'cancel' });
                return;
            }
        }
        active.recorder = recorder;

        recorder.ondataavailable = (e: BlobEvent) => {
            if (e.data && e.data.size > 0) active.chunks.push(e.data);
        };
        recorder.onstop = () => {
            void finishRecording(active);
        };

        try {
            recorder.start();
        } catch {
            activeRef.current = null;
            teardownMeter(active);
            stopTracks(active);
            optionsRef.current.onMicError?.();
            dispatch({ type: 'cancel' });
            return;
        }
    }, [dispatch, finishRecording, setupMeter, stopTracks, teardownMeter]);

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
                activeRef.current = null;
                discardActive(active);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
