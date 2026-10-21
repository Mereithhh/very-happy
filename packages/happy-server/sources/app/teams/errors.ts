export class TeamError extends Error {
    /** `details` ride on the HTTP body next to `error`; never put secrets in them. */
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}
export function requireTeam(condition: unknown, code: string, status = 409): asserts condition {
    if (!condition) throw new TeamError(code, status);
}
