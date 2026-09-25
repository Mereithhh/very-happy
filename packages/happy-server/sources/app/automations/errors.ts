export class AutomationError extends Error {
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}
export function requireAutomation(condition: unknown, code: string, status = 409, details?: Record<string, unknown>): asserts condition {
    if (!condition) throw new AutomationError(code, status, details);
}
