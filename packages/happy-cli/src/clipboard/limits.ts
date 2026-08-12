/**
 * Shared clipboard-push constants and helpers.
 *
 * The clipboard tool ships arbitrary text from the machine running claude to
 * the browser(s) currently viewing the web client. Both producers (the SDK
 * session's `happy` MCP server and the daemon's /clipboard endpoint) truncate
 * with the same limit so the relay never has to carry unbounded payloads; the
 * web client enforces the same cap defensively after decrypt.
 */

/** Max clipboard text size in UTF-8 bytes (256KB). */
export const CLIPBOARD_MAX_BYTES = 256 * 1024;

/** Identical tool metadata for both MCP surfaces (SDK session + stdio). */
export const CLIPBOARD_TOOL_NAME = 'copy_to_clipboard';
export const CLIPBOARD_TOOL_TITLE = 'Copy to User Clipboard';
export const CLIPBOARD_TOOL_DESCRIPTION =
    'Copy text to the clipboard of the device the user is currently viewing this session from (their web browser, possibly a phone). '
    + 'Use this whenever the user wants a piece of text handed to them — not only when they literally say "clipboard". '
    + 'Trigger phrases include: "copy X", "copy that for me", "give me X", "send me X", "I need X on my phone", '
    + '"复制给我", "把 X 复制一下", "发我", "给我一份", "复制到剪切板/剪贴板". '
    + 'Typical payloads: command output, code snippets, tokens/keys, URLs, file contents, commit messages. '
    + 'The text is delivered to every device where the user has the web client open. '
    + `Payloads larger than ${CLIPBOARD_MAX_BYTES / 1024}KB are truncated.`;

export interface PreparedClipboardText {
    /** The (possibly truncated) text to deliver. */
    text: string;
    /** True when the original exceeded CLIPBOARD_MAX_BYTES and was cut. */
    truncated: boolean;
    /** UTF-8 byte size of the ORIGINAL text. */
    totalBytes: number;
}

/**
 * Enforce the byte cap on a clipboard payload. Truncation happens on a UTF-8
 * character boundary (never splits a multi-byte sequence or a surrogate pair).
 */
export function prepareClipboardText(input: string): PreparedClipboardText {
    const totalBytes = Buffer.byteLength(input, 'utf8');
    if (totalBytes <= CLIPBOARD_MAX_BYTES) {
        return { text: input, truncated: false, totalBytes };
    }
    // Byte-slice then repair the tail: Buffer#toString replaces a split
    // multi-byte sequence with U+FFFD, so cut anything after the last clean
    // character instead of shipping a replacement char.
    const sliced = Buffer.from(input, 'utf8').subarray(0, CLIPBOARD_MAX_BYTES).toString('utf8');
    let text = sliced;
    if (text.endsWith('�')) {
        text = text.slice(0, -1);
    }
    // A byte cut can also land between a surrogate pair's code units after
    // decode repair; drop a trailing lone high surrogate.
    const lastCode = text.charCodeAt(text.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        text = text.slice(0, -1);
    }
    return { text, truncated: true, totalBytes };
}
