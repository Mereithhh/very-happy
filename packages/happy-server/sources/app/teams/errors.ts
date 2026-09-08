export class TeamError extends Error {
    constructor(public code: string, public status = 409) { super(code); }
}
export function requireTeam(condition: unknown, code: string, status = 409): asserts condition {
    if (!condition) throw new TeamError(code, status);
}
