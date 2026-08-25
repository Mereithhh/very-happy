const RUNTIME_CONFIG_ID = 'vh-runtime-config';

export function runtimeConfigScript(config: Record<string, unknown>): string {
    return `<script id="${RUNTIME_CONFIG_ID}">window.__HAPPY_CONFIG__ = ${JSON.stringify(config)};</script>`;
}

/**
 * Inject the runtime config at most once. SPA fallback responses pass through
 * Fastify's onSend hook after the fallback has already read and transformed
 * index.html, so an idempotent helper is required to avoid duplicate scripts.
 */
export function injectRuntimeConfig(html: string, script: string): string {
    if (html.includes(`id="${RUNTIME_CONFIG_ID}"`)) return html;
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${script}`);
}
