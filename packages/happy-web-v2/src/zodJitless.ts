/**
 * B-825: Zod's object JIT compiles parsers with `new Function`, which the
 * server's CSP (no 'unsafe-eval') forbids. Zod catches that and falls back to
 * the interpreted parser, but its probe still fires a `securitypolicyviolation`
 * (and a /v1/csp-report POST) on every page load. Turning the JIT off skips
 * the probe; behaviour is what the CSP leaves anyway. Must run before any
 * schema is constructed — main.tsx imports this first.
 */
import { z } from 'zod';

z.config({ jitless: true });
