/** B-619: an account with no machine of its own can still have sessions
 * (shared with it) or invitations waiting — those must not be hidden behind
 * the connect-a-machine screen, which is where a phone would otherwise land. */
export function shouldShowFirstRun(dataReady: boolean, machineCount: number, reachableCount = 0): boolean {
  return dataReady && machineCount === 0 && reachableCount === 0;
}

/** Mobile normally renders the session list at `/`, so the Outlet-based home
 * guide needs one explicit exception for a genuinely empty connected account.
 * It retires itself as soon as the first chat or terminal exists; no fragile
 * dismiss/completion flag is needed. */
export function shouldShowWorkspaceGuide(
  dataReady: boolean,
  machineCount: number,
  sessionCount: number,
  terminalCount: number,
): boolean {
  return dataReady && machineCount > 0 && sessionCount === 0 && terminalCount === 0;
}
