function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_\-\s]/g, '');
  return /(token|secret|password|authorization|cookie|credential|apikey|privatekey|encryptionkey|accesskey|claimsecret)/.test(normalized);
}

export function redactLogString(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/** Recursively remove credential-bearing fields before local or remote logging. */
export function redactLogValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactLogString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown; response?: { status?: unknown } };
    return {
      name: error.name,
      message: redactLogString(error.message),
      ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: error.code } : {}),
      ...(typeof (error.status ?? error.response?.status) === 'number'
        ? { status: error.status ?? error.response?.status }
        : {}),
    };
  }

  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1, seen));

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else if (key === 'environmentVariables' && child && typeof child === 'object') {
      result[key] = { names: Object.keys(child).sort() };
    } else {
      result[key] = redactLogValue(child, depth + 1, seen);
    }
  }
  return result;
}

/** Subcommands whose positional/flag values carry issue or todo text (titles, comments, notes). */
const TEXT_SUBCOMMANDS = new Set(['issue', 'issues', 'todo']);
const SAFE_ARG = /^(?:[a-z][a-z-]{0,31}|[A-Z]+-\d{1,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,12})$/;

/**
 * B-874c (QA43 P2-4): the startup debug line logs argv; for `issue` / `todo`
 * that is the user's issue text. Keep the command shape (action words, flag
 * names, VH-N keys, ids, numbers) and drop every other value.
 */
export function redactCliArgv(argv: readonly string[]): string[] {
  const sub = argv[2];
  if (!sub || !TEXT_SUBCOMMANDS.has(sub)) return [...argv];
  return argv.map((arg, i) => {
    if (i < 3) return arg;
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      return eq === -1 ? arg : `${arg.slice(0, eq)}=[redacted]`;
    }
    return SAFE_ARG.test(arg) ? arg : '[redacted]';
  });
}
