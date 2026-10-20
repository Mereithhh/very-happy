/** B-647: pure error type for the Projects REST client (importable without the app runtime). */
export class ProjectsApiError extends Error {
  constructor(public status: number, public code: string, public details?: Record<string, unknown>) {
    super(code);
    this.name = 'ProjectsApiError';
  }
  /** Old server (unknown route) or the server-side kill switch. */
  get unavailable(): boolean {
    return this.status === 404 && (this.code === 'projects_disabled' || !this.code.startsWith('project'));
  }
}
