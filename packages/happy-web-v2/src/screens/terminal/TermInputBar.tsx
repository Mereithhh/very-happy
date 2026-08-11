/**
 * TermInputBar — the mobile terminal's line-input mode ("muxile pattern").
 *
 * Why it exists: xterm's per-key path funnels the soft keyboard through a
 * hidden textarea whose composition assumptions don't hold on mobile — CJK
 * IME, predictive text, and dictation are permanently second-class there (the
 * mobileInputBridge fixes discrete input, but composition-heavy input can't be
 * fully fixed at that layer; xterm upstream has never targeted mobile). Every
 * terminal-adjacent mobile product that handles CJK well (muxile, Happy
 * upstream, Omnara, Claude Remote Control) does it by composing in a PLAIN
 * input outside the terminal and sending whole lines. This is that: a normal
 * <textarea> — composition, prediction, swipe, dictation, paste are all native
 * OS behavior with zero terminal interference — and Enter ships the line to
 * the pty as `text + \r` over the existing sendInput channel.
 *
 * Per-key needs still work: the assistive key bar stays above this bar, and
 * its Esc/Tab/Ctrl/arrow keys send straight to the pty (TUI dialogs, vim,
 * shell history), no mode switch needed. The toggle key returns to full
 * per-key mode.
 *
 * Details that matter on iOS:
 *  - font-size ≥ 16px (see terminal.css) or focusing auto-zooms the page;
 *  - enterKeyHint="send" labels the Return key; Enter sends, Shift+Enter (hw
 *    keyboard) inserts a newline — newlines become CRs on send;
 *  - IME guard: Enter mid-composition confirms the candidate, never sends
 *    (same composingRef + isImeComposingEvent pattern as the chat composer);
 *  - the send button preventDefaults mousedown so tapping it never blurs the
 *    textarea (the keyboard stays up for the next line);
 *  - autocapitalize/autocorrect/spellcheck off: this is a command line, and
 *    "sudo" → "Sudo" style rewriting is destructive. IME composition is
 *    unaffected (it's an input method, not autocorrect).
 *  - empty send is allowed on purpose: it's a bare Enter — confirming a TUI
 *    prompt ("press enter to continue") is a first-class flow.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { isImeComposingEvent } from '@/utils/ime';
import { useTranslation } from '@/i18n/useTranslation';

const MAX_TA_HEIGHT = 120;

export function TermInputBar({
    inputRef,
    onSend,
    onExit,
}: {
    /** Owned by WebTerminalScreen: the focus policy focuses/blurs through it. */
    inputRef: RefObject<HTMLTextAreaElement | null>;
    /** Ship one composed line (no trailing newline) to the pty. */
    onSend: (text: string) => void;
    /** Escape on a hardware keyboard exits back to per-key mode. */
    onExit: () => void;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const composingRef = useRef(false);

    // Auto-grow like the chat composer: single line normally, expands for
    // pasted multi-line commands up to a cap.
    useLayoutEffect(() => {
        const ta = inputRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, MAX_TA_HEIGHT)}px`;
    }, [text, inputRef]);

    const doSend = () => {
        onSend(text);
        setText('');
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            onExit();
            return;
        }
        // IME guard — Enter mid-composition commits the candidate, never sends.
        if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !isImeComposingEvent(e)) {
            e.preventDefault();
            doSend();
        }
    };

    return (
        <div className="term-inputbar">
            <textarea
                ref={inputRef}
                className="term-inputbar-ta"
                value={text}
                rows={1}
                placeholder={t('terminal.inputBarPlaceholder')}
                aria-label={t('terminal.inputBarPlaceholder')}
                enterKeyHint="send"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onCompositionStart={() => (composingRef.current = true)}
                // One tick late: some browsers deliver the composition-
                // committing keydown AFTER compositionend (see chat composer).
                onCompositionEnd={() => setTimeout(() => (composingRef.current = false), 0)}
            />
            <button
                type="button"
                className="term-inputbar-send"
                aria-label={t('terminal.inputBarSend')}
                title={t('terminal.inputBarSend')}
                // Keep the textarea focused (keyboard up) across the tap.
                onMouseDown={(e) => e.preventDefault()}
                onClick={doSend}
            >
                <CornerDownLeft size={18} />
            </button>
        </div>
    );
}
