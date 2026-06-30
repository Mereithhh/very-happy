/**
 * Lazy syntax highlighter — shiki fine-grained core.
 *
 * We deliberately use `shiki/core` + explicit per-language/theme imports + the
 * JavaScript regex engine (`@shikijs/engine-javascript`, no wasm). Importing
 * the full `shiki` entry would register its entire grammar/theme registry
 * (hundreds of chunks); the core API bundles only the languages listed below.
 *
 * Everything is behind a single dynamic import(), so shiki + these grammars
 * land in their own async chunk and never touch the initial bundle. Highlighted
 * HTML is consumed via dangerouslySetInnerHTML by CodeView (shiki escapes
 * content, so this is safe).
 */

export type HighlightResult = { html: string } | null;

/** One highlighted token: text + the per-theme CSS-variable style. */
export type HiToken = { content: string; style: Record<string, string> };
/** Highlighted lines, each an array of tokens. null = highlighting unavailable. */
export type HiLines = HiToken[][] | null;

// Map our short language ids (file extensions / fence langs) to shiki lang ids.
const LANG_ALIASES: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json', json5: 'json',
    md: 'markdown', markdown: 'markdown',
    css: 'css', html: 'html', htm: 'html',
    py: 'python', python: 'python', go: 'go', rs: 'rust', rust: 'rust',
    sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', diff: 'diff',
};

// Grammars we register — each is a separate dynamic import below, so this set
// (and only this set) drives the highlighter chunk size.
const LANG_LOADERS: Record<string, () => Promise<any>> = {
    typescript: () => import('@shikijs/langs/typescript'),
    tsx: () => import('@shikijs/langs/tsx'),
    javascript: () => import('@shikijs/langs/javascript'),
    jsx: () => import('@shikijs/langs/jsx'),
    json: () => import('@shikijs/langs/json'),
    markdown: () => import('@shikijs/langs/markdown'),
    css: () => import('@shikijs/langs/css'),
    html: () => import('@shikijs/langs/html'),
    python: () => import('@shikijs/langs/python'),
    go: () => import('@shikijs/langs/go'),
    rust: () => import('@shikijs/langs/rust'),
    bash: () => import('@shikijs/langs/bash'),
    yaml: () => import('@shikijs/langs/yaml'),
    sql: () => import('@shikijs/langs/sql'),
    diff: () => import('@shikijs/langs/diff'),
};

export function normalizeLang(lang: string | null | undefined): string | null {
    if (!lang) return null;
    const lower = lang.toLowerCase().trim();
    const mapped = LANG_ALIASES[lower] ?? lower;
    return mapped in LANG_LOADERS ? mapped : null;
}

type CoreHighlighter = {
    codeToHtml: (code: string, opts: any) => string;
    codeToTokens: (code: string, opts: any) => { tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>> };
    getLoadedLanguages: () => string[];
    loadLanguage: (lang: any) => Promise<void>;
};

async function ensureLang(hl: CoreHighlighter, normalized: string): Promise<void> {
    if (!hl.getLoadedLanguages().includes(normalized)) {
        const mod = await LANG_LOADERS[normalized]();
        await hl.loadLanguage(mod.default);
    }
}

let corePromise: Promise<CoreHighlighter | null> | null = null;

async function getCore(): Promise<CoreHighlighter | null> {
    if (!corePromise) {
        corePromise = (async () => {
            try {
                const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, darkTheme, lightTheme] =
                    await Promise.all([
                        import('shiki/core'),
                        import('@shikijs/engine-javascript'),
                        import('@shikijs/themes/github-dark-default'),
                        import('@shikijs/themes/github-light-default'),
                    ]);
                const hl = await createHighlighterCore({
                    themes: [darkTheme.default, lightTheme.default],
                    langs: [],
                    engine: createJavaScriptRegexEngine(),
                });
                return hl as unknown as CoreHighlighter;
            } catch {
                return null;
            }
        })();
    }
    return corePromise;
}

/**
 * Highlight `code` in `lang` to a dual-theme HTML string. Returns null if
 * highlighting is unavailable or the language isn't supported — callers fall
 * back to plain text.
 */
export async function highlightToHtml(code: string, lang: string | null): Promise<HighlightResult> {
    const normalized = normalizeLang(lang);
    if (!normalized) return null;
    const hl = await getCore();
    if (!hl) return null;
    try {
        await ensureLang(hl, normalized);
        const html = hl.codeToHtml(code, {
            lang: normalized,
            themes: { light: 'github-light-default', dark: 'github-dark-default' },
            // Emit only CSS variables (--shiki-light / --shiki-dark) per token,
            // with NO default inline `color`. This lets our stylesheet pick the
            // theme via those variables; otherwise an inline `color` would win
            // over any stylesheet rule and the tokens would all render one color.
            defaultColor: false,
        });
        return { html };
    } catch {
        return null;
    }
}

/**
 * Highlight `code` into per-line token arrays (for the diff view, which needs to
 * own its own row layout). Returns null when highlighting is unavailable.
 */
export async function highlightToLines(code: string, lang: string | null): Promise<HiLines> {
    const normalized = normalizeLang(lang);
    if (!normalized) return null;
    const hl = await getCore();
    if (!hl) return null;
    try {
        await ensureLang(hl, normalized);
        const { tokens } = hl.codeToTokens(code, {
            lang: normalized,
            themes: { light: 'github-light-default', dark: 'github-dark-default' },
            defaultColor: false,
        });
        return tokens.map((line) =>
            line.map((tok) => ({ content: tok.content, style: tok.htmlStyle ?? {} })),
        );
    } catch {
        return null;
    }
}
