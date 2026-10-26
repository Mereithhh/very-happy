export class TeamError extends Error {
    /** `details` ride on the HTTP body next to `error`; never put secrets in them. */
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}
export function requireTeam(condition: unknown, code: string, status = 409): asserts condition {
    if (!condition) throw new TeamError(code, status);
}
/**
 * B-822: a full team record is a capacity refusal, not rate limiting. It used to be 429, and every
 * delegate / message / submit / accept of a 5-day team failed with a bare「HTTP 429」that everyone
 * read as throttling. 409 (old CLIs read its code) with what is full and what to do instead.
 */
export const TEAM_CAPACITY_HINT = 'This is a team capacity limit, not rate limiting: retrying the same request will not succeed. Closed tasks, their delivered messages and finished operations are archived automatically; what is left is open work. Accept, cancel or hand off finished tasks, or ask the owner to archive this team and start a new one. 这是团队容量上限，不是限流，重试无效。';
export function requireCapacity(condition: unknown, code: string, used: number, limit: number): asserts condition {
    if (!condition) throw new TeamError(code, 409, { used, limit, hint: TEAM_CAPACITY_HINT });
}
