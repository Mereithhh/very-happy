export function resolveServerUrl(options: {
  isDev: boolean;
  stored?: string;
  runtime?: string;
  origin?: string;
  fallback: string;
}): string {
  if (options.isDev && options.origin) return options.origin;
  if (options.stored) return options.stored;
  if (options.runtime === 'same-origin' && options.origin) return options.origin;
  return options.runtime || options.fallback;
}
