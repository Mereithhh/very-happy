/**
 * CommandView — a shell command and its captured output, terminal-styled.
 * stdout is capped with max-height + vertical scroll; long lines scroll
 * horizontally; everything is monospace. Both the command line and the
 * output area carry a copy overlay (raw text, not the clipped view).
 */
import { useEffect, useState } from 'react';
import { highlightToHtml } from './highlighter';
import { CopyButton } from '@/ui/CopyButton';
import { commandOutputText } from './toolInfo';
import './command.css';

export function CommandView({
    command,
    stdout,
    stderr,
    error,
}: {
    command: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
}) {
    const [highlight, setHighlight] = useState<{ command: string; html: string } | null>(null);
    useEffect(() => {
        let cancelled = false;
        if (command.length <= 100_000) {
            void highlightToHtml(command, 'bash').then((result) => {
                if (!cancelled && result) setHighlight({ command, html: result.html });
            });
        }
        return () => { cancelled = true; };
    }, [command]);
    const hasOutput = !!(stdout?.trim() || stderr?.trim() || error?.trim());
    return (
        <div className="cmd">
            <div className="vh-copyhost">
                <div className="cmd-line">
                    <span className="cmd-prompt">$</span>
                    <div className="cmd-cmd">{highlight?.command === command
                        ? <div className="cmd-highlight" dangerouslySetInnerHTML={{ __html: highlight.html }} />
                        : command}</div>
                </div>
                <CopyButton text={command} className="vh-copy--overlay" />
            </div>
            {hasOutput && (
                <div className="vh-copyhost">
                    <div className="cmd-out">
                        {stdout?.trim() ? <pre className="cmd-stream">{stdout}</pre> : null}
                        {stderr?.trim() ? <pre className="cmd-stream cmd-stream--err">{stderr}</pre> : null}
                        {error?.trim() ? <pre className="cmd-stream cmd-stream--err">{error}</pre> : null}
                    </div>
                    <CopyButton text={() => commandOutputText({ stdout, stderr, error })} className="vh-copy--overlay" />
                </div>
            )}
        </div>
    );
}
