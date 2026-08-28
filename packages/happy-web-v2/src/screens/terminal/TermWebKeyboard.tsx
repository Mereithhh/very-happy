import {
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import {
    initialWebKeyboardState,
    pressWebKeyboardKey,
    webKeyboardKeyLabel,
    webKeyboardRows,
    type WebKeyboardKey,
} from './webKeyboardModel';
import {
    createWebKeyboardRepeatController,
    type WebKeyboardRepeatController,
} from './termWebKeyboardRepeat';

export function TermWebKeyboard({ onBytes }: { onBytes: (bytes: string) => void }) {
    const { t } = useTranslation();
    const [state, setState] = useState(initialWebKeyboardState);
    const stateRef = useRef(initialWebKeyboardState);
    const repeatRef = useRef<WebKeyboardRepeatController | null>(null);
    if (repeatRef.current === null) {
        repeatRef.current = createWebKeyboardRepeatController();
    }

    const press = (key: WebKeyboardKey) => {
        // Keep the externally visible byte write OUTSIDE a React state updater:
        // StrictMode may replay updaters in development, and replaying one key
        // into a real terminal would be destructive. The ref also preserves
        // exact order across very fast taps before React paints again.
        const result = pressWebKeyboardKey(stateRef.current, key);
        stateRef.current = result.state;
        setState(result.state);
        if (result.bytes !== null) onBytes(result.bytes);
    };

    const keyAriaLabel = (key: WebKeyboardKey): string => {
        if (key.kind === 'shift') {
            return state.shift === 'locked'
                ? t('terminal.webKeyboardCapsLock')
                : t('terminal.webKeyboardShift');
        }
        if (key.kind === 'layout') {
            return state.layout === 'alpha'
                ? t('terminal.webKeyboardSymbols')
                : t('terminal.webKeyboardLetters');
        }
        if (key.kind === 'backspace') return t('terminal.webKeyboardBackspace');
        if (key.kind === 'space') return t('terminal.webKeyboardSpace');
        if (key.kind === 'enter') return t('terminal.webKeyboardEnter');
        if (key.kind === 'arrow') {
            return {
                up: t('terminal.webKeyboardArrowUp'),
                down: t('terminal.webKeyboardArrowDown'),
                left: t('terminal.webKeyboardArrowLeft'),
                right: t('terminal.webKeyboardArrowRight'),
            }[key.direction];
        }
        return webKeyboardKeyLabel(key, state);
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, key: WebKeyboardKey) => {
        // These are non-editable buttons, not native keyboard inputs. Prevent
        // the pointer-down default so iOS/Android cannot bounce through the
        // previously focused terminal textarea between virtual keystrokes;
        // keyboard/screen-reader activation still reaches the click handler.
        event.preventDefault();
        if (key.kind === 'backspace' && event.isPrimary && event.button === 0) {
            repeatRef.current?.start(() => press(key));
        }
    };

    const stopRepeat = () => repeatRef.current?.stop();

    const handleClick = (event: ReactMouseEvent<HTMLButtonElement>, key: WebKeyboardKey) => {
        // Pointer Backspace was emitted on pointer-down so holding can repeat.
        // A detail=0 click is keyboard or assistive-tech activation and still
        // needs to emit one DEL byte.
        if (key.kind === 'backspace' && event.detail !== 0) return;
        press(key);
    };

    useEffect(() => {
        const stopOnVisibilityLoss = () => {
            if (document.hidden) stopRepeat();
        };
        window.addEventListener('blur', stopRepeat);
        document.addEventListener('visibilitychange', stopOnVisibilityLoss);
        return () => {
            window.removeEventListener('blur', stopRepeat);
            document.removeEventListener('visibilitychange', stopOnVisibilityLoss);
            stopRepeat();
        };
    }, []);

    return (
        <div className="term-webkbd" role="group" aria-label={t('terminal.webKeyboardLabel')}>
            {webKeyboardRows(state.layout).map((row) => (
                <div
                    className="term-webkbd-row"
                    key={row.id}
                    style={{ '--term-webkbd-inset': row.inset ?? 0 } as CSSProperties}
                >
                    {row.inset ? <span className="term-webkbd-gutter" aria-hidden /> : null}
                    {row.keys.map((key) => {
                        const armed = key.kind === 'shift' && state.shift !== 'off';
                        const primary = key.kind === 'enter';
                        const repeatable = key.kind === 'backspace';
                        return (
                            <button
                                key={key.id}
                                type="button"
                                className={
                                    `term-webkbd-key${armed ? ' is-armed' : ''}`
                                    + `${primary ? ' is-primary' : ''}`
                                    + `${key.kind === 'space' ? ' is-space' : ''}`
                                    + `${repeatable ? ' is-repeatable' : ''}`
                                }
                                style={{ '--term-webkbd-units': key.units ?? 1 } as CSSProperties}
                                aria-label={keyAriaLabel(key)}
                                aria-pressed={key.kind === 'shift' ? armed : undefined}
                                onPointerDown={(event) => handlePointerDown(event, key)}
                                onPointerUp={repeatable ? stopRepeat : undefined}
                                onPointerCancel={repeatable ? stopRepeat : undefined}
                                onPointerLeave={repeatable ? stopRepeat : undefined}
                                onLostPointerCapture={repeatable ? stopRepeat : undefined}
                                onContextMenu={repeatable ? (event) => event.preventDefault() : undefined}
                                onClick={(event) => handleClick(event, key)}
                            >
                                {webKeyboardKeyLabel(key, state)}
                            </button>
                        );
                    })}
                    {row.inset ? <span className="term-webkbd-gutter" aria-hidden /> : null}
                </div>
            ))}
        </div>
    );
}
