/**
 * CommandView — a shell command and its captured output, terminal-styled.
 * stdout is capped with max-height + vertical scroll; long lines scroll
 * horizontally; everything is monospace.
 */
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
    const hasOutput = !!(stdout?.trim() || stderr?.trim() || error?.trim());
    return (
        <div className="cmd">
            <div className="cmd-line">
                <span className="cmd-prompt">$</span>
                <span className="cmd-cmd">{command}</span>
            </div>
            {hasOutput && (
                <div className="cmd-out">
                    {stdout?.trim() ? <pre className="cmd-stream">{stdout}</pre> : null}
                    {stderr?.trim() ? <pre className="cmd-stream cmd-stream--err">{stderr}</pre> : null}
                    {error?.trim() ? <pre className="cmd-stream cmd-stream--err">{error}</pre> : null}
                </div>
            )}
        </div>
    );
}
